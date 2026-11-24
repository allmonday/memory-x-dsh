import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tocDigest, type TocOptions } from "./digest.js";
import { withDirLock } from "./lock.js";
import { applyOps as runBatchOps, type TreeOp } from "./ops-batch.js";
import { deleteNode, moveNode, stripDateMark, upsertNode } from "./ops.js";
import { parseMarkdown } from "./parser.js";
import { canonicalPathOf, resolvePath } from "./path.js";
import { effectiveSummary, summaryHash } from "./summary.js";
import { serializeSubtree } from "./serializer.js";
import { MemoryStore, ensureUids, leafHash, type Episode, type EvidenceRef, type ChangeRow, type HistoryRow } from "./store.js";
import { diffTrees, type TreeDiff } from "./tree-diff.js";
import type { MemoryNode, OpResult, Resolved } from "./types.js";

export const MEMORY_FILE = "MEMORY.md";
const EMPTY_DOC = "# Memory\n";

/**
 * 记忆文件对象（B 案存储 + 版本历史）：
 *
 *   真相源   .memory/memory.db（nodes 表）
 *   版本历史  revisions（时间线元数据）+ changes（逐节点 undo log，存变更前状态）；
 *            任意版本 = 当前态逆推 undo 行物化；回滚 = 落为新版本（历史不改写，可前后滚）
 *   崩溃安全  SQLite WAL 事务（无镜像文件、无 git）
 *
 * 工作模型：open 时整树载入内存，操作改内存树，persist 只把节点级差异写回 +
 * 记 undo 行 + 重建检索索引。节点身份由稳定 uid 承载（不随路径变化）。
 * 旧版 Markdown 数据在 db 为空时自动导入（一次性）。
 */
export class MemoryFile {
  readonly dir: string;
  root: MemoryNode;
  private readonly store: MemoryStore;
  /** 内存树对应的 DB 版本号；用于检测其它进程/session 的写入 */
  private loadedRevision = 0;
  /** 最近一次与 DB 对齐的树基线；persist 时用它算增量 diff */
  private base: MemoryNode = { title: "Memory", leaves: [], children: [] };

  private constructor(dir: string, root: MemoryNode, store: MemoryStore) {
    this.dir = dir;
    this.root = root;
    this.store = store;
  }

  static async open(dir: string): Promise<MemoryFile> {
    await mkdir(dir, { recursive: true });
    const store = MemoryStore.open(dir);
    let root: MemoryNode;
    if (store.isEmpty()) {
      // 迁移：db 为空但存在旧版 MEMORY.md（镜像时代的遗留）→ 导入并记为首个版本
      let md = EMPTY_DOC;
      try {
        md = await readFile(join(dir, MEMORY_FILE), "utf8");
      } catch {
        // 全新目录
      }
      root = parseMarkdown(md);
      ensureUids(root);
      if (root.children.length > 0 || root.leaves.length > 0) {
        store.saveTree(root);
        store.rebuildFts();
        store.recordRevision("import", null);
      }
    } else {
      root = store.loadTree();
      ensureUids(root);
      if (store.ftsIsEmpty()) store.rebuildFts();
      // 版本历史上线前的存量数据 → 记基线版本
      if (store.revisionCount() === 0) {
        store.recordRevision("baseline", null);
      }
    }
    const mf = new MemoryFile(dir, root, store);
    mf.loadedRevision = store.listRevisions(1)[0]?.id ?? 0;
    mf.base = structuredClone(root);
    return mf;
  }

  /** 同步从 DB 重载内存树与基线（含版本号）。 */
  private syncFromStore(): void {
    this.root = this.store.loadTree();
    ensureUids(this.root);
    this.base = structuredClone(this.root);
    this.loadedRevision = this.store.listRevisions(1)[0]?.id ?? 0;
  }

  /**
   * 若磁盘上已有更新的版本（别的进程/session 写入），重新载入内存树。
   * 返回是否发生重载。读入口与 UI 服务端在应答前调用，避免读到陈旧缓存。
   */
  reloadIfStale(): boolean {
    const latest = this.store.listRevisions(1)[0]?.id ?? 0;
    if (latest === this.loadedRevision) return false;
    this.root = this.store.loadTree();
    ensureUids(this.root);
    this.base = structuredClone(this.root);
    this.loadedRevision = latest;
    return true;
  }

