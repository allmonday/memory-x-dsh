import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
                                             

/** 停用词：高频虚词/疑问代词——尤其是双字词会经 LIKE 兜底匹配一切，必须过滤 */
const STOPWORDS = new Set([
  // 中文虚词/疑问词（2-4 字）
  "什么", "怎么", "怎么样", "为什么", "是什么", "什么样", "哪些", "哪个", "哪里",
  "可以", "应该", "可能", "这个", "那个", "这些", "那些", "然后", "但是", "因为",
  "所以", "如果", "还有", "没有", "已经", "现在", "时候", "东西", "地方",
  "我们", "你们", "他们", "一下", "一些", "关于", "请问", "帮我", "告诉",
  "我的", "你的", "他的", "就是", "还是", "以及", "或者", "不是", "一个",
  "之前", "之后", "最近", "上次", "需要", "想看", "看看", "说一下", "有哪些",
  // 英文常用虚词
  "the", "a", "an", "is", "are", "was", "what", "how", "why", "when", "who",
  "can", "could", "should", "would", "do", "does", "did", "my", "your", "his",
  "this", "that", "then", "about", "from", "with", "for", "and", "but", "not",
  "me", "you", "it", "of", "to", "in", "on",
]);

export const STORE_DIR = ".memory";
export const DB_FILE = "memory.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  depth INTEGER NOT NULL,
  content TEXT,
  summary TEXT,
  summary_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord);
