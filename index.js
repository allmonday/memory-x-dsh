/**
 * Memory tree, Host half.
 *
 * One shared memory tree (memory-x's `@memory-x/core`, MIT) exposed three ways
 * from one service: fourteen model-facing `memory_*` tools, a prompt catalog plus
 * a `/memory` command, and the operations the Web panel calls. The Client half in
 * `client.js` renders that panel.
 */

import { dirname } from 'node:path';
import { MemoryService } from './service.js';
import { memoryTools } from './tools.js';

/**
 * The tool factory comes from the running installation, so this plugin resolves
 * `@deepseek-ai/dsh-tools` through the Host that loaded it rather than through a
 * hard-coded path of its own. The tools package is resolved from the tools
 * service's own module if it exports `defineTool` there, and otherwise from the
 * installation the Host was started from.
 * @param ctx - the context whose `tools` service is mounted.
 * @returns the `defineTool` export of the mounted tools package.
 */
async function loadDefineTool(ctx) {
  if (typeof ctx.tools?.defineTool === 'function') return ctx.tools.defineTool.bind(ctx.tools);
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
  } catch {
    // Fall through to the installation anchor below.
  }
  // `DSH_INSTALL_DIR` names the install dir only for spawned shells (dsh-shell-env
  // sets it per child process), so inside the Host fall back to the Host's own
  // `process.argv`: the desktop-host entry file and the install dir are both there.
  const candidates = [process.env.DSH_INSTALL_DIR, ...installDirCandidates()];
  for (const anchor of candidates) {
    if (!anchor) continue;
    try {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(`${anchor}/package.json`);
      const mod = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
      if (typeof mod.defineTool === 'function') return mod.defineTool;
    } catch {
      // Try the next anchor.
    }
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools: no install anchor found');
}

/**
 * Directories that may hold the installation's `node_modules`, taken from this
 * process's own arguments.
 * @returns absolute paths, each usable as a `createRequire` anchor.
 */
