/**
 * The memory service: one Host-side facade over the vendored memory-x core.
 *
 * Every capability — the model-facing tools, the Web panel, and the `/memory`
 * command — goes through this class, so a write has exactly one implementation
 * and one set of guards. Nothing here is pi-specific: session identity comes from
 * the DSH agent, configuration from the row's `config`, and evidence from the
 * session log instead of memory-x's own episode capture.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryFile,
  canonicalPathOf,
  diffLines,
  diffRows,
  diffStats,
  diffToChangeRows,
  effectiveSummary,
  enumerateNodePaths,
  lintTree,
  serializeMarkdown,
  serializeSubtree,
} from './core/index.js';

/** Upper bound for one injected prompt section, in characters. */
const SECTION_MAX_CHARS = 1600;
/** Upper bound for one `memory_read` result, in characters. */
const READ_MAX_CHARS = 6000;
/** Upper bound for one historical value in `memory_history`. */
const VALUE_MAX_CHARS = 500;
/** Upper bound for one `from`/`to` cell in a change row. */
const CHANGE_TEXT_MAX = 60;

/** Memory write style, borrowed from ASD-STE: one fact a sentence, active voice. */
const WRITE_STYLE =
  '短句、一句一事、主动语态、术语一致、去修饰；保留人名/日期/数字/专有名词；' +
  '原文或摘要重要时用引用块（> …）原样保留；事实行用与对话相同的语言书写。';

/** Anchor protocol injected while anchoring is on. */
const ANCHOR_RULES =
  'Anchor before acting: resolve the task to a memory node path first (unique hit → read then act; ' +
  'ambiguous → search/disambiguate; miss → proceed). Never write to a node you have not read this ' +
  'session; before adding, check whether an existing leaf already holds this fact — supersede, ' +
  "don't parallel-add.";

/** Write tools that tidy mode must deny. */
export const TIDY_WRITE_TOOLS = new Set([
  'memory_upsert',
  'memory_update',
  'memory_write_note',
  'memory_summary',
  'memory_link_evidence',
  'memory_move',
  'memory_delete',
]);