  get dbPath(): string {
    return join(this.dir, ".memory", "memory.db");
  }

  readSection(path: string): Resolved | null {
    this.reloadIfStale();
    return resolvePath(this.root, path, { fuzzy: true });
  }

  /** 子树的 markdown 片段（无根标题）。 */
  renderSection(path: string): string | null {
    const r = this.readSection(path);
    return r ? serializeSubtree(r.node) : null;
  }

  /** 各节点改写次数（uid → 次数；不含创建）。供 read 标注「有历史」。 */
  historyCounts(): Map<string, number> {
    return this.store.rewriteCounts();
  }

  tocDigest(opts?: TocOptions): string {
    this.reloadIfStale();
    return tocDigest(this.root, opts);
  }

  /**
   * 检索：FTS ∪ LIKE 兜底，命中带完整链路/祖先/兄弟。
   * scope 可选：限定在某个节点及其子树内检索。先模糊解析该路径，
   * 取规范物化路径（含 [n] 消歧）后交给 store；指向根＝全树；解析不到时返回空。
   */
  search(query: string, topK?: number, scope?: string) {
    this.reloadIfStale();
    let canonical: string | undefined;
    if (scope && scope.trim() !== "") {
      const r = resolvePath(this.root, scope, { fuzzy: true });
      if (!r) return [];
      if (r.node === this.root) {
        canonical = undefined; // 根 = 全树
      } else {
        const p = canonicalPathOf(this.root, r.node);
        if (p == null) return [];
        canonical = p;
      }
    }
    const hits = this.store.search(query, topK, canonical);
    if (hits.length > 0) {
      // 附上有效摘要（显式且未陈旧 → 用它；否则推导），供展示
      for (const h of hits) {
        const r = resolvePath(this.root, h.path);
        h.summary = r ? effectiveSummary(r.node) : "";
      }
      this.store.recordAccess(hits.map((h) => h.path));
    }
    return hits;
  }

  /** 记录访问信号（工具 read 命中时调用，P5 排序燃料）。 */
  recordAccess(path: string): void {
    this.store.recordAccess([path]);
  }

  /** 节点完整信息（content）。 */
  readNote(path: string): string | null {
    return this.readSection(path)?.node.content ?? null;
  }

  /** 节点有效摘要（显式且未陈旧 → 用它；否则确定性推导）。 */
  getSummary(path: string): string {
    const r = this.readSection(path);
    return r ? effectiveSummary(r.node) : "";
  }

  /**
   * 写节点摘要（L0，导航用）。text 为空串则清除显式摘要（回退推导摘要）。
   * 写入时记录内容指纹，叶子/子节点变动后 hash 不符即视为陈旧。
   */
  async writeSummary(path: string, text: string): Promise<OpResult> {
    return this.mutate("summary", path, (root) => {
      const r = resolvePath(root, path, { fuzzy: true });
      if (!r) return { ok: false, changed: false, path };
      const next = text.trim() === "" ? null : text.trim();
      const hash = next == null ? null : summaryHash(r.node);
      if (r.node.summary === next && (r.node.summaryHash ?? null) === hash) {
        return { changed: false, path };
      }
      r.node.summary = next;
      r.node.summaryHash = hash;
      return { changed: true, path };
    });
  }

  /** 写节点完整信息（RAG 语料，Markdown）。可含围栏代码块（序列化用动态围栏，不冲突）。 */
  async writeNote(path: string, content: string): Promise<OpResult> {
    return this.mutate("note", path, (root) => {
      const r = resolvePath(root, path, { fuzzy: true });
      if (!r) return { ok: false, changed: false, path };
      if (r.node.content === content) return { changed: false, path };
      r.node.content = content;
      return { changed: true, path };
    });
  }

  async upsertNode(path: string, leaf: string): Promise<OpResult> {
    return this.mutate("upsert", path, (root) => {
      const r = upsertNode(root, path, leaf);
      return { changed: r.changed, path: r.resolvedPath };
    });
  }