function installDirCandidates() {
  const out = [];
  for (const arg of process.argv.slice(1)) {
    if (typeof arg !== 'string' || !/^[A-Za-z]:[\\/]|^\//.test(arg)) continue;
    out.push(dirname(arg), arg);
  }
  return out;
}

/** Last user text seen on the inbox, read by the recall provider. */
let lastPrompt = null;

/** Written style: one fact a sentence, active voice, consistent terms. */
const WRITE_STYLE =
  '短句、一句一事、主动语态、术语一致、去修饰；保留人名/日期/数字/专有名词；' +
  '原文或摘要重要时用引用块（> …）原样保留；事实行用与对话相同的语言书写。';

/** Anchor protocol text, injected only while anchoring is enabled. */
const ANCHOR_RULES =
  'Anchor before acting: resolve the task to a memory node path first (unique hit → read then act; ' +
  'ambiguous → search/disambiguate; miss → proceed). Never write to a node you have not read this ' +
  "session; before adding, check whether an existing leaf already holds this fact — supersede, don't parallel-add.";

/** Write tools that tidy mode denies. */
const TIDY_WRITE_TOOLS = new Set([
  'memory_upsert',
  'memory_update',
  'memory_write_note',
  'memory_summary',
  'memory_link_evidence',
  'memory_move',
  'memory_delete',
]);

/**
 * Config for one installation, as a Standard Schema.
 *
 * Cordis validates a row's `config` through `Config['~standard'].validate`, so
 * this is a callable schema object rather than the Harness builder: the plugin is
 * installed by link, and a linked package resolves its imports from the bundle
 * directory, where the Harness packages are not present. Defaults and bound
 * checks live here; `apply` receives the normalized value.
 */
export const Config = createConfigSchema({
  dataDir: {
    type: 'string',
    default: '',
    description:
      'Directory holding the memory database (`.memory/memory.db`). Empty means `~/.dsh/memory-x/memory`, kept separate from a pi installation’s own tree.',
  },
  anchor: {
    type: 'enum',
    values: ['off', 'hint', 'strict'],
    default: 'hint',
    description:
      'Anchor protocol strength: `off` adds no protocol and no guards, `hint` warns before a risky write, `strict` refuses a write to a node this session has not read.',
  },
  recallMinScore: {
    type: 'number',
    default: 1.0,
    min: 0,
    description:
      'Minimum search score for a memory to be recalled into the prompt each turn; higher numbers inject less noise.',
  },
  catalogMaxChars: {
    type: 'number',
    default: 1600,
    min: 200,
    description: 'Character budget for the memory catalog section of the system prompt.',
  },
});

/**
 * Build a callable Standard Schema for a flat config object.
 * @param shape - one descriptor per field.
 * @returns a function that normalizes config, carrying `~standard`.
 */
function createConfigSchema(shape) {
  const normalize = (input) => {
    const issues = [];
    const value = {};
    const source = input && typeof input === 'object' ? input : {};
    for (const [key, field] of Object.entries(shape)) {
      const raw = source[key];
      if (raw === undefined) {
        value[key] = field.default;
        continue;
      }
      if (field.type === 'string') {
        if (typeof raw !== 'string') {
          issues.push({ path: [key], message: `${key} must be a string` });
          continue;
        }
        value[key] = raw;
        continue;
      }
      if (field.type === 'enum') {
        if (!field.values.includes(raw)) {
          issues.push({ path: [key], message: `${key} must be one of ${field.values.join(', ')}` });
          continue;
        }
        value[key] = raw;
        continue;
      }
      const number = Number(raw);
      if (!Number.isFinite(number) || (field.min !== undefined && number < field.min)) {
        issues.push({ path: [key], message: `${key} must be a number${field.min !== undefined ? ` >= ${field.min}` : ''}` });
        continue;
      }
      value[key] = number;
    }
    return issues.length > 0 ? { issues } : { value };
  };
  const schema = (input) => {
    const result = normalize(input);
    return 'value' in result ? result.value : { ...shape };
  };
  schema['~standard'] = {
    version: 1,
    vendor: 'memory-x-dsh',
    validate: normalize,
  };
  return schema;
}

/**
 * Activate the memory tree.
 * @param ctx - the Host context owned by this row.
 * @param config - validated row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config ?? {});
  const logger = ctx.logger?.('memory-x-dsh') ?? console;

  const service = new MemoryService({
    dataDir: settings.dataDir,
    anchor: settings.anchor,
    recallMinScore: settings.recallMinScore,
    dateOverride: process.env.MEMORY_X_DATE || undefined,
  });

  // One entry point for the panel, the command, and the tools, so all three
  // cannot drift apart. The panel reaches it through `memory-x-dsh/service`.
  const ready = service.open().catch((error) => {
    logger.error('cannot open the memory tree: %s', error?.message ?? error);
    throw error;
  });
  ctx.effect(() => () => service.close(), 'memory-x-dsh: close the tree');

  // ---- tools ----
  ctx.inject?.(['tools'], (scoped) => {
    scoped.effect(() => {
      /** @type {Array<() => void>} */
      const disposers = [];
      let cancelled = false;
      loadDefineTool(scoped)
        .then((defineTool) => {
          if (cancelled) return;
          for (const tool of memoryTools(service, defineTool)) {
            disposers.push(scoped.tools.register(tool));
          }
        })
        .catch((error) => logger.error('cannot register memory tools: %s', error?.message ?? error));
      return () => {
        cancelled = true;
        for (const dispose of disposers) dispose();
      };
    }, 'memory-x-dsh: tools');
  });

  // ---- tidy mode: deny direct writes while a tidy plan is in flight ----
  // A guard is synchronous and cannot be reversed by a later listener, which is
  // what makes tidy mode a real constraint rather than a suggestion.
  ctx.inject?.(['tools'], (scoped) => {
    scoped.effect(
      () =>
        scoped.tools.guard((call) => {
          const toolName = call?.name ?? call?.toolName;
          if (!TIDY_WRITE_TOOLS.has(toolName)) return undefined;
          const sessionId = call?.agent?.sessionId ?? null;
          if (!service.isTidying(sessionId)) return undefined;
          return '整理模式进行中：直接写入已禁用。请用 memory_propose 提交整理操作（会直接落盘为一个可回滚的版本）';
        }),
      'memory-x-dsh: tidy write guard',
    );
  });

  // ---- prompt: the memory catalog ----
  // A prompt section cannot await, so the catalog is read synchronously from the
  // in-memory tree and refreshed from the database when another writer moved the
  // revision. Every path below this one uses the same tree.
  ctx.inject?.(['systemPrompt'], (scoped) => {
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: 'memory-x:catalog',
          order: 40,
          text: () => {
            const file = service.peek();
            if (!file) return '长期记忆树正在打开，本轮暂无目录。';
            const catalog = file.tocDigest({ maxChars: settings.catalogMaxChars });
            return [
              '长期记忆树目录（[n]=子树叶子总数，与本会话同机存储）：',
              catalog,
              '规则：需背景先 memory_read 下钻；不确定位置先 memory_search；查节点历史值用 memory_history；' +
                '看最近全局变更用 memory_changes；出现跨会话价值的结论/决策/实体/待办时用 memory_upsert 主动记' +
                '（一条一事，日期自动附加）；若本轮使某条已有记忆过时，用 memory_update(path, match, leaf) 原地替换，' +
                '不要新增重复条；长正文用 memory_write_note 写成 Markdown；结构性整理走 /memory tidy。勿猜路径。' +
                (settings.anchor === 'off' ? '' : ' ' + ANCHOR_RULES),
              `写入规范：${WRITE_STYLE}`,
            ].join('\n');
          },
        }),
      'memory-x-dsh: catalog section',
    );
  });

  // ---- prompt: per-turn recall ----
  // Recall follows this turn's user text, so it is a dynamic context rather than
  // a section, and an unreadable index never blocks a turn.
  ctx.inject?.(['systemPrompt'], (scoped) => {
    scoped.effect(
      () =>
        scoped.systemPrompt.context({
          name: 'memory-x:recall',
          order: 41,
          text: () => {
            const file = service.peek();
            if (!file) return '';
            return service.recall(lastPrompt, file) ?? '';
          },
        }),
      'memory-x-dsh: recall context',
    );
  });

  // ---- per-agent lifecycle and the latest user text ----
  // A prompt provider receives no messages, so the recall provider reads the last
  // user text seen on the inbox. That keeps assembly synchronous and lets the
  // recalled context carry the same shape pi injected.
  ctx.on('agent/inbox/inserted', (payload) => {
    const text = textOf(payload?.message);
    if (text) lastPrompt = text;
  });

  ctx.on('agent/disposed', (payload) => {
    service.forget(payload?.agent?.sessionId ?? null);
  });

  // ---- /memory command: the same operations the panel offers ----
  ctx.inject?.(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: 'memory',
          description:
            '记忆树：/memory 目录 · stats 规模 · log 版本历史 · changes [n|#id] 变更 · rollback <id> 回滚 · lint 体检 · diary <日期>',
          input: { hint: '[stats|log|changes [n|#id]|rollback <id>|lint|diary <日期>]' },
          async handler({ rawInput }) {
            try {
              return { kind: 'success', text: await runMemoryCommand(service, settings, rawInput) };
            } catch (error) {
              return { kind: 'error', text: `记忆树操作失败：${error?.message ?? error}` };
            }
          },
        }),
      'memory-x-dsh: /memory command',
    );
  });

  // ---- the panel's read-only JSON surface ----
  // One named route on the page's own origin, so the panel needs no second port
  // and no CORS. It answers reads only: every mutation goes through the tools or
  // the /memory command, which share this service.
  ctx.inject?.(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: '/api/memory-x',
          resource: (request) => memoryResource(service, request),
        }),
      'memory-x-dsh: panel API',
    );
  });
}