/** Local calendar day as `YYYY-MM-DD`. */
export function today(clock = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}`;
}

/** Append the write date to a leaf unless it already carries one. */
export function withDate(leaf, day = today()) {
  if (/←\s*\d{4}-\d{2}-\d{2}/.test(leaf)) return leaf;
  return `${leaf} ← ${day}`;
}

/**
 * Render a stored timestamp in the Host's local time.
 *
 * The engine stamps rows with SQLite's `datetime('now')`: UTC written as
 * `YYYY-MM-DD HH:MM:SS`, with no zone marker. Shown as-is it reads eight hours
 * behind for a Shanghai reader, so every time a tool or the panel prints goes
 * through here.
 * @param {string} text - the stored timestamp.
 * @returns {string} `YYYY-MM-DD HH:MM` in local time; the input itself when it is
 *   not a timestamp.
 */
export function localTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text ?? ''));
  if (!match) return String(text ?? '');
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(stamp.getTime())) return String(text);
  const pad = (n) => String(n).padStart(2, '0');
  return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
}

/** Coerce a stored tool result into plain text for evidence display. */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * One memory tree shared by every caller, plus per-agent session state.
 *
 * The tree itself is a single `MemoryFile`: the plugin opens it once and every
 * read and write reloads from the database when another process has moved the
 * version, so a pi session and a DSH session on the same directory stay
 * consistent without sharing an in-memory tree.
 */
export class MemoryService {
  /**
   * @param options - resolved plugin configuration.
   * @param options.dataDir - directory holding `.memory/memory.db`.
   * @param options.anchor - `off`, `hint`, or `strict`.
   * @param options.recallMinScore - recall injection gate.
   * @param options.dateOverride - fixed "today" for replay and tests.
   * @param options.logger - diagnostic sink.
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.anchorMode = options.anchor;
    this.recallMinScore = options.recallMinScore;
    this.dateOverride = options.dateOverride;
    /** @type {MemoryFile | null} */
    this.file = null;
    this.opening = null;
    /** @type {Map<string, Map<string, unknown>>} per-agent state */
    this.agents = new Map();
  }

  /** Resolve the configured data directory, defaulting under the user profile. */
  static resolveDataDir(configured) {
    if (configured) return configured;
    // Keep DSH's memory separate from a pi installation's `~/memory-x/memory`:
    // two writers on one SQLite file is the one arrangement the file lock cannot
    // make safe, and neither tool expects the other to move the schema.
    return join(homedir(), '.dsh', 'memory-x', 'memory');
  }

  /** @returns {string} the day a write should be stamped with. */
  get day() {
    return this.dateOverride ?? today();
  }

  /** Open (once) and return the shared tree. */
  async open() {
    if (this.file) return this.file;
    if (!this.opening) {
      this.opening = MemoryFile.open(this.dataDir).then((file) => {
        this.file = file;
        return file;
      });
    }
    return this.opening;
  }

  /**
   * The loaded tree, without waiting for the open to finish. Prompt and recall
   * providers are synchronous by contract, so they read through this and render an
   * empty contribution while the open is still in flight.
   * @returns the tree, or null before it opens.
   */
  peek() {
    return this.file;
  }

  /** Release the database handle. */
  close() {
    this.file?.close?.();
    this.file = null;
    this.opening = null;
  }

  // ---------- per-agent session state ----------

  /**
   * State for one agent: nodes it has read (the anchor write gate) and whether it
   * is in tidy mode. Keyed by session id so two concurrent sessions in one Host
   * never share a write gate — pi kept that state per process, which would let
   * one session's tidy mode deny another session's legitimate writes.
   * @param sessionId - the agent's session identity.
   */
  stateOf(sessionId) {
    const key = sessionId ?? 'anonymous';
    let state = this.agents.get(key);
    if (!state) {
      state = { reads: new Set(), tidy: false, tidyScope: null };
      this.agents.set(key, state);
    }
    return state;
  }

  /** Drop an agent's state when the agent is disposed. */
  forget(sessionId) {
    this.agents.delete(sessionId);
  }

  /** Mark tidy mode for one agent. */
  beginTidy(sessionId, scope) {
    const state = this.stateOf(sessionId);
    state.tidy = true;
    state.tidyScope = scope ?? null;
  }

  /** Leave tidy mode for one agent. */
  endTidy(sessionId) {
    const state = this.stateOf(sessionId);
    state.tidy = false;
    state.tidyScope = null;
  }

  /** Whether this agent's direct writes are denied. */
  isTidying(sessionId) {
    return this.stateOf(sessionId).tidy;
  }

  // ---------- read side ----------

  /** Tree catalog for prompt injection, bounded by `maxChars`. */
  async toc(maxChars = SECTION_MAX_CHARS) {
    const file = await this.open();
    file.reloadIfStale();
    return file.tocDigest({ maxChars });
  }

  /** Read one subtree as markdown, with a summary and rewrite count header. */
  async read(path, sessionId) {
    const file = await this.open();
    const resolved = file.readSection(path);
    if (resolved === null) {
      const tops = file.root.children.map((child) => child.title).join('、') || '（空）';
      return { ok: false, text: `路径不存在：${path}\n当前顶层节点：${tops}` };
    }
    file.recordAccess(path);
    const canonical = canonicalPathOf(file.root, resolved.node);
    if (canonical && this.anchorMode !== 'off') this.stateOf(sessionId).reads.add(canonical);
    const markdown = serializeSubtree(resolved.node);
    const rewrites = file.historyCounts().get(resolved.node.uid ?? '') ?? 0;
    const summary = file.getSummary(path);
    const head =
      (summary ? `> 摘要：${summary}\n` : '') +
      (rewrites > 0 ? `> 历史：${rewrites} 次改写（旧值用 memory_history 查询）\n` : '') +
      '\n';
    if (markdown.length > READ_MAX_CHARS) {
      return {
        ok: true,
        text: `${head}${markdown.slice(0, READ_MAX_CHARS)}\n…（已截断，请用更深的路径分段读取）`,
        historyCount: rewrites,
      };
    }
    return { ok: true, text: head + markdown, historyCount: rewrites };
  }

  /** Search the tree; returns hit rows for the caller to format. */
  async search(query, topK = 5, scope) {
    const file = await this.open();
    return file.search(query, topK, scope);
  }

  /** Value-level history of one node, newest first. */
  async history(path) {
    const file = await this.open();
    const { rows, found, deleted } = file.nodeHistory(path);
    if (!found) {
      const tops = file.root.children.map((child) => child.title).join('、') || '（空）';
      return { ok: false, text: `路径不存在且无历史记录：${path}\n当前顶层节点：${tops}` };
    }
    if (rows.length === 0) return { ok: true, text: `「${path}」无历史（从未改写；历史永久保留）` };
    const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const format = (value) =>
      value.length > VALUE_MAX_CHARS
        ? `${escape(value.slice(0, VALUE_MAX_CHARS))}…（共 ${value.length} 字，已截断）`
        : escape(value);
    const values = rows.filter((row) => row.value != null).length;
    const lines = rows.map((row) => {
      const attrs =
        `rev="#${row.revisionId}" at="${localTime(row.createdAt)}" op="${row.op}"` +
        (row.revDetail ? ` note="${escape(row.revDetail.slice(0, 80))}"` : '');
      return row.value == null ? `<value ${attrs}/>` : `<value ${attrs}>\n${format(row.value)}\n</value>`;
    });
    let body = `<history path="${path}"${deleted ? ' deleted="yes"' : ''} values="${values}">\n${lines.join('\n')}\n</history>`;
    if (body.length > READ_MAX_CHARS) {
      body = body.slice(0, READ_MAX_CHARS);
      const cut = body.lastIndexOf('<value ');
      if (cut > 0) body = body.slice(0, cut);
      body += `\n…（已截断；共 ${rows.length} 条，可用更具体的时间或叶子描述缩小范围）\n</history>`;
    }
    return { ok: true, text: body, historyCount: rows.length };
  }

  /**
   * Recent changes grouped by revision, for model audit and the panel.
   *
   * Without `revision` the engine budgets whole revisions: the newest one comes
   * first, an older one is included only if it fits in what is left, and a
   * revision that does not fit is left out whole rather than cut in the middle.
   * One exception: the newest revision is capped at `max(limit, 12)` rows, so a
   * large batch can still be cut — those rows are reported as `heldBack` instead
   * of vanishing.
   * @param limit - row budget, 1..30.
   * @param revision - when set, every row of that one revision, budget aside.
   */
  async changes(limit = 10, revision = null) {
    const file = await this.open();
    if (revision != null) {
      const rows = file.listChanges({ revisionId: revision });
      return { rows, text: formatChanges(rows), heldBack: 0 };
    }
    const budget = Math.min(Math.max(Math.trunc(limit), 1), 30);
    const rows = file.listChanges({ limit: budget });
    const newest = rows[0]?.revisionId ?? null;
    const shown = rows.filter((row) => row.revisionId === newest).length;
    const heldBack = newest == null ? 0 : file.listChanges({ revisionId: newest }).length - shown;
    const note =
      heldBack > 0
        ? `\n   …（版本 #${newest} 行数较多，这里只列了前 ${shown} 行，还有 ${heldBack} 行；memory_changes 的 revision=${newest} 列出该版本全部）`
        : '';
    return { rows, text: formatChanges(rows) + note, heldBack };
  }

  /**
   * Revision log, newest first. `createdAt` stays as stored (UTC); `at` is the
   * same moment in the Host's local time, ready to print.
   */
  async revisions(limit = 15) {
    const file = await this.open();
    return file.listRevisions(limit).map((revision) => ({ ...revision, at: localTime(revision.createdAt) }));
  }

  /** Colour-coded diff of one revision against its predecessor. */
  async revisionDiff(id) {
    const file = await this.open();
    const before = file.treeAt(id - 1);
    const after = file.treeAt(id);
    if (!after) return { ok: false, id, text: `版本 #${id} 不存在` };
    const diff = diffLines(
      (before ? serializeMarkdown(before) : '# Memory\n').split('\n'),
      serializeMarkdown(after).split('\n'),
    );
    // 结构化行，供面板按 kind 上色；曾经的字符串会让 client 的 lines.map 崩溃。
    return { ok: true, id, ...diffStats(diff), lines: diffRows(diff, 400) };
  }

  /** Structural lint issues for the whole tree. */
  async lint() {
    const file = await this.open();
    return lintTree(file.root);
  }

  /** Scale statistics plus the data directory. */
  async stats() {
    const file = await this.open();
    let nodes = 0;
    let leaves = 0;
    let depth = 0;
    const walk = (node, level) => {
      nodes++;
      leaves += node.leaves.length;
      depth = Math.max(depth, level);
      for (const child of node.children) walk(child, level + 1);
    };
    for (const child of file.root.children) walk(child, 1);
    return {
      nodes,
      leaves,
      depth,
      roots: file.root.children.map((child) => child.title),
      dir: file.dir,
      revision: file.listRevisions(1)[0]?.id ?? 0,
    };
  }

  /** Every node with its materialized path, for the panel tree and pickers. */
  async outline() {
    const file = await this.open();
    file.reloadIfStale();
    const countLeaves = (node) =>
      node.leaves.length + node.children.reduce((sum, child) => sum + countLeaves(child), 0);
    return enumerateNodePaths(file.root).map(({ node, path }) => ({
      path,
      title: node.title,
      summary: effectiveSummary(node, { childTitles: false }),
      leaves: node.leaves,
      content: node.content ?? null,
      hasContent: node.content != null,
      leafCount: node.leaves.length,
      leafTotal: countLeaves(node),
      childCount: node.children.length,
    }));
  }

  // ---------- write side ----------

  /**
   * Write guards (anchor protocol): report an unread target node and probe for a
   * likely duplicate outside the target subtree. A `strict` anchor mode turns the
   * first one into a refusal.
   */
  async guards(sessionId, path, probeQuery) {
    if (this.anchorMode === 'off') return { block: false, hints: [] };
    const file = await this.open();
    const state = this.stateOf(sessionId);
    /** @type {string[]} */
    const hints = [];
    let block = false;
    let canonical = null;
    const resolved = file.readSection(path);
    if (resolved?.node) canonical = canonicalPathOf(file.root, resolved.node);
    if (canonical && !state.reads.has(canonical)) {
      const message = `写入已存在节点但本会话未 memory_read：${canonical}（锚定协议：先读再写）`;
      if (this.anchorMode === 'strict') {
        block = true;
        hints.push(`⛔ ${message}——strict 模式已阻断本次写入，请先 memory_read 该子树再写`);
      } else {
        hints.push(message);
      }
    }
    const query = probeQuery?.trim();
    if (query && query.length >= 3) {
      for (const hit of file.search(query, 3)) {
        if (hit.score < this.recallMinScore) continue;
        if (canonical && (hit.path === canonical || hit.path.startsWith(`${canonical}/`))) continue;
        hints.push(
          `疑似与「${hit.path}」已有内容同主题（${hit.snippet.slice(0, 40)}…）——状态变化应 memory_update 原地替换，勿并列新增；确为新事实可忽略`,
        );
        break;
      }
    }
    return { block, hints };
  }

  /** Structural hints after a write (non-blocking). */
  async structureHints(path) {
    const file = await this.open();
    /** @type {string[]} */
    const hints = [];
    const depth = path.split('/').length;
    if (depth > 4) hints.push(`路径已达 ${depth} 层——深埋的内容通常是新主题信号，考虑提升为兄弟`);
    const resolved = file.readSection(path);
    if (resolved && resolved.node.leaves.length > 20) {
      hints.push(`该节点叶子已达 ${resolved.node.leaves.length} 条——考虑按主题分叉`);
    }
    return hints;
  }

  /** Add or refresh one leaf fact. */
  async upsert(sessionId, path, leaf) {
    const guard = await this.guards(sessionId, path, leaf);
    if (guard.block) return { ok: false, changed: false, text: guard.hints.join('\n') };
    const file = await this.open();
    const result = await file.upsertNode(path, withDate(leaf, this.day));
    const hints = [...guard.hints];
    if (result.changed) hints.push(...(await this.structureHints(result.path)));
    return {
      ok: true,
      changed: result.changed,
      revision: result.revision,
      path: result.path,
      text: result.changed
        ? `已写入 ${result.path}（版本 #${result.revision}）${hints.length ? `\n⚠️ ${hints.join('；')}` : ''}`
        : `已存在，无需写入：${result.path}`,
    };
  }

  /** Replace one leaf fact in place (supersede). */
  async update(sessionId, path, match, leaf) {
    const guard = await this.guards(sessionId, path);
    if (guard.block) return { ok: false, changed: false, text: guard.hints.join('\n') };
    const file = await this.open();
    const result = await file.updateNode(path, match, withDate(leaf, this.day));
    if (!result.ok) {
      return {
        ok: false,
        changed: false,
        text:
          `未替换：在「${path}」内未唯一命中旧原文（或路径不存在）。` +
          '先用 memory_read 查看该节点、复制要替换的叶子原文（末尾「← 日期」尾巴可省略）。',
      };
    }
    return {
      ok: true,
      changed: result.changed,
      revision: result.revision,
      path: result.path,
      text: result.changed ? `已替换 ${result.path}（版本 #${result.revision}）` : `新旧相同，无需替换：${result.path}`,
    };
  }

  /** Write a node's long-form markdown body. */
  async writeNote(path, content) {
    const file = await this.open();
    const result = await file.writeNote(path, content);
    return {
      ok: result.ok,
      changed: result.changed,
      revision: result.revision,
      path: result.path,
      text: !result.ok
        ? `路径不存在：${path}（先用 memory_read 确认路径）`
        : result.changed
          ? `已写入 ${result.path} 的完整信息（版本 #${result.revision}）`
          : `内容无变化：${path}`,
    };
  }

  /** Write or clear a node's navigation summary. */
  async writeSummary(path, text) {
    const file = await this.open();
    if (text === undefined) return { ok: true, text: `${path} 摘要：${file.getSummary(path) || '（无）'}` };
    const result = await file.writeSummary(path, text);
    return {
      ok: result.ok,
      changed: result.changed,
      revision: result.revision,
      path: result.path,
      text: !result.ok
        ? `路径不存在：${path}（先用 memory_read 确认路径）`
        : result.changed
          ? `已写入 ${result.path} 的摘要（版本 #${result.revision}）`
          : `摘要无变化：${path}`,
    };
  }

  /** Move a subtree under another node. */
  async move(from, to) {
    const file = await this.open();
    const result = await file.moveNode(from, to);
    return {
      ok: result.ok,
      revision: result.revision,
      text: result.ok ? `已移动 ${from} → ${to}` : '移动失败（路径不存在或构成环）',
    };
  }

  /** Delete a subtree. */
  async remove(path) {
    const file = await this.open();
    const result = await file.deleteNode(path);
    return {
      ok: result.ok,
      revision: result.revision,
      text: result.ok ? `已删除 ${path}（版本 #${result.revision}，可回滚）` : `删除失败（路径不存在）：${path}`,
    };
  }

  /** Roll back to a revision by writing it forward as a new revision. */
  async rollback(id) {
    const file = await this.open();
    const result = await file.restoreRevision(id);
    return {
      ok: result.ok,
      changed: result.changed,
      revision: result.revision,
      text: !result.ok
        ? `版本 #${id} 不存在（用 /memory log 查询可用版本）`
        : result.changed
          ? `已回滚到 #${id}（新版本 #${result.revision}，历史保留，可再滚回）`
          : `当前已是 #${id} 的状态，无需回滚`,
    };
  }

  /**
   * Apply a tidy plan as one revision. The plan is validated on a clone first, so
   * a failing batch changes nothing; a scoped plan may not touch nodes outside
   * its scope.
   */
  async tidy(sessionId, ops, summary) {
    const state = this.stateOf(sessionId);
    if (!Array.isArray(ops) || ops.length === 0) {
      return { ok: false, text: '整理失败（未改动）：ops 为空' };
    }
    if (ops.length > 300) {
      return { ok: false, text: `整理失败（未改动）：操作过多（${ops.length} > 300）——缩小范围或分批` };
    }
    const scope = state.tidyScope;
    if (scope !== null) {
      const outside = (value) => typeof value === 'string' && !(value === scope || value.startsWith(`${scope}/`));
      const bad = ops.find((op) =>
        ['path', 'from', 'to', 'parent'].some((key) => outside(op?.[key])),
      );
      if (bad) return { ok: false, text: `整理失败（未改动）：操作超出整理范围「${scope}」：${JSON.stringify(bad)}` };
    }
    const file = await this.open();
    const preview = file.previewOps(ops);
    if (!preview.ok) return { ok: false, text: `整理落盘失败（未改动）：${preview.error}` };
    const rows = diffToChangeRows(preview.diff);
    const previous = file.listRevisions(1)[0]?.id;
    const result = await file.applyOps(ops, summary);
    this.endTidy(sessionId);
    const lines = rows
      .slice(0, 40)
      .map((change) => `${change.op} ${change.path}${change.to ? ` → ${change.to}` : change.from ? ` ← ${change.from}` : ''}`);
    const scopeLabel = scope === null ? '整棵树' : `节点「${scope}」`;
    return {
      ok: true,
      revision: result.revision,
      rollbackTo: previous,
      changes: rows.length,
      text:
        `整理已落盘（${scopeLabel}）：版本 #${result.revision}，${ops.length} 个操作 / ${rows.length} 处变化。` +
        `${summary ? `\n整理说明：${summary}` : ''}` +
        `\n\n本版本变更：\n${lines.join('\n')}` +
        `${rows.length > lines.length ? `\n…（另有 ${rows.length - lines.length} 处）` : ''}` +
        `\n\n回滚：/memory rollback ${previous ?? Number(result.revision) - 1}`,
    };
  }

  /** A day's diary: the cached node, the raw material, or a weak date-mark view. */
  async diary(date) {
    const file = await this.open();
    const day = date?.trim() || this.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, kind: 'bad-date', text: `日期格式应为 YYYY-MM-DD：${day}` };
    const path = `日记/${day}`;
    const cached = file.readSection(path);
    if (cached) {
      const body = cached.node.content || cached.node.leaves.join('\n');
      const watermark = body.match(/素材水位[：:]\s*episodes?\s*≤\s*(\d+).*?revisions?\s*≤\s*(\d+)/);
      let stale = '';
      if (watermark) {
        const digest = file.dayDigest(day);
        if (
          digest.watermark.maxEpisodeId > Number(watermark[1]) ||
          digest.watermark.maxRevisionId > Number(watermark[2])
        ) {
          stale =
            `\n\n⚠️ 缓存之后该日又有新事件（现水位 episodes ≤ ${digest.watermark.maxEpisodeId}` +
            ` · revisions ≤ ${digest.watermark.maxRevisionId}），如需最新可要求重建日记。`;
        }
      }
      return { ok: true, kind: 'cached', path, text: `【缓存】${path}\n\n${body}${stale}` };
    }
    const digest = file.dayDigest(day);
    if (digest.empty) {
      const weak = file.leavesByDateMark(day);
      if (weak.length === 0) {
        return { ok: true, kind: 'empty', text: `${day} 无记录（当天无事件、无写操作、无日期标记的叶子）。` };
      }
      return {
        ok: true,
        kind: 'weak',
        text: [
          `【弱视图·素材未采集】${day}：仅有叶子文本里带「← ${day}」标记的条目 ${weak.length} 条：`,
          '',
          ...weak.map((item) => `  · [${item.path}] ${item.leaf.slice(0, 100)}`),
          '',
          `→ 可据此写日记到 ${path}（无 session 维度，仅事实清单）。`,
        ].join('\n'),
      };
    }
    const lines = [
      `【素材·未缓存】${day}`,
      '',
      ...digest.sessions.map((session, index) => {
        const id = session.sessionId ? session.sessionId.slice(0, 8) : '（无会话号）';
        const samples = session.userSamples.map((text) => `\n    · ${text}`).join('');
        return (
          `Session ${index + 1}（${id}…）：${session.events} 事件 · ${session.tools} 工具调用 · ` +
          `${session.replies} 条回复\n    开场：${session.firstUser ?? '（无用户发言）'}${samples}`
        );
      }),
      '',
      '动过的节点（写入次数）：',
      ...digest.nodes.map((node) => `  · ${node.path}（${node.ops}）`),
      '',
      `→ 请把当天活动总结成日记，用 memory_write_note 写入 ${path}：`,
      '   正文用 Markdown：每个 session 一句话主题 + 涉及的项目/节点路径（保持原路径以便交叉验证）；',
      `   末尾必须附一行「> 素材水位：episodes ≤ ${digest.watermark.maxEpisodeId} · revisions ≤ ${digest.watermark.maxRevisionId}」。`,
    ];
    return { ok: true, kind: 'material', path, text: lines.join('\n') };
  }

  /**
   * Recall lines for one user turn, gated by the configured score.
   * Synchronous on purpose: prompt providers cannot await, and the tree is already
   * in memory, so the search runs against the loaded snapshot.
   * @param prompt - this turn's user text.
   * @param file - the already-opened tree.
   * @param limit - maximum hits.
   * @returns the recall text, or null when nothing clears the gate.
   */
  recall(prompt, file = this.file, limit = 3) {
    if (typeof prompt !== 'string' || prompt.length < 2 || !file) return null;
    const hits = file.search(prompt, limit).filter((hit) => hit.score >= this.recallMinScore);
    if (hits.length === 0) return null;
    const lines = hits.map((hit) => `- ${[...hit.ancestors, hit.title].join(' › ')}：${hit.snippet.slice(0, 60)}`);
    return ['相关记忆（自动召回，需全文用 memory_read）：', ...lines].join('\n');
  }

  // ---------- evidence: the session log is the record ----------

  /**
   * Point a leaf at the session events it came from. memory-x kept its own
   * episode table because pi exposed nothing durable; DSH's session log already
   * is the durable record, so evidence records the sequence numbers instead of
   * copying the text a second time.
   */
  async linkEvidence(path, leaf, eventIds) {
    const file = await this.open();
    const resolved = file.readSection(path);
    if (!resolved) return { ok: false, text: `路径不存在：${path}` };
    if (!resolved.node.leaves.includes(leaf)) return { ok: false, text: `该节点内不存在这条叶子，未链接：${leaf}` };
    file.linkEvidence(path, leaf, eventIds);
    return { ok: true, text: `已把「${leaf}」链接到 ${eventIds.length} 条来源事件（${eventIds.join(', ')}）` };
  }

  /** Read the evidence attached to a node or one of its leaves. */
  async evidence(path, leaf) {
    const file = await this.open();
    const refs = file.evidenceFor(path, leaf);
    if (refs.length === 0) return { ok: true, ids: [], text: `「${path}」暂无可追溯来源。` };
    const ids = [...new Set(refs.map((ref) => ref.episodeId))];
    const episodes = file.getEpisodes(ids);
    const byId = new Map(episodes.map((episode) => [episode.id, episode]));
    const lines = ids.map((id) => {
      const episode = byId.get(id);
      return episode
        ? `#${episode.id} [${episode.role}/${episode.kind}] ${episode.text.slice(0, 300)}`
        : `#${id}（事件已裁剪）`;
    });
    return { ok: true, ids, text: `来源事件（${ids.length} 条）：\n${lines.join('\n')}` };
  }

  /** Render one tree node for the prompt catalog: children only, no bodies. */
  async catalog() {
    return this.toc(SECTION_MAX_CHARS);
  }
}

/** Render revision-grouped change rows in the model-facing audit shape. */
export function formatChanges(rows) {
  const truncate = (value) => (value.length > CHANGE_TEXT_MAX ? `${value.slice(0, CHANGE_TEXT_MAX)}…` : value);
  /** @type {string[]} */
  const out = [];
  let current = -1;
  for (const change of rows) {
    if (change.revisionId !== current) {
      current = change.revisionId;
      const note = change.revDetail ? ` · ${change.revDetail}` : '';
      out.push(`${out.length ? '\n' : ''}#${change.revisionId} ${localTime(change.createdAt)} ${change.revOp}${note}`);
    }
    const value =
      change.fromText != null && change.toText != null
        ? `：${truncate(change.fromText)} → ${truncate(change.toText)}`
        : change.toText != null
          ? `：${truncate(change.toText)}`
          : change.fromText != null
            ? `：${truncate(change.fromText)}`
            : '';
    out.push(`   - ${change.op} ${change.path}${value}`);
  }
  return out.join('\n');
}