CREATE TABLE IF NOT EXISTS leaves(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaves_node ON leaves(node_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  path, title, body, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS access(
  path TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  path TEXT,
  actor TEXT NOT NULL DEFAULT 'pi',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS episodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, id);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
CREATE TABLE IF NOT EXISTS evidence(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_path TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_leaf ON evidence(node_path, leaf_hash);
CREATE TABLE IF NOT EXISTS changes(
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  path TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  before TEXT,
  before_leaves TEXT,
  PRIMARY KEY(revision_id, uid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS leaf_changes(
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  leaf_uid TEXT NOT NULL,
  node_uid TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_text TEXT,
  after_text TEXT,
  before_node_uid TEXT,
  before_ord INTEGER,
  PRIMARY KEY(revision_id, leaf_uid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_leaf_changes_node ON leaf_changes(node_uid, revision_id);
`;

                   
             
              
                           
              
                
               
                
                         
                         
                              
 

/** 扁平化后的节点元数据（applyDelta 的 diff 单位） */
                    
              
                                              
                  
                
                   
                                                    
                                 
                         
                         
                             
                            
                           
              
                
 

/** 节点元数据态（undo log 的 before 值；叶子不走这里，走叶级行）。parent 用 uid 引用，跨移动稳定。 */
                                
                
                         
                         
                             
                           
              
                                             
                       
 

/** 一次写入的逐节点 undo 行（uid 为键，同一版本内每节点最多一行）。 */
                             
              
               
                   
                                                            
                               
 

/** 叶级 undo/审计行：一条叶子的增/改/删只记录该叶自身，不再快照整节点。 */
                                 
                  
                  
               
                                    
                          
                            
                       
                           
                                        
                               
                           
 

/** 一次写入的完整 delta：节点元数据行 + 叶级行。 */
                            
                      
                           
 

/** 扁平 uid 索引中的一个节点（uid → 路径 + 元数据 + 叶子列表）。 */
                          
               
                      
                                                            
 

/** undo 行：节点元数据行（含旧格式 before_leaves blob）。 */
                       
                      
              
               
                  
                        
                               
 

/** undo 行：叶级行（一条叶子的 add / update / remove）。 */
                       
                      
                   
                   
               
                             
                                 
                            
 

/** 一个版本的 undo 行：叶级行 + 节点行。 */
                      
                        
                       
 

/** 回放工作态里的一个叶子：按叶子 uid 寻址，记所在节点与序位。 */
                    
                  
              
               
 

/** 回放工作态：节点元数据索引 + 叶子表 + 尚未拆成叶级行的旧格式 blob。 */
                       
                              
                                 
                                      
 

/** 给树中缺 uid 的节点补发稳定 uid（幂等）。 */
export function ensureUids(root            )       {
  const walk = (n            ) => {
    if (!n.uid) n.uid = randomUUID();
    for (const c of n.children) walk(c);
  };
  walk(root);
}

function arrEq(a          , b          )          {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 扁平节点 → undo 用的节点元数据态（不含叶子）。 */
function metaOf(f          )                {
  return {
    title: f.title,
    content: f.content,
    summary: f.summary,
    summaryHash: f.summaryHash,
    parentUid: f.parentUid,
    ord: f.ord,
  };
}

/** 节点元数据是否相同（决定是否要落 undo 行；叶子另比）。 */
function metaEq(a               , b               )          {
  return (
    a.title === b.title &&
    (a.content ?? null) === (b.content ?? null) &&
    (a.summary ?? null) === (b.summary ?? null) &&
    (a.summaryHash ?? null) === (b.summaryHash ?? null) &&
    a.parentUid === b.parentUid &&
    a.ord === b.ord
  );
}

/**
 * 转义 LIKE 模式中的通配符（`\`、`%`、`_`），配合 `... LIKE ? ESCAPE '\'` 使用。
 * 物化 path 可能含这些字符（如标题带 `%`），不转义会误伤/越界匹配。
 */
export function escapeLike(s        )         {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** 叶子事实的内容指纹（sha1 前 16 位），用于 evidence 弱链接（不改叶子类型）。 */
export function leafHash(leaf        )         {
  return createHash("sha1").update(leaf.trim()).digest("hex").slice(0, 16);
}

/** 原始事件（会话/工具记录，逐字保存）。 */
/** 按日聚合结果：日记派生的素材。 */
                            
               
                   
                             
                   
                  
                    
                             
                          
     
                               
                                              
                                        
                                                             
                 
 

                          
             
                           
              
               
               
               
                          
                    
 

/** 叶子 ↔ 原始事件的链接。 */
                              
                   
                   
                    
 

/** 变更审计行（从 undo log + 物化态派生，不落盘；供 /memory changes 与 log --diff）。 */
                            
                     
                                                
                
                           
             
               
              
                          
                        
                    
 

/** 节点历史条目：某版本为该节点【写入】的值（只记写入侧；被取代的旧值在其出生版本已列出，不重复）。 */
                             
                     
                                            
                
                           
                    
                                                                             
             
                                                                   
                       
 

                            
               
                
                      
                     
                  
                      
                    
                      
                                   
                
                                                       
                  
 

/**
 * SQLite 存储层（B 案）：nodes 表为操作真相源。
 * 每个节点带稳定 uid（跨版本寻址，不随路径变化）与物化完整链路 path
 * （重名兄弟自动 [n] 消歧），content 字段承载节点完整信息（RAG 语料）。
 * 版本历史 = revisions 时间线 + changes 逐节点 undo log（存变更前状态）；
 * 任意版本由当前态逆推 undo 行物化，无需整树快照。
 *
 * 写入策略：整树重写（单事务）。个人记忆规模（≤万级节点）下
 * 全量重建是毫秒级操作，换取与内存树的绝对一致，无增量同步 bug 面。
 * WAL 模式保证崩溃安全。
 */
export class MemoryStore {
                   db              ;
           dbPath        ;

          constructor(dbPath        ) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

          columns(table        )              {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all()                           ;
    return new Set(cols.map((c) => c.name));
  }

  /**
   * 轻量迁移：旧库补列（summary/uid）+ 把旧 schema 的 revisions/changes 升级为 undo log。
   * CREATE TABLE IF NOT EXISTS 不会改已存在的表，故结构变更都在此处显式处理。
   */
          migrate()       {
    let destructive = false;
    const nodeCols = this.columns("nodes");
    if (!nodeCols.has("summary")) this.db.exec("ALTER TABLE nodes ADD COLUMN summary TEXT");
    if (!nodeCols.has("summary_hash")) this.db.exec("ALTER TABLE nodes ADD COLUMN summary_hash TEXT");
    if (!nodeCols.has("uid")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN uid TEXT");
      const rows = this.db.prepare("SELECT id FROM nodes").all()                         ;
      const upd = this.db.prepare("UPDATE nodes SET uid = ? WHERE id = ?");
      for (const r of rows) upd.run(randomUUID(), r.id);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_uid ON nodes(uid)");

    // 版本历史：旧 revisions 带整树快照列 tree → 丢弃整段旧历史（快照无法转成 undo log，
    // 留着会误导回滚），时间线从 baseline 重新开始。
    const revCols = this.columns("revisions");
    if (revCols.has("tree")) {
      destructive = true;
      this.db.exec("BEGIN");
      this.db.exec("DROP TABLE revisions");
      this.db.exec(`CREATE TABLE revisions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL, path TEXT, actor TEXT NOT NULL DEFAULT 'pi',
        detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      this.db.exec("COMMIT");
    } else if (!revCols.has("detail")) {
      this.db.exec("ALTER TABLE revisions ADD COLUMN detail TEXT");
    }

    // 变更审计 → undo log：旧字段审计行（id/op/from_text）与新语义不兼容，重建。
    const chCols = this.columns("changes");
    if (chCols.has("from_text") || chCols.has("id")) this.db.exec("DROP TABLE changes");
    this.db.exec(`CREATE TABLE IF NOT EXISTS changes(
      revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      uid TEXT NOT NULL, path TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      before TEXT, before_leaves TEXT, PRIMARY KEY(revision_id, uid)
    ) WITHOUT ROWID`);
    if (!this.columns("changes").has("before_leaves"))
      this.db.exec("ALTER TABLE changes ADD COLUMN before_leaves TEXT");

    // 叶子稳定身份：补 uid 列并回填（含旧代码写入产生的 NULL，幂等）；回填后再建唯一索引。
    // 旧代码（删光重插不留 uid）仍可能与新代码交替写同一库：每次打开都补一次 NULL。
    if (!this.columns("leaves").has("uid")) this.db.exec("ALTER TABLE leaves ADD COLUMN uid TEXT");
    {
      const rows = this.db.prepare("SELECT id FROM leaves WHERE uid IS NULL").all()                         ;
      if (rows.length > 0) {
        const upd = this.db.prepare("UPDATE leaves SET uid = ? WHERE id = ?");
        this.db.exec("BEGIN");
        for (const r of rows) upd.run(randomUUID(), r.id);
        this.db.exec("COMMIT");
      }
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_leaves_uid ON leaves(uid)");

    // 节点稳定身份：旧代码（INSERT 不带 uid 列）删光重插会丢节点 uid，破坏 uid 寻址
    // （currentByUid 的 parentUid 解析 → 假根 → materializeTree 树漂移）。每次打开补一次。
    {
      const rows = this.db.prepare("SELECT id FROM nodes WHERE uid IS NULL OR uid = ''").all()                         ;
      if (rows.length > 0) {
        const upd = this.db.prepare("UPDATE nodes SET uid = ? WHERE id = ?");
        this.db.exec("BEGIN");
        for (const r of rows) upd.run(randomUUID(), r.id);
        this.db.exec("COMMIT");
      }
    }

    // 旧格式 undo 行（before 含全量 leaves 数组）→ 新格式：元数据行 + before_leaves 整体 blob。
    // 不拆叶级行：拆行体积膨胀 ~2x 且旧快照本就拆不出真实增删；blob 保留 undo/展示所需的旧态全量。
    // 幂等：拆完 before 不再含 "leaves" 键，不再命中。
    {
      const legacy = this.db
        .prepare("SELECT revision_id, uid, before FROM changes WHERE before LIKE '%\"leaves\"%'")
        .all()                                                               ;
      const real                                                                                     = [];
      for (const r of legacy) {
        try {
          const st = JSON.parse(r.before)                                         ;
          if (Array.isArray(st.leaves)) {
            const { leaves, ...meta } = st;
            real.push({ revision_id: r.revision_id, uid: r.uid, meta, leaves });
          }
        } catch {
          // 解析失败的老行保持原样，读取层容错
        }
      }
      if (real.length > 0) {
        this.db.exec("BEGIN");
        const upd = this.db.prepare("UPDATE changes SET before = ?, before_leaves = ? WHERE revision_id = ? AND uid = ?");
        for (const r of real) {
          upd.run(JSON.stringify(r.meta), JSON.stringify(r.leaves), r.revision_id, r.uid);
        }
        this.db.exec("COMMIT");
        destructive = true; // 触发 VACUUM 回收
      }
    }

    // 旧格式 blob → 叶级行回填（根治「与当前态 set-diff」的漂移）：
    // 同节点相邻 blob 两两即点时快照；末行用 materializeTree 重放末态（真实 uid）。
    // 回填后清空 before_leaves，读取/回滚统一走叶级行；校验失败整体放弃（blob 保留走旧兜底）。
    {
      const legacyRows = this.db
        .prepare("SELECT revision_id, uid, path, before_leaves FROM changes WHERE before_leaves IS NOT NULL ORDER BY uid, revision_id")
        .all()                                                                                    ;
      if (legacyRows.length > 0 && process.env.MX_NO_BACKFILL !== "1") {
        try {
          this.backfillLegacyLeaves(legacyRows);
          destructive = true; // blob 已清，VACUUM 回收
        } catch (e) {
          if (process.env.MX_DEBUG) console.error("legacy leaf backfill skipped:", e);
        }
      }
    }

    // 建节点行（before IS NULL）在旧格式时代没有叶级行：变更视图与节点历史里只剩 add-node，
    // 建节点时写入的初始叶子缺席。blob 清空后按版本物化取当时的叶子与身份补 add 行；
    // 新格式原生的建节点行自带叶级行，不会被命中，没有要补的行就不写库。
    try {
      this.backfillCreationLeaves();
    } catch (e) {
      if (process.env.MX_DEBUG) console.error("creation leaf backfill skipped:", e);
    }

    // 丢弃整树快照后回收空间（一次性；失败不阻断打开）
    if (destructive) {
      try {
        this.db.exec("VACUUM");
      } catch (e) {
        if (process.env.MX_DEBUG) console.error("VACUUM failed:", e);
      }
    }
  }

  static open(dir        )              {
    mkdirSync(join(dir, STORE_DIR), { recursive: true });
    return new MemoryStore(join(dir, STORE_DIR, DB_FILE));
  }

  isEmpty()          {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM nodes").get()                 ;
    return row.n === 0;
  }

  loadTree()             {
    const nodeRows = this.db
      .prepare("SELECT id, uid, parent_id, ord, title, path, depth, content, summary, summary_hash FROM nodes ORDER BY depth, ord, id")
      .all()             ;
    if (nodeRows.length === 0) return { title: "Memory", leaves: [], children: [] };

    const leafRows = this.db
      .prepare("SELECT node_id, uid, ord, text FROM leaves ORDER BY node_id, ord, id")
      .all()                                                                        ;

    const byId = new Map                                                                ();
    for (const r of nodeRows) {
      byId.set(r.id, {
        uid: r.uid,
        title: r.title,
        leaves: [],
        content: r.content,
        summary: r.summary,
        summaryHash: r.summary_hash,
        children: [],
        __id: r.id,
        __parent: r.parent_id,
      });
    }
    for (const l of leafRows) {
      const node = byId.get(l.node_id);
      if (!node) continue;
      node.leaves.push(l.text);
      (node.leafUids ??= []).push(l.uid);
    }

    let root                                                                      ;
    for (const r of nodeRows) {
      const node = byId.get(r.id) ;
      if (r.parent_id === null) {
        root = node;
      } else {
        byId.get(r.parent_id)?.children.push(node);
      }
    }
    if (!root) throw new Error("存储损坏：找不到根节点（parent_id 为 NULL 的记录缺失）");
    const clean = (n                                                        )             => ({
      uid: n.uid,
      title: n.title,
      leaves: n.leaves,
      leafUids: n.leafUids ? [...n.leafUids] : undefined,
      content: n.content,
      summary: n.summary,
      summaryHash: n.summaryHash,
      children: n.children.map(clean),
    });
    return clean(root);
  }

  /** 整树重写（单事务）。path 物化：重名兄弟追加 [k]（k≥2）。
   *  叶子 uid：树里带身份则用之；无身份按文本从库内同节点收养（保持跨重写的稳定身份）。 */
  saveTree(root            )       {
    ensureUids(root);
    const insertNode = this.db.prepare(
      "INSERT INTO nodes(uid, parent_id, ord, title, path, depth, content, summary, summary_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertLeaf = this.db.prepare("INSERT INTO leaves(uid, node_id, ord, text) VALUES (?, ?, ?, ?)");
    // 旧库内叶子（按节点 uid 分桶），供文本收养
    const oldByNode = new Map                                              ();
    for (const r of this.db
      .prepare("SELECT l.uid, l.text, n.uid AS node_uid FROM leaves l JOIN nodes n ON n.id = l.node_id WHERE l.uid IS NOT NULL")
      .all()                                                          ) {
      const arr = oldByNode.get(r.node_uid) ?? [];
      arr.push({ uid: r.uid, text: r.text });
      oldByNode.set(r.node_uid, arr);
    }
    const writeLeaves = (node            , nodeId        )       => {
      const old = oldByNode.get(node.uid ) ?? [];
      const used = new Set        ();
      for (let i = 0; i < node.leaves.length; i++) {
        const text = node.leaves[i] ;
        let uid = node.leafUids?.[i] ?? null;
        if (uid == null) {
          const hit = old.find((o) => !used.has(o.uid) && o.text === text);
          if (hit) {
            uid = hit.uid;
            used.add(uid);
          }
        }
        insertLeaf.run(uid ?? randomUUID(), nodeId, i, text);
      }
    };

    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM leaves");
      this.db.exec("DELETE FROM nodes");

      const walk = (node            , parentId               , parentPath        , depth        )         => {
        let ord = 0;
        const titleCount = new Map                ();
        for (const child of node.children) {
          const seen = (titleCount.get(child.title) ?? 0) + 1;
          titleCount.set(child.title, seen);
          const seg = seen > 1 ? `${child.title}[${seen}]` : child.title;
          const path = parentPath === "" ? seg : `${parentPath}/${seg}`;
          const info = insertNode.run(child.uid, parentId, ord++, child.title, path, depth, child.content ?? null, child.summary ?? null, child.summaryHash ?? null);
          const id = Number(info.lastInsertRowid);
          writeLeaves(child, id);
          walk(child, id, path, depth + 1);
        }
        return ord;
      };
      const rootInfo = insertNode.run(root.uid, null, 0, root.title, "", 0, root.content ?? null, root.summary ?? null, root.summaryHash ?? null);
      const rootId = Number(rootInfo.lastInsertRowid);
      writeLeaves(root, rootId);
      walk(root, rootId, "", 1);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- 增量写（节点级，替代整树重写） ----------

  /**
   * 把 base → next 的差异以节点级 SQL 写回（单事务）。
   * 以物化 path 为定位键：新增/更新按 path upsert，删除按 path 级联。
   * 未被本进程改动的节点不出现在 diff 中，因此不会被覆盖（多写者安全）。
   *
   * 返回 uid 空间的 undo 行（每节点最多一条）：新增 before=null，
   * 删除 deleted=true+before=旧态，修改 before=旧态。重命名/移动视为同 uid
   * 的一条修改行（路径变了但身份不变），undo 时可精确改回原路径。
   */
  applyDelta(base            , next            )            {
    const b = this.flatten(base);
    const n = this.flatten(next);

    const removed = [...b.keys()].filter((p) => {
      const v = b.get(p) ;
      // 按 uid 判存亡：移动/改名只换 path 不换 uid，不算删除
      return ![...n.values()].some((x) => x.uid === v.uid);
    });
    const bByUid = new Map                                       ();
    for (const [path, v] of b) bByUid.set(v.uid, { path, v });

    const dbLeaves = this.db.prepare(
      "SELECT l.id, l.uid, l.ord, l.text FROM leaves l JOIN nodes n ON n.id = l.node_id WHERE n.path = ? ORDER BY l.ord, l.id",
    );
    const leavesOf = (path        )                                                    =>
      (dbLeaves.all(path)                                                                        ).map((r) => ({
        uid: r.uid ?? randomUUID(),
        ord: r.ord,
        text: r.text,
      }));

    /** 单节点叶子规划：显式身份优先，无身份按文本收养；产出最终行 + 叶级 delta + 重排标记 */
    const planLeaves = (
      oldRows                                                   ,
      v          ,
        
                                                              
                              
                            
                              
    ) => {
      const oldByUid = new Map(oldRows.map((r) => [r.uid, r]));
      const used = new Set        (); // 已消费的旧 uid
      const usedNew = new Set        (); // 新行已用的 uid（防重复身份）
      const delta                   = [];
      const rows                                                    = [];
      const pending = v.leaves.map((text, i) => ({ text, uid: v.leafUids[i] ?? null, ord: i }));
      // 第一遍：显式身份（同 uid 异文 = update，版本链不断）
      const rest                                       = [];
      for (const e of pending) {
        if (e.uid != null && !usedNew.has(e.uid)) {
          usedNew.add(e.uid);
          const old = oldByUid.get(e.uid);
          if (old && !used.has(e.uid)) {
            used.add(e.uid);
            rows.push({ uid: e.uid, ord: e.ord, text: e.text });
            if (old.text !== e.text)
              delta.push({ leafUid: e.uid, nodeUid: v.uid, path: "", kind: "update", beforeText: old.text, afterText: e.text, beforeNodeUid: null, beforeOrd: null });
          } else {
            rows.push({ uid: e.uid, ord: e.ord, text: e.text });
            delta.push({ leafUid: e.uid, nodeUid: v.uid, path: "", kind: "add", beforeText: null, afterText: e.text, beforeNodeUid: null, beforeOrd: null });
          }
        } else {
          rest.push({ text: e.text, ord: e.ord });
        }
      }
      // 第二遍：无身份 → 文本收养（同文本旧叶身份延续，不落行）；收养不到新发身份
      for (const e of rest) {
        const old = oldRows.find((r) => !used.has(r.uid) && r.text === e.text);
        if (old) {
          used.add(old.uid);
          rows.push({ uid: old.uid, ord: e.ord, text: e.text });
        } else {
          const uid = randomUUID();
          rows.push({ uid, ord: e.ord, text: e.text });
          delta.push({ leafUid: uid, nodeUid: v.uid, path: "", kind: "add", beforeText: null, afterText: e.text, beforeNodeUid: null, beforeOrd: null });
        }
      }
      // 第三遍：旧集未消费 → remove（undo 按 beforeNodeUid/beforeOrd 归位）
      for (const r of oldRows) {
        if (!used.has(r.uid))
          delta.push({ leafUid: r.uid, nodeUid: v.uid, path: "", kind: "remove", beforeText: r.text, afterText: null, beforeNodeUid: v.uid, beforeOrd: r.ord });
      }
      // 重排检测：同 uid 集合、不同顺序 → 节点行携 leafOrder（旧序）
      const newSeq = rows.map((r) => r.uid);
      const oldSeq = oldRows.map((r) => r.uid);
      const sameSet =
        newSeq.length === oldSeq.length &&
        newSeq.every((u) => newSeq.filter((x) => x === u).length === oldSeq.filter((x) => x === u).length);
      const orderChanged = sameSet && !arrEq(newSeq, oldSeq);
      return { rows, delta, orderChanged, oldSeq: orderChanged ? oldSeq : null };
    };

    const nodeDelta               = [];
    const leafDelta                   = [];

    const delNode = this.db.prepare("DELETE FROM nodes WHERE path = ?");
    const upsertRow = this.db.prepare(
      `INSERT INTO nodes(uid, parent_id, ord, title, path, depth, content, summary, summary_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         uid = excluded.uid, parent_id = excluded.parent_id, ord = excluded.ord,
         title = excluded.title, depth = excluded.depth, content = excluded.content,
         summary = excluded.summary, summary_hash = excluded.summary_hash,
         updated_at = datetime('now')`,
    );
    const idOf = this.db.prepare("SELECT id FROM nodes WHERE path = ?");
    const delLeaves = this.db.prepare("DELETE FROM leaves WHERE node_id = ?");
    const insLeaf = this.db.prepare("INSERT INTO leaves(uid, node_id, ord, text) VALUES (?, ?, ?, ?)");

    this.db.exec("BEGIN");
    try {
      // 删除：深→浅（父级联会带走子树，后续删除自然是幂等 no-op）；删除前抓旧叶子发 remove 行
      for (const p of removed.sort((x, y) => y.split("/").length - x.split("/").length)) {
        const ob = b.get(p) ;
        for (const lr of leavesOf(p)) {
          leafDelta.push({ leafUid: lr.uid, nodeUid: ob.uid, path: p, kind: "remove", beforeText: lr.text, afterText: null, beforeNodeUid: ob.uid, beforeOrd: lr.ord });
        }
        delNode.run(p);
        nodeDelta.push({ uid: ob.uid, path: p, deleted: true, before: metaOf(ob) });
      }
      // 新增/更新：浅→深（保证父先于子落库）。
      // 移动/改名：同 uid 换 path——先缓存旧叶子，预删旧行（级联会带走后代行，故统一先取叶子），再写新行。
      const oldLeavesCache = new Map                                                           ();
      const oldLeaves = (oldPath        )                                                    => {
        let rows = oldLeavesCache.get(oldPath);
        if (!rows) {
          rows = leavesOf(oldPath);
          oldLeavesCache.set(oldPath, rows);
        }
        return rows;
      };
      for (const [p, v] of [...n.entries()].sort((x, y) => x[1].depth - y[1].depth)) {
        const o = bByUid.get(v.uid); // 同 uid（路径可能已变：移动/改名）
        if (o) oldLeaves(o.path); // 先全量缓存旧叶子（级联删除不可逆，懒加载会落空）
      }
      for (const [p, v] of [...n.entries()].sort((x, y) => x[1].depth - y[1].depth)) {
        const o = bByUid.get(v.uid); // 同 uid（路径可能已变：移动/改名）
        if (o && o.path !== p) delNode.run(o.path); // 旧行先删（uid 唯一约束 + 物化路径切换）
      }
      for (const [p, v] of [...n.entries()].sort((x, y) => x[1].depth - y[1].depth)) {
        const o = bByUid.get(v.uid); // 同 uid（路径可能已变：移动/改名）
        const pathChanged = o != null && o.path !== p;
        const oldRows = o ? oldLeaves(o.path) : [];
        const plan = planLeaves(oldRows, v);
        const metaChanged = !o || !metaEq(metaOf(o.v), metaOf(v));
        const dbId = (idOf.get(p)                              )?.id;
        // 首写/换路径无条件落行（含根：内存 base 有根但库空）
        if (!pathChanged && dbId != null && !metaChanged && plan.delta.length === 0 && !plan.orderChanged) continue; // 完全无变化
        const parentId =
          v.parentPath === null
            ? null
            : ((idOf.get(v.parentPath)                              )?.id ?? null);
        upsertRow.run(v.uid, parentId, v.ord, v.title, p, v.depth, v.content, v.summary, v.summaryHash);
        const nodeId = (idOf.get(p)                  ).id;
        delLeaves.run(nodeId);
        for (const r of plan.rows) insLeaf.run(r.uid, nodeId, r.ord, r.text);
        v.ref.leafUids = plan.rows.map((r) => r.uid); // 收养/新发身份回写内存树，后续 update 不断链
        for (const d of plan.delta) leafDelta.push({ ...d, path: p });
        if (!o) {
          nodeDelta.push({ uid: v.uid, path: p, deleted: false, before: null });
        } else {
          const before = metaOf(o.v);
          if (plan.orderChanged) before.leafOrder = plan.oldSeq ;
          if (metaChanged || plan.orderChanged) nodeDelta.push({ uid: v.uid, path: o.path, deleted: false, before });
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { nodes: nodeDelta, leaves: leafDelta };
  }
  /** 扁平化整树：物化 path → 节点元数据（与 saveTree 同一套 [n] 消歧规则）。 */
          flatten(root            )                        {
    const out = new Map                  ();
    const walk = (node            , path        , parentPath               , parentUid               , ord        , depth        ) => {
      out.set(path, {
        uid: node.uid ,
        ref: node,
        title: node.title,
        leaves: node.leaves,
        leafUids: node.leafUids ?? node.leaves.map(() => null),
        content: node.content ?? null,
        summary: node.summary ?? null,
        summaryHash: node.summaryHash ?? null,
        parentPath,
        parentUid,
        ord,
        depth,
      });
      const counts = new Map                ();
      node.children.forEach((c, i) => {
        const seen = (counts.get(c.title) ?? 0) + 1;
        counts.set(c.title, seen);
        const seg = seen > 1 ? `${c.title}[${seen}]` : c.title;
        walk(c, path === "" ? seg : `${path}/${seg}`, path, node.uid , i, depth + 1);
      });
    };
    walk(root, "", null, null, 0, 0);
    return out;
  }

  /** 供检索层：按 path 前缀查节点（含完整链路）。通配符已转义。 */
  findByPathPrefix(prefix        )            {
    return this.db
      .prepare("SELECT * FROM nodes WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY depth, ord")
      .all(prefix, `${escapeLike(prefix)}/%`)             ;
  }

  // ---------- 检索层（全部派生，可随时重建） ----------

  /** 整表重建 FTS（毫秒级，persist 后调用）。语料 = path+标题+叶子+content。 */
  rebuildFts()       {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM memory_fts");
      this.db.exec(`
        INSERT INTO memory_fts(rowid, path, title, body)
        SELECT n.id, n.path, n.title,
          COALESCE((SELECT group_concat(l.text, ' ') FROM leaves l WHERE l.node_id = n.id), '')
          || ' ' || COALESCE(n.content, '')
        FROM nodes n
        WHERE n.path != ''
      `);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  ftsIsEmpty()          {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get()                 ;
    return row.n === 0;
  }

  /**
   * 检索：FTS5 trigram（≥3 字词，bm25 排序 + snippet）∪ LIKE 兜底（2 字短词）。
   * 排序 = 检索分 × 访问频次加成 × 新鲜度加成（P5：用得多的记忆更易被召回）。
   * 返回带完整链路/祖先/兄弟/命中片段的富化结果。
   *
   * scope：可选，物化节点路径（由 MemoryFile 模糊解析后规范化）。
   * 只返回该节点自身及其子树的命中（对齐 OpenViking「search a directory, not the whole index」）。
   * 过滤下推到 SQL：FTS 的 LIMIT 在 WHERE 之后，故 scope 下召回仍足量。
   */
  search(query        , topK = 5, scope         )              {
    const sc = scope && scope.trim() !== "" ? scope : undefined;
    const scopePat = sc ? `${escapeLike(sc)}/%` : undefined;
    const tokens = (query.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t.toLowerCase()));
    if (tokens.length === 0) return [];
    // CJK 长词滑窗拆分：整句子串匹配召回过低（"我最喜欢的科学家是谁" 匹配不到含"科学家"的文档）。
    // 拆成重叠 trigram OR 连接，bm25 排序压制噪音。
    const expand = (t        )           => {
      if (t.length >= 4 && /\p{Script=Han}/u.test(t)) {
        const out           = [];
        for (let i = 0; i + 3 <= t.length; i++) out.push(`"${t.slice(i, i + 3)}"`);
        return out;
      }
      return t.length >= 3 ? [`"${t.replace(/"/g, "")}"`] : [];
    };
    const ftsTerms = tokens.flatMap(expand);
    const shortTerms = tokens.filter((t) => t.length === 2).map((t) => t.replace(/[\\%_]/g, " "));
    if (ftsTerms.length === 0 && shortTerms.length === 0) return [];

                      
                   
                    
                             
                          
                   
     
    const seen = new Map                ();

    if (ftsTerms.length > 0) {
      const scopeClause = sc ? " AND (path = ? OR path LIKE ? ESCAPE '\\')" : "";
      const rows = this.db
        .prepare(
          `SELECT path, title,
             snippet(memory_fts, 2, '«', '»', '…', 16) AS snip, rank
           FROM memory_fts WHERE memory_fts MATCH ? AND path != ''${scopeClause}
           ORDER BY rank LIMIT ?`,
        )
        .all(
          ...[ftsTerms.join(" OR ")],
          ...(sc ? [sc, scopePat] : []),
          Math.max(topK * 2, 10),
        )           
                     
                      
                     
                     
        ;
      for (const r of rows) {
        seen.set(r.path, { path: r.path, title: r.title, snippet: r.snip, via: "fts", rank: r.rank });
      }
    }

    if (shortTerms.length > 0) {
      const scopeClause = sc ? " AND (n.path = ? OR n.path LIKE ? ESCAPE '\\')" : "";
      for (const term of shortTerms) {
        const pat = `%${term}%`;
        const rows = this.db
          .prepare(
            `SELECT DISTINCT n.path, n.title, n.content FROM nodes n
             LEFT JOIN leaves l ON l.node_id = n.id
             WHERE n.path != '' AND (n.title LIKE ? ESCAPE ' ' OR n.content LIKE ? ESCAPE ' ' OR l.text LIKE ? ESCAPE ' ')${scopeClause}
             LIMIT 50`,
          )
          .all(pat, pat, pat, ...(sc ? [sc, scopePat] : []))                                                                  ;
        for (const r of rows) {
          if (seen.has(r.path)) continue;
          const body = r.content ?? "";
          const idx = body.indexOf(term);
          const snip =
            idx >= 0
              ? `${idx > 20 ? "…" : ""}${body.slice(Math.max(0, idx - 20), idx + 60)}`
              : r.title;
          seen.set(r.path, { path: r.path, title: r.title, snippet: snip, via: "like", rank: 99 });
        }
      }
    }

    const ordered = [...seen.values()].sort((a, b) => a.rank - b.rank);
    // 信号加成：访问频次（log）+ 新鲜度（30 天线性衰减，仅命中过才算）
    const accessRows = this.db
      .prepare(`SELECT path, hits, last_hit FROM access WHERE ${
        [...seen.keys()].map(() => "path = ?").join(" OR ") || "0"
      }`)
      .all(...seen.keys())                                                           ;
    const accessByPath = new Map(accessRows.map((r) => [r.path, r]));
    const now = Date.now();
    const scored = ordered.map((h) => {
      const base = h.via === "fts" ? Math.max(0.01, -h.rank) : 0.5; // like 兜底给固定低底分
      const acc = accessByPath.get(h.path);
      let mult = 1;
      if (acc) {
        mult *= 1 + 0.5 * Math.log2(1 + acc.hits); // 2 次命中 +50%，8 次 +200%
        const daysSince = (now - acc.last_hit) / 86_400_000;
        if (daysSince < 30) mult *= 1 + 0.3 * (1 - daysSince / 30); // 近期用过再 +最多30%
      }
      return { ...h, score: Number((base * mult).toFixed(4)) };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((h) => this.enrich(h));
  }

          enrich(h   
                 
                  
                           
                        
                   
   )            {
    const segs = h.path.split("/");
    const parentPath = segs.length > 1 ? segs.slice(0, -1).join("/") : null;
    let siblings           = [];
    let leafCount = 0;
    let hasContent = false;
    if (parentPath !== null) {
      const rows = this.db
        .prepare(
          `SELECT title,
             (SELECT COUNT(*) FROM leaves l WHERE l.node_id = n.id) AS lc,
             (n.content IS NOT NULL) AS hc
           FROM nodes n WHERE n.parent_id = (SELECT id FROM nodes WHERE path = ?)`,
        )
        .all(parentPath)                                                    ;
      siblings = rows.map((r) => r.title);
      leafCount = rows.find((r) => r.title === h.title)?.lc ?? 0;
      hasContent = Boolean(rows.find((r) => r.title === h.title)?.hc);
    } else {
      const row = this.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM leaves l WHERE l.node_id = n.id) AS lc, (n.content IS NOT NULL) AS hc
           FROM nodes n WHERE n.path = ?`,
        )
        .get(h.path)                                          ;
      leafCount = row?.lc ?? 0;
      hasContent = Boolean(row?.hc);
    }
    return {
      path: h.path,
      title: h.title,
      ancestors: segs.slice(0, -1),
      siblings,
      snippet: h.snippet ?? "",
      hasContent,
      leafCount,
      via: h.via,
      score: h.score ?? 0,
      summary: "",
    };
  }

  /** 记录访问信号（排序燃料，P5）。 */
  recordAccess(paths          )       {
    const stmt = this.db.prepare(
      `INSERT INTO access(path, hits, last_hit) VALUES (?, 1, ?)
       ON CONFLICT(path) DO UPDATE SET hits = hits + 1, last_hit = excluded.last_hit`,
    );
    const now = Date.now();
    for (const p of paths) stmt.run(p, now);
  }

  // ---------- 版本历史（MVCC，移植自 MindMap X） ----------
  // 真相 = 当前 nodes/leaves。revisions 只存时间线元数据（一行一次 mutation，无树内容）；
  // changes = 逐节点 undo log（键 uid，存变更【前】状态）。
  // 任意版本由「当前态 + 撤销 revision_id > target 的 before 行」物化（降序逆向回溯）。
  // 不变式：回滚是前进（新版本），历史永不改写、永不裁剪。

  /** 记录一次变更的时间线元数据，返回版本号。 */
  recordRevision(op        , path               , detail                = null, actor = "pi")         {
    const info = this.db
      .prepare("INSERT INTO revisions(op, path, actor, detail) VALUES (?, ?, ?, ?)")
      .run(op, path, actor, detail);
    return Number(info.lastInsertRowid);
  }

  revisionCount()         {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM revisions").get()                 ;
    return row.n;
  }

  latestRevisionId()         {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM revisions").get()                  ;
    return row.id;
  }

  /**
   * 每节点的改写次数（uid → 次数）。
   * 口径：节点「语义态」（title/leaves/content/summary）在版本链上被改变的次数。
   * 创建（before=null）不计；纯位置变化（ord/parentUid，含兄弟移动引起的重排）不计。
   * 供 memory_read 标注「该节点有历史」，让模型知道值可能被取代过。
   */
  rewriteCounts()                      {
    // 语义改写 = 元数据语义字段（title/content/summary）变化 ∪ 叶级行（add/update/remove/restore）所在版本。
    // restore 是旧格式快照的迁移形态：其所在版本即历史上的真实改写，计入以保持旧口径。
    const revs = new Map                     ();
    const addRev = (uid        , rev        )       => {
      const s = revs.get(uid);
      if (s) s.add(rev);
      else revs.set(uid, new Set([rev]));
    };
    for (const r of this.db
      .prepare(
        `SELECT node_uid, revision_id FROM leaf_changes lc
         WHERE NOT EXISTS (
           SELECT 1 FROM changes c
           WHERE c.revision_id = lc.revision_id AND c.uid = lc.node_uid AND c.before IS NULL
         )`,
      )
      .all()                                                    ) {
      addRev(r.node_uid, r.revision_id);
    }
    const rows = this.db
      .prepare("SELECT uid, revision_id, before, before_leaves FROM changes WHERE before IS NOT NULL ORDER BY uid, revision_id")
      .all()                                                                                             ;
    if (rows.length === 0) return new Map([...revs].map(([k, s]) => [k, s.size]));
                                                                                                         
    const semanticEq = (a    , b    )          =>
      a.title === b.title &&
      (a.content ?? null) === (b.content ?? null) &&
      (a.summary ?? null) === (b.summary ?? null) &&
      (a.leaves == null || b.leaves == null || arrEq(a.leaves, b.leaves)); // 旧/新格式边界无 after 叶集时不比叶子
    const cur = this.currentByUid();
    let uid = "";
    let chain       = [];
    let seenRevs           = [];
    const flush = ()       => {
      if (chain.length === 0) return;
      const c = cur.get(uid);
      let after            = c ? { title: c.meta.title, content: c.meta.content, summary: c.meta.summary, leaves: c.leaves.map((l) => l.text) } : null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const b = chain[i] ;
        if (after == null || !semanticEq(b, after)) addRev(uid, seenRevs[i] );
        after = b;
      }
      chain = [];
      seenRevs = [];
    };
    for (const r of rows) {
      if (r.uid !== uid) {
        flush();
        uid = r.uid;
      }
      seenRevs.push(r.revision_id);
      const m = JSON.parse(r.before)                 ;
      chain.push({ title: m.title, content: m.content, summary: m.summary, leaves: MemoryStore.parseLeavesBlob(r.before_leaves) });
    }
    flush();
    return new Map([...revs].map(([k, s]) => [k, s.size]));
  }

  /** 已删除节点的兑底寻址：按 changes 里记录过的物化路径精确匹配最后一次出现的 uid。 */
  uidByRecordedPath(path        )                {
    const row = this.db
      .prepare("SELECT uid FROM changes WHERE path = ? ORDER BY revision_id DESC LIMIT 1")
      .get(path)                               ;
    return row?.uid ?? null;
  }

  /**
   * 某节点的历史值（新→旧）：叶级行直出（add/update/remove），元数据行出 rename/note/summary/move。
   * update 的新值列在其写入版本，旧值仍在它自己的写入版本可见——同 uid 链即「这条事实的演变」。
   * restore 行（旧格式迁移产物）不展示：历史快照无法拆出真实增删。
   */
  /** 安全解析 before_leaves blob：非数组/坏 JSON 一律返回 null（读取层容错，等价无 blob）。 */
          static parseLeavesBlob(s               )                  {
    if (s == null) return null;
    try {
      const v = JSON.parse(s)           ;
      return Array.isArray(v) ? (v            ) : null;
    } catch {
      return null;
    }
  }

  listNodeHistory(uid        )               {
    const nodeRows = this.db
      .prepare(
        `SELECT c.revision_id AS rev, c.path AS path, c.deleted AS deleted, c.before AS before, c.before_leaves AS before_leaves,
                r.op AS rev_op, r.detail AS rev_detail, r.created_at AS created_at
         FROM changes c JOIN revisions r ON r.id = c.revision_id
         WHERE c.uid = ? ORDER BY c.revision_id ASC`,
      )
      .all(uid)           
                  
                   
                      
                            
                                   
                     
                                
                         
      ;
    const leafRows = this.db
      .prepare(
        `SELECT lc.revision_id AS rev, lc.kind AS kind, lc.before_text AS before_text, lc.after_text AS after_text,
                r.op AS rev_op, r.detail AS rev_detail, r.created_at AS created_at
         FROM leaf_changes lc JOIN revisions r ON r.id = lc.revision_id
         WHERE lc.node_uid = ?
         /* DSH 修正：leaf_uid 是随机 uuid，同一版本内的行序会随它抖动；先按文本定序 */
         ORDER BY lc.revision_id ASC, lc.before_ord ASC, lc.after_text ASC, lc.before_text ASC, lc.leaf_uid ASC`,
      )
      .all(uid)           
                  
                   
                                 
                                
                     
                                
                         
      ;
    if (nodeRows.length === 0 && leafRows.length === 0) return [];
    const curNode = this.currentByUid().get(uid) ?? null;
    const current = curNode?.meta ?? null;
    const currentLeaves = curNode?.leaves.map((l) => l.text) ?? null;
                                                                                               
    const out               = [];
    const emit = (m      , op        , value               )       => {
      out.push({ revisionId: m.rev, revOp: m.rev_op, revDetail: m.rev_detail, createdAt: m.created_at, op, value });
    };
    const leavesByRev = new Map                         ();
    for (const l of leafRows) {
      const arr = leavesByRev.get(l.rev) ?? [];
      arr.push(l);
      leavesByRev.set(l.rev, arr);
    }
    for (let i = 0; i < nodeRows.length; i++) {
      const r = nodeRows[i] ;
      const b                       = r.before == null ? null : (JSON.parse(r.before)                 );
      const bLeaves                  = MemoryStore.parseLeavesBlob(r.before_leaves);
      const nextRow = nodeRows[i + 1];
      const a                       = nextRow
        ? nextRow.before == null
          ? null
          : (JSON.parse(nextRow.before)                 )
        : current;
      const aLeaves                  = nextRow
        ? nextRow.before == null
          ? null
          : nextRow.before_leaves == null
            ? null
            : (MemoryStore.parseLeavesBlob(nextRow.before_leaves)            )
        : currentLeaves;
      if (bLeaves != null) {
        // 旧格式行：快照级 set-diff（叶级身份是迁移后才有的）
        if (b == null || a == null) continue;
        if (aLeaves != null) {
          const oldSet = new Set(bLeaves);
          const newSet = new Set(aLeaves);
          for (const leaf of aLeaves) if (!oldSet.has(leaf)) emit(r, "add", leaf);
          for (const leaf of bLeaves) if (!newSet.has(leaf)) emit(r, "remove", null);
        }
        if (a.title !== b.title) emit(r, "rename", a.title);
        if ((a.content ?? null) !== (b.content ?? null)) emit(r, "note", a.content);
        if ((a.summary ?? null) !== (b.summary ?? null)) emit(r, "summary", a.summary);
        if (a.parentUid !== b.parentUid || a.ord !== b.ord) emit(r, "move", null);
        continue;
      }
      for (const l of leavesByRev.get(r.rev) ?? []) {
        if (l.kind === "restore") continue;
        if (l.kind === "add") emit(l, "add", l.after_text);
        else if (l.kind === "update") emit(l, "update", l.after_text);
        else emit(l, "remove", null);
      }
      if (b == null) {
        if (a == null) continue;
        emit(r, "add-node", a.title);
        if (a.content != null) emit(r, "note", a.content);
        if (a.summary != null) emit(r, "summary", a.summary);
        continue;
      }
      if (a == null) {
        emit(r, "delete", null);
        continue;
      }
      if (a.title !== b.title) emit(r, "rename", a.title);
      if ((a.content ?? null) !== (b.content ?? null)) emit(r, "note", a.content);
      if ((a.summary ?? null) !== (b.summary ?? null)) emit(r, "summary", a.summary);
      if (a.parentUid !== b.parentUid || a.ord !== b.ord || b.leafOrder != null) emit(r, "move", null);
    }
    // 只有叶级行、没有节点行的版本（纯叶子增删改）
    const nodeRevs = new Set(nodeRows.map((r) => r.rev));
    for (const [rev, ls] of leavesByRev) {
      if (nodeRevs.has(rev)) continue;
      for (const l of ls) {
        if (l.kind === "restore") continue;
        if (l.kind === "add") emit(l, "add", l.after_text);
        else if (l.kind === "update") emit(l, "update", l.after_text);
        else emit(l, "remove", null);
      }
    }
    return out.reverse(); // 新→旧
  }

  listRevisions(
    limit = 20,
  )                                                                                                                  {
    const rows = this.db
      .prepare("SELECT id, op, path, actor, detail, created_at FROM revisions ORDER BY id DESC LIMIT ?")
      .all(limit)           
                 
                 
                          
                    
                            
                        
      ;
    return rows.map((r) => ({
      id: r.id,
      op: r.op,
      path: r.path,
      actor: r.actor,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /** 写入一次变更的 undo 行：节点元数据行 + 叶级行。 */
  recordChanges(revisionId        , delta           )       {
    if (delta.nodes.length === 0 && delta.leaves.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO changes(revision_id, uid, path, deleted, before) VALUES (?, ?, ?, ?, ?)",
    );
    const stmtLeaf = this.db.prepare(
      "INSERT OR REPLACE INTO leaf_changes(revision_id, leaf_uid, node_uid, path, kind, before_text, after_text, before_node_uid, before_ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const e of delta.nodes) {
        stmt.run(revisionId, e.uid, e.path, e.deleted ? 1 : 0, e.before == null ? null : JSON.stringify(e.before));
      }
      for (const e of delta.leaves) {
        stmtLeaf.run(revisionId, e.leafUid, e.nodeUid, e.path, e.kind, e.beforeText, e.afterText, e.beforeNodeUid, e.beforeOrd);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 记录一次变更：时间线行 + undo 行（节点元数据 + 叶级）。 */
  commitRevision(
    op        ,
    path               ,
    detail               ,
    delta           ,
    actor = "pi",
  )         {
    const rev = this.recordRevision(op, path, detail, actor);
    this.recordChanges(rev, delta);
    return rev;
  }

  /** 当前节点的 uid 索引（uid → 路径 + 元数据 + 叶子列表）。 */
          currentByUid()                       {
    const nodeRows = this.db
      .prepare("SELECT id, uid, parent_id, ord, title, path, content, summary, summary_hash FROM nodes")
      .all()           
                 
                  
                               
                  
                    
                   
                             
                             
                                  
      ;
    const leafRows = this.db
      .prepare("SELECT node_id, uid, ord, text FROM leaves ORDER BY node_id, ord, id")
      .all()                                                                             ;
    const leavesByNode = new Map                                                           ();
    for (const l of leafRows) {
      const arr = leavesByNode.get(l.node_id) ?? [];
      arr.push({ uid: l.uid ?? randomUUID(), text: l.text, ord: l.ord });
      leavesByNode.set(l.node_id, arr);
    }
    const uidById = new Map                ();
    for (const r of nodeRows) uidById.set(r.id, r.uid);
    const map = new Map                 ();
    for (const r of nodeRows) {
      map.set(r.uid, {
        path: r.path,
        meta: {
          title: r.title,
          content: r.content,
          summary: r.summary,
          summaryHash: r.summary_hash,
          parentUid: r.parent_id == null ? null : (uidById.get(r.parent_id) ?? null),
          ord: r.ord,
        },
        leaves: leavesByNode.get(r.id) ?? [],
      });
    }
    return map;
  }

  /** undo 行（uid 空间）：节点元数据行（含旧格式 before_leaves blob）+ 叶级行，均按版本降序。 */
          undoRows(afterRevision        )                                                  {
    return {
      nodes: this.db
        .prepare("SELECT revision_id, uid, path, deleted, before, before_leaves FROM changes WHERE revision_id > ? ORDER BY revision_id DESC, uid")
        .all(afterRevision)                 ,
      leaves: this.db
        .prepare(
          "SELECT revision_id, leaf_uid, node_uid, kind, before_text, before_node_uid, before_ord FROM leaf_changes WHERE revision_id > ? ORDER BY revision_id DESC, leaf_uid",
        )
        .all(afterRevision)                 ,
    };
  }

  /** 回放起点：当前态（节点元数据索引 + 叶子表），尚无旧格式 blob。 */
          startReplay()              {
    const nodes = this.currentByUid();
    const leafMap = new Map                  ();
    for (const [uid, u] of nodes) for (const l of u.leaves) leafMap.set(l.uid, { nodeUid: uid, ord: l.ord, text: l.text });
    return { nodes, leafMap, legacyLeaves: new Map() };
  }

  /** revision_id > id 的 undo 行按版本分桶。 */
          undoBuckets(id        )                          {
    const { nodes: nodeRows, leaves: leafRows } = this.undoRows(id);
    const byRev = new Map                    ();
    const bucket = (rev        )             => {
      let b = byRev.get(rev);
      if (!b) {
        b = { leaves: [], nodes: [] };
        byRev.set(rev, b);
      }
      return b;
    };
    for (const l of leafRows) bucket(l.revision_id).leaves.push(l);
    for (const r of nodeRows) bucket(r.revision_id).nodes.push(r);
    return byRev;
  }

  /**
   * 撤销一个版本的行（一个桶）：先叶级行（集合/文本），后节点行（元数据/重排/删除）。
   * 撤销完 revision 之后，工作态即「revision - 1 落盘后」的树。
   */
          undoRevision(state             , bkt            )       {
    const { nodes, leafMap, legacyLeaves } = state;
    const restores                = [];
    for (const l of bkt.leaves) {
      if (l.kind === "add") leafMap.delete(l.leaf_uid);
      else if (l.kind === "update") {
        const e = leafMap.get(l.leaf_uid);
        if (e && l.before_text != null) e.text = l.before_text;
      } else restores.push(l);
    }
    if (restores.length > 0) {
      // DSH 修正：before_ord 是「本版本写入前」叶子数组的下标。只有当该节点现存叶子的 ord 恰好是
      // 写入后数组的稠密下标（0..n-1）时，按 before_ord 腾位插入才能还原原顺序；撤销 add
      // 会留下空档，所以先把涉及的节点重新编号，再按 before_ord 升序插回。
      const touched = new Set(restores.map((l) => l.before_node_uid ?? l.node_uid));
      const byNode = new Map                                             ();
      for (const [uid, e] of leafMap) {
        if (!touched.has(e.nodeUid)) continue;
        const arr = byNode.get(e.nodeUid);
        if (arr) arr.push({ uid, ord: e.ord });
        else byNode.set(e.nodeUid, [{ uid, ord: e.ord }]);
      }
      for (const arr of byNode.values()) {
        arr.sort((x, y) => x.ord - y.ord || (x.uid < y.uid ? -1 : 1));
        arr.forEach((x, i) => {
          leafMap.get(x.uid) .ord = i;
        });
      }
      restores.sort((x, y) => (x.before_ord ?? 0) - (y.before_ord ?? 0));
      for (const l of restores) {
        const nu = l.before_node_uid ?? l.node_uid;
        const o = l.before_ord ?? 0;
        for (const e of leafMap.values()) if (e.nodeUid === nu && e.ord >= o) e.ord++; // 腾出原序位
        leafMap.set(l.leaf_uid, { nodeUid: nu, ord: o, text: l.before_text ?? "" });
      }
    }
    for (const r of bkt.nodes) {
      if (r.before == null) {
        nodes.delete(r.uid);
        for (const [k, v] of leafMap) if (v.nodeUid === r.uid) leafMap.delete(k);
        legacyLeaves.delete(r.uid);
      } else {
        const meta = JSON.parse(r.before)                 ;
        const order = meta.leafOrder;
        delete meta.leafOrder;
        nodes.set(r.uid, { path: r.path, meta, leaves: [] });
        const lb = MemoryStore.parseLeavesBlob(r.before_leaves);
        if (lb != null) {
          // 旧格式行：blob 即该版本前的全量叶子（拆不出叶级 diff，整体替换）
          for (const [k, v] of leafMap) if (v.nodeUid === r.uid) leafMap.delete(k);
          legacyLeaves.set(r.uid, lb);
        } else {
          legacyLeaves.delete(r.uid);
          if (order) {
            let ord = 0;
            for (const lu of order) {
              const e = leafMap.get(lu);
              if (e && e.nodeUid === r.uid) e.ord = ord++;
            }
          }
        }
      }
    }
  }

  /**
   * 从当前态逐版本回放，路过每个目标版本时回调一次；回调拿到的 state 即「该版本落盘后」的
   * 工作态（随后继续被改写，要用就当场拷走）。迁移要核对上千个版本时，一趟回放代替
   * 上千次 materializeTree。
   *
   * DSH 新增。
   */
          walkBack(targets          , visit                                            )       {
    if (targets.length === 0) return;
    const state = this.startReplay();
    const byRev = this.undoBuckets(Math.min(...targets));
    const pending = [...new Set(targets)].sort((x, y) => y - x);
    let i = 0;
    // 还没撤销任何行：等于最高带行版本落盘后的状态（比它更高的版本之间没有行，状态相同）
    const top = Math.max(...byRev.keys());
    while (i < pending.length && pending[i]  >= top) visit(pending[i++] , state);
    for (const rev of [...byRev.keys()].sort((x, y) => y - x)) {
      // 撤销 rev 之前：state 等于 rev 落盘后；到上一个（更高的）带行版本之间没有行，状态相同
      while (i < pending.length && pending[i]  >= rev) visit(pending[i++] , state);
      this.undoRevision(state, byRev.get(rev) );
    }
    while (i < pending.length) visit(pending[i++] , state);
  }

  /**
   * 回放工作态里某节点的叶子（按序位；旧格式 blob 的叶子带 `legacy:` 身份）。
   * 节点不存在返回 null。
   */
          slotsOf(state             , uid        )                                              {
    if (!state.nodes.has(uid)) return null;
    const blob = state.legacyLeaves.get(uid);
    if (blob) return blob.map((text, i) => ({ uid: `legacy:${uid}:${i}`, text }));
    return [...state.leafMap.entries()]
      .filter(([, v]) => v.nodeUid === uid)
      .sort((x, y) => x[1].ord - y[1].ord || (x[0] < y[0] ? -1 : 1))
      .map(([k, v]) => ({ uid: k, text: v.text }));
  }

  /** 从 uid 索引重建内存树（子节点按 ord；叶子按 ord，带 uid 身份；旧格式节点用 blob 全量）。 */
          treeFromUid(state             )             {
    const { nodes } = state;
    const childrenOf = new Map                                            ();
    let root                                     = null;
    for (const [uid, u] of nodes) {
      if (u.meta.parentUid == null) {
        root = { uid, u };
      } else {
        const arr = childrenOf.get(u.meta.parentUid) ?? [];
        arr.push({ uid, u });
        childrenOf.set(u.meta.parentUid, arr);
      }
    }
    if (!root) throw new Error("版本物化失败：找不到根节点");
    const build = (uid        , u         )             => {
      const kids = (childrenOf.get(uid) ?? []).sort((a, b) => a.u.meta.ord - b.u.meta.ord);
      const ls = this.slotsOf(state, uid) ?? [];
      return {
        uid,
        title: u.meta.title,
        leaves: ls.map((l) => l.text),
        leafUids: ls.map((l) => l.uid),
        content: u.meta.content,
        summary: u.meta.summary,
        summaryHash: u.meta.summaryHash,
        children: kids.map((k) => build(k.uid, k.u)),
      };
    };
    return build(root.uid, root.u);
  }

  /**
   * 物化某版本的整树（不存在返回 null）。
   * 当前态出发，撤销 revision_id > target 的行（降序）：叶级行回放叶子集合/文本，
   * 节点行回放元数据与重排（leafOrder）；删除行恢复节点及其叶子。
   */
  materializeTree(id        )                    {
    if (!this.revisionExists(id)) return null;
    const state = this.startReplay();
    const byRev = this.undoBuckets(id);
    // DSH 修正：回放必须严格按版本降序。Map 的插入序会先走完所有带叶级行的版本、再走只有节点行的
    // 版本，直接迭代会让「只有节点行」的低版本晚于高版本的叶级行回放。
    for (const rev of [...byRev.keys()].sort((x, y) => y - x)) this.undoRevision(state, byRev.get(rev) );
    return this.treeFromUid(state);
  }

  /**
   * 旧格式 before_leaves blob → 叶级行回填（一次性迁移，事务内自校验，失败整体回滚）。
   * 链式穿线：按节点分组升序走 blob 链，多重集 diff 出逐版本 add/remove；
   * add 的 uid 优先收养「末态重放」里同文本的未认领 uid，收养不到新发；
   * remove 的 uid 消耗该文本的链内存活身份（与引入它的 add 配对，保证回放可逆）。
   * 校验：清 blob 后重放，节点在每行版本之前的叶集（多重集）必须还原为原 blob。
   */
          backfillLegacyLeaves(
    legacyRows                                                                                  ,
  )       {
                                                                                    
    const byUid = new Map                    ();
    const parsed             = [];
    for (const r of legacyRows) {
      let leaves          ;
      try {
        const v = JSON.parse(r.before_leaves)           ;
        if (!Array.isArray(v)) continue;
        leaves = v.map((t) => String(t));
      } catch {
        continue; // 坏行保留 blob，读取层走旧兜底
      }
      const row      = { revision_id: r.revision_id, uid: r.uid, path: r.path, leaves };
      parsed.push(row);
      let arr = byUid.get(r.uid);
      if (!arr) {
        arr = [];
        byUid.set(r.uid, arr);
      }
      arr.push(row);
    }
    if (parsed.length === 0) return;
                
                         
                      
                      
                   
                             
                                
                               
                               
      
    const inserts             = [];
    // 末态：链最后一行 legacy 之后的真实状态（携带真实 uid）。各链末态一趟回放取齐。
    const chainsEndingAt = new Map                  ();
    for (const [uid, chain] of byUid) {
      const rev = chain[chain.length - 1] .revision_id;
      const arr = chainsEndingAt.get(rev);
      if (arr) arr.push(uid);
      else chainsEndingAt.set(rev, [uid]);
    }
    const ends = new Map                                              ();
    this.walkBack([...chainsEndingAt.keys()], (asOf, state) => {
      for (const uid of chainsEndingAt.get(asOf) ?? []) ends.set(uid, this.slotsOf(state, uid) ?? []);
    });
    for (const [uid, chain] of byUid) {
      const end = ends.get(uid) ?? [];
      const endTexts = end.map((s) => s.text);
      // 未认领池：末态 text → uid 队列（链内 add 优先收养）
      const pool = new Map                  ();
      for (const s of end) {
        const q = pool.get(s.text) ?? [];
        q.push(s.uid);
        pool.set(s.text, q);
      }
      // 链内存活身份：text → uid 队列（remove 消耗，与引入它的 add 配对）
      const live = new Map                  ();
      for (let i = 0; i < chain.length; i++) {
        const cur = chain[i] ;
        const after = i + 1 < chain.length ? chain[i + 1] .leaves : endTexts;
        // 多重集匹配：match(t) = min(前后出现次数)；两侧超出部分即 remove/add
        const afterCount = new Map                ();
        for (const t of after) afterCount.set(t, (afterCount.get(t) ?? 0) + 1);
        const beforeCount = new Map                ();
        for (const t of cur.leaves) beforeCount.set(t, (beforeCount.get(t) ?? 0) + 1);
        const match = new Map                ();
        for (const [t, c] of beforeCount) match.set(t, Math.min(c, afterCount.get(t) ?? 0));
        const seenBefore = new Map                ();
        for (let j = 0; j < cur.leaves.length; j++) {
          const t = cur.leaves[j] ;
          const kb = seenBefore.get(t) ?? 0;
          seenBefore.set(t, kb + 1);
          if (kb < (match.get(t) ?? 0)) continue; // 存活（第 kb 次出现 < 匹配配额）：无行
          const q = live.get(t);
          const leafUid = q && q.length > 0 ? q.shift()  : randomUUID();
          inserts.push({ revisionId: cur.revision_id, leafUid, nodeUid: uid, path: cur.path, kind: "remove", beforeText: t, afterText: null, beforeOrd: j });
        }
        const seen = new Map                ();
        for (const t of after) {
          const k = seen.get(t) ?? 0;
          seen.set(t, k + 1);
          if (k < (match.get(t) ?? 0)) continue; // 存活：无行
          const pq = pool.get(t);
          const leafUid = pq && pq.length > 0 ? pq.shift()  : randomUUID();
          const lq = live.get(t) ?? [];
          lq.push(leafUid);
          live.set(t, lq);
          inserts.push({ revisionId: cur.revision_id, leafUid, nodeUid: uid, path: cur.path, kind: "add", beforeText: null, afterText: t, beforeOrd: null });
        }
      }
    }
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO leaf_changes(revision_id, leaf_uid, node_uid, path, kind, before_text, after_text, before_node_uid, before_ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const clr = this.db.prepare("UPDATE changes SET before_leaves = NULL WHERE revision_id = ? AND uid = ?");
    this.db.exec("BEGIN");
    try {
      for (const x of inserts)
        ins.run(x.revisionId, x.leafUid, x.nodeUid, x.path, x.kind, x.beforeText, x.afterText, x.kind === "remove" ? x.nodeUid : null, x.beforeOrd);
      for (const r of parsed) clr.run(r.revision_id, r.uid);
      // 校验：清 blob 后重放，每个节点的版本前叶集（多重集）应还原为原 blob（一趟回放逐版本比对）
      const before = new Map               ();
      for (const r of parsed) {
        if (r.revision_id <= 1 || !this.revisionExists(r.revision_id - 1)) continue;
        const arr = before.get(r.revision_id - 1);
        if (arr) arr.push(r);
        else before.set(r.revision_id - 1, [r]);
      }
      this.walkBack([...before.keys()], (asOf, state) => {
        for (const r of before.get(asOf) ?? []) {
          const slots = this.slotsOf(state, r.uid);
          if (slots == null) continue; // 该版本前节点尚未创建（创建行在更低版本），无从比对
          const got = slots.map((s) => s.text).sort().join("\u0001");
          const want = [...r.leaves].sort().join("\u0001");
          if (got !== want)
            throw new Error(`legacy backfill 校验失败：#${r.revision_id} ${r.path} 重放叶集与原快照不符`);
        }
      });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }


  /** 某版本是否存在。 */
          revisionExists(id        )          {
    return this.db.prepare("SELECT 1 AS x FROM revisions WHERE id = ?").get(id) != null;
  }

  /**
   * 给没有叶级行的建节点行补上初始叶子（add 行，身份取自该版本的物化态）。
   *
   * 旧格式只有节点快照，建节点那一版没有叶级 undo 行；迁移后 listChanges / listNodeHistory
   * 对这一版只剩 add-node，看不到建节点时写了什么。物化「建节点那一版」即得当时的叶子与
   * 叶子身份：后来仍存活的叶子拿到真实 uid（撤销 add 即删掉它），后来被删的叶子拿到的是
   * remove 行回放时插回的身份（与那条 remove 行天然配对）。
   *
   * DSH 新增。每次打开都查一遍：新格式原生的建节点行自带叶级行，不会被命中，所以通常
   * 一趟只读回放后什么都不写；旧代码交替写入留下的建节点行则在下一次打开时补齐。
   * 仍留有 blob 的库不跑（物化态里的 `legacy:` 身份不是真实叶子）。
   * 事务内自校验，失败整体回滚，不阻断打开。
   */
          backfillCreationLeaves()       {
    const blobs = (this.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE before_leaves IS NOT NULL").get()                 ).n;
    if (blobs > 0) return;
                                              
                                                                                                                           
    const candidates = this.db
      .prepare(
        `SELECT c.revision_id AS revision_id, c.uid AS uid, c.path AS path FROM changes c
         WHERE c.before IS NULL AND NOT EXISTS (
           SELECT 1 FROM leaf_changes lc WHERE lc.revision_id = c.revision_id AND lc.node_uid = c.uid
         )`,
      )
      .all()               ;
    if (candidates.length === 0) return;
    // 一趟回放：记下每个建节点行「当时」的叶子，以及它的前一版节点是否已存在
    const survey = ()       => {
      const createdAt = new Map                     ();
      const beforeAt = new Map                     ();
      const targets           = [];
      for (const c of candidates) {
        c.atCreation = null;
        c.existedBefore = false;
        const a = createdAt.get(c.revision_id);
        if (a) a.push(c);
        else createdAt.set(c.revision_id, [c]);
        targets.push(c.revision_id);
        if (c.revision_id > 1 && this.revisionExists(c.revision_id - 1)) {
          const b = beforeAt.get(c.revision_id - 1);
          if (b) b.push(c);
          else beforeAt.set(c.revision_id - 1, [c]);
          targets.push(c.revision_id - 1);
        }
      }
      this.walkBack(targets, (asOf, state) => {
        for (const c of createdAt.get(asOf) ?? []) c.atCreation = this.slotsOf(state, c.uid);
        for (const c of beforeAt.get(asOf) ?? []) c.existedBefore = state.nodes.has(c.uid);
      });
    };
    survey();
    const plans                                         = [];
    for (const c of candidates) {
      if (!c.atCreation || c.atCreation.length === 0) continue;
      // 建节点那一版之前节点必然不存在；存在说明这行不是真正的「建节点」，
      // 补 add 行会让更早版本的回放丢叶子
      if (c.existedBefore) continue;
      plans.push({ c, slots: [...c.atCreation] });
    }
    if (plans.length === 0) return;
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO leaf_changes(revision_id, leaf_uid, node_uid, path, kind, before_text, after_text, before_node_uid, before_ord) VALUES (?, ?, ?, ?, 'add', NULL, ?, NULL, NULL)",
    );
    this.db.exec("BEGIN");
    try {
      for (const p of plans) {
        for (const s of p.slots) ins.run(p.c.revision_id, s.uid, p.c.uid, p.c.path, s.text);
      }
      // 校验：补行只影响更早版本的回放；建节点那一版的叶集不变，前一版节点仍不存在
      survey();
      for (const p of plans) {
        const got = p.c.atCreation ? p.c.atCreation.map((s) => s.text).sort().join("\u0001") : null;
        if (got !== p.slots.map((s) => s.text).sort().join("\u0001"))
          throw new Error(`creation backfill 校验失败：#${p.c.revision_id} ${p.c.path} 建节点那一版的叶集被改动`);
        if (p.c.existedBefore)
          throw new Error(`creation backfill 校验失败：#${p.c.revision_id} ${p.c.path} 的前一版出现了该节点`);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 某版本相对上一版本的变更（git log 风格）：叶级行直出 from→to，元数据行走链式对比。 */
          deriveChanges(revisionId        )              {
    const rev = this.db
      .prepare("SELECT id, op, detail, created_at FROM revisions WHERE id = ?")
      .get(revisionId)                                                                                     ;
    if (!rev) return [];
    const rows = this.db
      .prepare("SELECT uid, path, deleted, before, before_leaves FROM changes WHERE revision_id = ? ORDER BY path, uid")
      .all(revisionId)                                                                                                              ;
    const leafRows = this.db
      // DSH 修正：leaf_uid 是随机 uuid，同一版本内的行序会随它抖动；先按文本定序
      .prepare("SELECT leaf_uid, node_uid, path, kind, before_text, after_text FROM leaf_changes WHERE revision_id = ? ORDER BY path, before_ord, after_text, before_text, leaf_uid")
      .all(revisionId)                                                                                                                                    ;
    if (rows.length === 0 && leafRows.length === 0) return [];
    // 该版本的末态元数据：从当前态撤销 revision_id > revisionId 的行（本版本行未撤 → 正是本版本末态）
    const after = this.currentByUid();
    const { nodes: undoNodeRows } = this.undoRows(revisionId);
    for (const r of undoNodeRows) {
      if (r.before == null) after.delete(r.uid);
      else {
        const meta = JSON.parse(r.before)                 ;
        const prev = after.get(r.uid);
        after.set(r.uid, { path: r.path, meta, leaves: prev?.leaves ?? [] });
      }
    }
    const curAll = this.currentByUid();
    const out              = [];
    const push = (op        , path        , uid        , from               , to               ) => {
      out.push({
        revisionId,
        revOp: rev.op,
        revDetail: rev.detail,
        op,
        path,
        uid,
        fromText: from,
        toText: to,
        createdAt: rev.created_at,
      });
    };
    for (const l of leafRows) {
      if (l.kind === "restore") continue; // 旧格式快照，无从拆分真实增删
      if (l.kind === "add") push("add", l.path, l.node_uid, null, l.after_text);
      else if (l.kind === "update") push("update", l.path, l.node_uid, l.before_text, l.after_text);
      else push("remove", l.path, l.node_uid, l.before_text, null);
    }
    for (const r of rows) {
      if (r.before == null) {
        const a = after.get(r.uid);
        if (!a) continue;
        push("add-node", a.path, r.uid, null, a.meta.title);
        continue;
      }
      const b = JSON.parse(r.before)                 ;
      const bLeaves = MemoryStore.parseLeavesBlob(r.before_leaves);
      if (r.deleted) {
        push("remove-node", r.path, r.uid, b.title, null);
        if (bLeaves) for (const leaf of bLeaves) push("remove", r.path, r.uid, leaf, null);
        continue;
      }
      const a = after.get(r.uid);
      if (!a) continue;
      if (bLeaves != null) {
        // 旧格式行：与末态叶集 set-diff（末态 = 下一版 blob 或当前真实叶集）
        const nextRow = this.db
          .prepare("SELECT before_leaves FROM changes WHERE uid = ? AND revision_id > ? ORDER BY revision_id ASC LIMIT 1")
          .get(r.uid, revisionId)                                                ;
        const aL = nextRow
          ? nextRow.before_leaves == null
            ? null
            : (MemoryStore.parseLeavesBlob(nextRow.before_leaves)            )
          : (curAll.get(r.uid)?.leaves.map((l) => l.text) ?? null);
        if (aL != null) {
          const oldSet = new Set(bLeaves);
          const newSet = new Set(aL);
          for (const leaf of aL) if (!oldSet.has(leaf)) push("add", a.path, r.uid, null, leaf);
          for (const leaf of bLeaves) if (!newSet.has(leaf)) push("remove", a.path, r.uid, leaf, null);
        }
      }
      if (a.meta.title !== b.title) push("rename", r.path, r.uid, b.title, a.meta.title);
      if ((a.meta.content ?? null) !== (b.content ?? null)) push("note-content", a.path, r.uid, null, null);
      if ((a.meta.summary ?? null) !== (b.summary ?? null)) push("note-summary", a.path, r.uid, null, null);
      if (a.meta.parentUid !== b.parentUid || a.meta.ord !== b.ord || b.leafOrder != null) push("move", a.path, r.uid, null, null);
    }
    return out;
  }
  listChanges(opts                                          = {})              {
    const limit = opts.limit ?? 50;
    if (opts.revisionId != null) return this.deriveChanges(opts.revisionId);
    const revs = this.db
      .prepare("SELECT id FROM revisions ORDER BY id DESC LIMIT ?")
      .all(Math.max(limit * 2, 50))                         ;
    const out              = [];
    for (const r of revs) {
      const rows = this.deriveChanges(r.id);
      // 预算不足时按整版本取舍：不截断半版本（避免 add 先入 remove 被吞的不对称）；首版本允许溢出。
      if (out.length > 0 && out.length + rows.length > limit) break;
      out.push(...rows.slice(0, Math.max(limit, 12))); // 单版本行数防爆（子树删除等）
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------- 原始证据（episodes / evidence） ----------

  appendEpisodes(
    rows                                                                                                                        ,
  )           {
    if (rows.length === 0) return [];
    const stmt = this.db.prepare(
      "INSERT INTO episodes(session_id, seq, role, kind, text, tool_name) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const ids           = [];
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const info = stmt.run(r.sessionId ?? null, r.seq ?? 0, r.role, r.kind, r.text, r.toolName ?? null);
        ids.push(Number(info.lastInsertRowid));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return ids;
  }

  listEpisodes(opts                                                           = {})            {
    const limit = opts.limit ?? 50;
    const clauses           = [];
    const params                         = [];
    if (opts.sessionId) {
      clauses.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.sinceId != null) {
      clauses.push("id > ?");
      params.push(opts.sinceId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, session_id, seq, role, kind, text, tool_name, created_at FROM episodes ${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit)           
                 
                                
                  
                   
                   
                   
                               
                         
      ;
    return rows.reverse().map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      kind: r.kind,
      text: r.text,
      toolName: r.tool_name,
      createdAt: r.created_at,
    }));
  }

  countEpisodes()         {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM episodes").get()                 ;
    return row.n;
  }

  /** 保留最新 keep 条，返回删除条数（关联 evidence 随外键级联删除）。 */
  pruneEpisodes(keep        )         {
    const before = this.countEpisodes();
    const k = Math.max(0, Math.floor(keep));
    if (before <= k) return 0;
    this.db.exec(
      `DELETE FROM episodes WHERE id NOT IN (SELECT id FROM episodes ORDER BY id DESC LIMIT ${k})`,
    );
    return before - this.countEpisodes();
  }

  /** 按本地日历日聚合：sessions（episodes 分组）+ 动过的节点（changes 聚合到前 3 层路径）+ 素材水位。 */
  dayDigest(date        )            {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
    // 当地日历日的 UTC 边界（created_at 存 UTC）。用可索引的区间比较代替
    // date(col,'localtime')=…（函数谓词吃不上 idx_episodes_created_at，episodes
    // 只增不减，量上去后全表扫逐行求值 date() 会劣化到几百 ms）。
    // 边界 = 当地零点 + 24h；无 DST 时区（如东八区）与 SQLite localtime 语义完全等价。
    const start = new Date(`${date}T00:00:00`); // 无时区后缀 = 本地时间
    const end = new Date(start.getTime() + 86_400_000);
    const pad = (n        )         => String(n).padStart(2, "0");
    const utcStr = (d      )         =>
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const day = (col        ) => `${col} >= '${utcStr(start)}' AND ${col} < '${utcStr(end)}'`; // date 已过正则校验
    const sessions = (
      this.db
        .prepare(
          `SELECT session_id AS sid, COUNT(*) AS events,
                  SUM(CASE WHEN kind='tool_result' THEN 1 ELSE 0 END) AS tools,
                  SUM(CASE WHEN kind='assistant' THEN 1 ELSE 0 END) AS replies,
                  MIN(CASE WHEN kind='user' THEN text END) AS firstUser
           FROM episodes WHERE ${day("created_at")} GROUP BY session_id ORDER BY MIN(id)`,
        )
        .all()                                                                                                           
    ).map((r) => ({
      sessionId: r.sid,
      events: r.events,
      tools: r.tools,
      replies: r.replies,
      firstUser: r.firstUser?.slice(0, 80) ?? null,
      userSamples: (
        this.db
          .prepare(
            `SELECT text FROM episodes WHERE ${day("created_at")} AND kind='user' AND session_id IS ? ORDER BY id LIMIT 3`,
          )
          .all(r.sid)                           
      ).map((x) => x.text.slice(0, 100)),
    }));
    const touchedRows = this.db
      .prepare(
        `SELECT c.path AS path FROM changes c
         JOIN revisions r ON r.id = c.revision_id
         WHERE ${day("r.created_at")}`,
      )
      .all()                           ;
    // 精确路径分组，再只保留最深路径（中间祖先节点的创建行折叠进后代，一次逻辑写入不出多条）
    const exact = new Map                ();
    for (const t of touchedRows) exact.set(t.path, (exact.get(t.path) ?? 0) + 1);
    const paths = [...exact.keys()];
    const nodes = paths
      .filter((p) => !paths.some((q) => q.startsWith(p + "/")))
      .map((p) => ({ path: p, ops: exact.get(p)  }))
      .sort((a, b) => b.ops - a.ops);
    const maxId = (table        ) =>
      (this.db.prepare(`SELECT MAX(id) AS m FROM ${table} WHERE ${day(table === "episodes" ? "created_at" : "created_at")}`).get()                        ).m ?? 0;
    return {
      date,
      sessions,
      nodes,
      watermark: { maxEpisodeId: maxId("episodes"), maxRevisionId: maxId("revisions") },
      empty: sessions.length === 0 && touchedRows.length === 0,
    };
  }

  linkEvidence(nodePath        , leafHashValue        , episodeIds          )       {
    if (episodeIds.length === 0) return;
    const stmt = this.db.prepare("INSERT INTO evidence(node_path, leaf_hash, episode_id) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const id of episodeIds) stmt.run(nodePath, leafHashValue, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  evidenceFor(nodePath        , leafHashValue         )                {
    const rows = (
      leafHashValue
        ? this.db
            .prepare(
              "SELECT node_path, leaf_hash, episode_id FROM evidence WHERE node_path = ? AND leaf_hash = ? ORDER BY episode_id",
            )
            .all(nodePath, leafHashValue)
        : this.db
            .prepare("SELECT node_path, leaf_hash, episode_id FROM evidence WHERE node_path = ? ORDER BY episode_id")
            .all(nodePath)
    )                                                                       ;
    return rows.map((r) => ({ nodePath: r.node_path, leafHash: r.leaf_hash, episodeId: r.episode_id }));
  }

  /** 按 id 批量取 episode（保持入参顺序去重后的升序）。 */
  getEpisodes(ids          )            {
    const uniq = [...new Set(ids)].filter((n) => Number.isInteger(n));
    if (uniq.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, seq, role, kind, text, tool_name, created_at FROM episodes WHERE id IN (${uniq.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...uniq)           
                 
                                
                  
                   
                   
                   
                               
                         
      ;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      kind: r.kind,
      text: r.text,
      toolName: r.tool_name,
      createdAt: r.created_at,
    }));
  }

  close()       {
    this.db.close();
  }
}