  /**
   * 原地替换节点内某条叶子（supersede）：比对前先剥掉两侧末尾的「← 日期」标记（归一化），
   * match 不带日期尾巴也能命中；归一化后须**唯一**命中，否则不做任何改动（ok=false）——防误替换。
   * 旧值被替换后即从检索中消失；变更落 revisions 可回滚。
   */
  async updateNode(path: string, match: string, leaf: string): Promise<OpResult> {
    return this.mutate("update", path, (root) => {
      const r = resolvePath(root, path, { fuzzy: true });
      if (!r) return { ok: false, changed: false, path };
      const m = stripDateMark(match);
      const hits = r.node.leaves.filter((l) => stripDateMark(l) === m).length;
      if (hits !== 1) return { ok: false, changed: false, path };
      r.node.leaves = r.node.leaves.map((l) => (stripDateMark(l) === m ? leaf : l));
      return { changed: true, path };
    });
  }

  async moveNode(from: string, to: string): Promise<OpResult> {
    return this.mutate("move", `${from} -> ${to}`, (root) => {
      const ok = moveNode(root, from, to);
      return { ok, changed: ok, path: from };
    });
  }

  async deleteNode(path: string): Promise<OpResult> {
    return this.mutate("delete", path, (root) => {
      const ok = deleteNode(root, path);
      return { ok, changed: ok, path };
    });
  }

  /**
   * 结构化批量操作（tidy 落盘）：一批 ops 在同一 mutate 事务里按序应用。
   * 任一条失败即整批回滚（不产生半吊子写入），落为一个可回滚的新版本。
   */
  async applyOps(ops: TreeOp[], detail?: string | null): Promise<OpResult> {
    return this.mutate("tidy", `(${ops.length} 个操作)`, (root) => {
      runBatchOps(root, ops);
      return {
        changed: true,
        path: `(${ops.length} 个操作)`,
        detail: detail && detail.trim() !== "" ? detail.trim() : `结构整理：${ops.length} 个操作`,
      };
    });
  }

  /** 预演一批 ops（对克隆树试跑），返回与当前树的结构差异；失败返回错误。不落盘。 */
  previewOps(ops: TreeOp[]): { ok: true; diff: TreeDiff } | { ok: false; error: string } {
    this.reloadIfStale();
    const clone = structuredClone(this.root);
    try {
      runBatchOps(clone, ops);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, diff: diffTrees(this.root, clone) };
  }

  // ---------- 原始证据 / 采集（P4） ----------

  /** 追加原始事件（会话/工具记录），返回 episode id。 */
  captureEpisodes(
    sessionId: string | null,
    rows: Array<{ role: string; kind: string; text: string; toolName?: string | null; seq?: number }>,
  ): number[] {
    return this.store.appendEpisodes(rows.map((r) => ({ ...r, sessionId })));
  }

  listEpisodes(opts: { sessionId?: string; limit?: number; sinceId?: number } = {}): Episode[] {
    return this.store.listEpisodes(opts);
  }

  getEpisodes(ids: number[]): Episode[] {
    return this.store.getEpisodes(ids);
  }

  countEpisodes(): number {
    return this.store.countEpisodes();
  }

  /** 按本地日历日聚合当天活动（sessions + 动过的节点 + 素材水位），日记派生与缓存失效判定用。 */
  dayDigest(date: string): DayDigest {
    return this.store.dayDigest(date);
  }

  /** 弱视图：叶子文本里带「← 日期」标记的条目（库启用前的历史日期兑底；无 session 维度）。 */
  leavesByDateMark(date: string): Array<{ path: string; leaf: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
    const mark = `← ${date}`;
    const out: Array<{ path: string; leaf: string }> = [];
    const walk = (n: MemoryNode, path: string) => {
      for (const l of n.leaves) if (l.includes(mark)) out.push({ path: path || n.title, leaf: l });
      for (const c of n.children) walk(c, path ? `${path}/${c.title}` : c.title);
    };
    walk(this.root as MemoryNode, "");
    return out;
  }

  pruneEpisodes(keep: number): number {
    return this.store.pruneEpisodes(keep);
  }

  /** 给某条叶子挂来源事件（弱链接，不修改叶子本身）。 */
  linkEvidence(path: string, leaf: string, episodeIds: number[]): void {
    this.store.linkEvidence(path, leafHash(leaf), episodeIds);
  }

  /** 查询来源事件：给 leaf 则按内容指纹精确匹配，否则返回该节点全部链接。 */
  evidenceFor(path: string, leaf?: string): EvidenceRef[] {
    return this.store.evidenceFor(path, leaf != null ? leafHash(leaf) : undefined);
  }