/**
 * Answer one panel read.
 * @param service - the shared memory service.
 * @param request - the incoming GET request; its path selects the view.
 */
async function memoryResource(service, request) {
  const url = new URL(request.url, 'http://memory-x.invalid');
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  try {
    switch (url.pathname) {
      case '/api/memory-x/snapshot': {
        const [outline, stats, revisions, lint] = await Promise.all([
          service.outline(),
          service.stats(),
          service.revisions(50),
          service.lint(),
        ]);
        return json({ outline, stats, revisions, lint });
      }
      case '/api/memory-x/search':
        return json({ hits: await service.search(url.searchParams.get('q') ?? '', 10) });
      case '/api/memory-x/diff':
        return json(await service.revisionDiff(Number(url.searchParams.get('id'))));
      case '/api/memory-x/ping':
        return json({ ok: true });
      default:
        return json({ error: 'not found' }, 404);
    }
  } catch (error) {
    return json({ error: error?.message ?? String(error) }, 500);
  }
}

/** Normalize row config into concrete settings. */
function resolveSettings(config) {
  const anchor = config.anchor === 'off' || config.anchor === 'strict' ? config.anchor : 'hint';
  const recall = Number(config.recallMinScore);
  const catalog = Number(config.catalogMaxChars);
  return {
    dataDir: MemoryService.resolveDataDir(
      typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir.trim() : undefined,
    ),
    anchor,
    recallMinScore: Number.isFinite(recall) ? recall : 1.0,
    catalogMaxChars: Number.isFinite(catalog) && catalog >= 200 ? Math.trunc(catalog) : 1600,
  };
}

/** Text parts of one message as a single string. */
function textOf(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Run one `/memory` invocation and return its text. */
async function runMemoryCommand(service, settings, rawArgs) {
  const tokens = String(rawArgs ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const sub = tokens[0] ?? '';

  if (sub === 'stats') {
    const stats = await service.stats();
    return `节点 ${stats.nodes} / 叶子 ${stats.leaves} / 深度 ${stats.depth} · 版本 #${stats.revision}\n位置：${stats.dir}`;
  }

  if (sub === 'log') {
    const limit = Number(tokens[1]) > 0 ? Number(tokens[1]) : 15;
    const revisions = await service.revisions(limit);
    if (revisions.length === 0) return '暂无版本历史。';
    const lines = revisions.map(
      (revision) =>
        `#${revision.id} [${revision.at}] ${revision.op}` +
        `${revision.path ? ` ${revision.path}` : ''}${revision.detail ? ` · ${revision.detail}` : ''}`,
    );
    return `版本历史（最近 ${revisions.length} 条，回滚：/memory rollback <id>）：\n${lines.join('\n')}`;
  }

  if (sub === 'changes') {
    // `/memory changes #12` lists one revision whole; `/memory changes 30` sets the row budget.
    if (/^#\d+$/.test(tokens[1] ?? '')) {
      const { rows, text } = await service.changes(10, Number(tokens[1].slice(1)));
      if (rows.length === 0) return `版本 ${tokens[1]} 不存在，或该版本没有变更行（用 /memory log 查版本号）。`;
      return `版本 ${tokens[1]} 的变更（${rows.length} 行）：\n${text}`;
    }
    const limit = Number(tokens[1]) > 0 ? Number(tokens[1]) : 30;
    const { rows, text } = await service.changes(limit);
    if (rows.length === 0) return '暂无变更审计记录。';
    return `最近变更（${rows.length} 条，按版本）：\n${text}\n\n回滚某版本：/memory rollback <#id>\n查看某版本全部变更行：/memory changes <#id>`;
  }

  if (sub === 'rollback') {
    const id = Number(tokens[1]);
    if (!Number.isInteger(id) || id <= 0) return '用法：/memory rollback <版本id>（用 /memory log 查询）';
    return (await service.rollback(id)).text;
  }

  if (sub === 'lint') {
    const issues = await service.lint();
    if (issues.length === 0) return '结构健康 ✓（深度/广度/叶子/重名/时间性命名均达标）';
    const warnings = issues.filter((issue) => issue.level === 'warn');
    return (
      `结构体检：${warnings.length} 项警告，${issues.length - warnings.length} 项建议\n\n` +
      issues
        .map((issue) => `[${issue.level === 'warn' ? '⚠' : 'ℹ'}] ${issue.rule} @ ${issue.path || '(根)'}\n    ${issue.message}`)
        .join('\n')
    );
  }

  if (sub === 'diary') return (await service.diary(tokens[1])).text;

  if (sub === 'tidy') {
    return (
      '整理需要模型参与：请在对话里说「整理记忆树」或「整理记忆树的 <节点>」，' +
      '模型会用 memory_propose 提交结构化操作并落盘为一个可回滚的版本。'
    );
  }

  if (sub === 'help' || sub === '') {
    const stats = await service.stats();
    const catalog = await service.toc(settings.catalogMaxChars);
    return [
      `记忆树（${stats.dir} · 节点 ${stats.nodes} / 叶子 ${stats.leaves} / 版本 #${stats.revision}）：`,
      catalog,
      '',
      '子命令：stats | log | changes [n|#id] | rollback <id> | lint | diary <YYYY-MM-DD> | tidy',
      '可视化面板：左侧边栏「记忆树」',
    ].join('\n');
  }

  return `未知子命令：${sub}\n子命令：stats | log | changes [n|#id] | rollback <id> | lint | diary <日期> | tidy`;
}