  // ---------- 变更审计（P3，从 undo log 派生） ----------

  listChanges(opts: { revisionId?: number; limit?: number } = {}): ChangeRow[] {
    return this.store.listChanges(opts);
  }

  /**
   * 某节点的历史值（新→旧，只记每次写入的值）：
   * 活节点按 fuzzy 解析取 uid；已删除节点兑底按 changes 里记录过的路径精确匹配。
   * 返回 uid 是否命中与节点是否已删除，便于上层给提示。
   */
  nodeHistory(path: string): { rows: HistoryRow[]; found: boolean; deleted: boolean } {
    this.reloadIfStale();
    const r = resolvePath(this.root, path, { fuzzy: true });
    if (r?.node.uid) return { rows: this.store.listNodeHistory(r.node.uid), found: true, deleted: false };
    const uid = this.store.uidByRecordedPath(path);
    if (uid == null) return { rows: [], found: false, deleted: false };
    return { rows: this.store.listNodeHistory(uid), found: true, deleted: true };
  }

  /**
   * 物化任意历史版本为只读树快照（不改当前树）。供版本对比视图使用；
   * 版本不存在返回 null。
   */
  treeAt(revisionId: number): MemoryNode | null {
    return this.store.materializeTree(revisionId);
  }

  /** 相对某个历史版本的结构差异（当前树 vs 该版本物化态）。 */
  diffSince(revisionId: number): TreeDiff | null {
    const base = this.store.materializeTree(revisionId);
    if (!base) return null;
    this.reloadIfStale();
    return diffTrees(base, this.root);
  }

  // ---------- 版本历史 / 回滚 ----------

  listRevisions(limit?: number) {
    return this.store.listRevisions(limit);
  }

  /** 回滚到指定版本：物化该版本 → 整体替换落为新版本（历史不改写，可再回滚/前滚）。 */
  async restoreRevision(id: number): Promise<OpResult> {
    const tree = this.store.materializeTree(id);
    if (!tree) return { ok: false, path: `#${id}`, revision: null, changed: false };
    return this.mutate("restore", `#${id}`, (root) => {
      root.title = tree.title;
      root.leaves = [...tree.leaves];
      root.leafUids = tree.leafUids ? [...tree.leafUids] : undefined;
      root.content = tree.content;
      root.summary = tree.summary;
      root.summaryHash = tree.summaryHash;
      root.children = structuredClone(tree.children);
      return { changed: true, path: `#${id}`, detail: `回滚到 #${id}` };
    });
  }

  /**
   * 变更包装：在目录锁内先按 DB 版本重载（拿到别的进程的最新写入），再应用改动，
   * 然后只把差异（节点级）写回 DB + 记版本 + 重建索引。
   * —— 消除「改内存旧树 → 整树覆盖」造成的跨会话丢失。
   */
  private async mutate(
    op: string,
    path: string,
    apply: (root: MemoryNode) => { changed: boolean; path: string; ok?: boolean; detail?: string | null },
  ): Promise<OpResult> {
    return withDirLock(this.dir, async () => {
      this.reloadIfStale(); // 关键：应用前先对齐 DB（含他人写入）
      let res: { changed: boolean; path: string; ok?: boolean; detail?: string | null };
      try {
        res = apply(this.root);
      } catch (e) {
        this.syncFromStore(); // 失败则丢弃可能的部分改动
        throw e;
      }
      if (!res.changed) {
        return { ok: res.ok ?? true, path: res.path, revision: null, changed: false };
      }
      ensureUids(this.root); // 新节点补发稳定 uid（在 diff 前）
      const delta = this.store.applyDelta(this.base, this.root); // 节点元数据 + 叶级增量写，undo 行叶级化
      if (delta.nodes.length === 0 && delta.leaves.length === 0) {
        this.base = structuredClone(this.root);
        return { ok: true, path: res.path, revision: null, changed: false };
      }
      const rev = this.store.commitRevision(op, res.path, res.detail ?? null, delta);
      this.store.rebuildFts(); // 派生索引
      this.base = structuredClone(this.root);
      this.loadedRevision = rev;
      return { ok: true, path: res.path, revision: String(rev), changed: true };
    });
  }
}
