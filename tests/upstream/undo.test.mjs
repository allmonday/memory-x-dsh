/**
 * Ported from memory-x packages/core/tests/undo.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryFile } from "../../core/memory-file.js";
import { enumerateNodePaths } from "../../core/path.js";
                                                  

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-undo-"));
}

function findUid(root            , path        )                     {
  return enumerateNodePaths(root).find((x) => x.path === path)?.node.uid;
}

function paths(mf            )           {
  return enumerateNodePaths(mf.root).map((x) => x.path);
}

test("uid 稳定：移动保留节点身份，changes 记为 move 而非删建", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("A/B", "事实1");
  await mf.upsertNode("D", "事实D");
  const uidB = findUid(mf.root, "A/B");
  assert.ok(uidB);

  const r = await mf.moveNode("A/B", "D");
  assert.equal(findUid(mf.root, "D/B"), uidB, "移动后 uid 不变");

  const rows = mf.listChanges({ revisionId: Number(r.revision) });
  assert.ok(rows.some((c) => c.op === "move" && c.path === "D/B"), "应记录 move");
  assert.ok(!rows.some((c) => c.op === "remove-node" && c.path === "A/B"), "不应记录删建");
});

test("materialize/rollback：同一节点多次修改可逐版本回退并前滚", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  const r1 = await mf.upsertNode("域", "一");
  await mf.upsertNode("域", "二");
  const r3 = await mf.upsertNode("域", "三");

  await mf.restoreRevision(Number(r1.revision));
  assert.deepEqual(mf.readSection("域") .node.leaves, ["一"], "回退到 rev1");

  await mf.restoreRevision(Number(r3.revision));
  assert.deepEqual(mf.readSection("域") .node.leaves, ["一", "二", "三"], "前滚到 rev3");
});

test("回滚跨移动：回到移动前路径，uid 一致", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  const r1 = await mf.upsertNode("A/B", "事实1");
  const uidB = findUid(mf.root, "A/B");
  await mf.upsertNode("D", "事实D");
  await mf.moveNode("A/B", "D");
  assert.equal(findUid(mf.root, "D/B"), uidB);

  await mf.restoreRevision(Number(r1.revision));
  assert.deepEqual(paths(mf), ["A", "A/B"], "回到移动前");
  assert.equal(findUid(mf.root, "A/B"), uidB, "回滚后 uid 不变");
});

test("批量操作：未触碰节点 uid 保留；整批可回滚/前滚", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("工作/乙", "B1");
  const uidY = findUid(mf.root, "工作/乙");
  const rev0 = Number(mf.listRevisions(1)[0] .id);

  const r = await mf.applyOps([
    { op: "add_node", parent: "工作", title: "甲" },
    { op: "add_leaf", path: "工作/甲", leaf: "A1" },
  ]);
  assert.equal(findUid(mf.root, "工作/乙"), uidY, "未触碰节点 uid 保留");
  assert.deepEqual(paths(mf), ["工作", "工作/乙", "工作/甲"]);

  await mf.restoreRevision(rev0);
  assert.deepEqual(paths(mf), ["工作", "工作/乙"], "回滚撤销新增的 甲");
  await mf.restoreRevision(Number(r.revision));
  assert.deepEqual(paths(mf), ["工作", "工作/乙", "工作/甲"], "前滚恢复");
});

test("幂等 restore 到当前版本不产生新版本", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("域", "一");
  const head = mf.listRevisions(1)[0] .id;
  const r = await mf.restoreRevision(head);
  assert.equal(r.changed, false);
  assert.equal(mf.listRevisions(1)[0] .id, head, "不追加版本");
});

test("迁移：旧库整树快照 → uid 回填、历史重置为 baseline、回滚可用", async () => {
  const dir = await tmpDir();
  await mkdir(join(dir, ".memory"), { recursive: true });
  const raw = new DatabaseSync(join(dir, ".memory", "memory.db"));
  raw.exec(`
    CREATE TABLE nodes(id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE, ord INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE, depth INTEGER NOT NULL, content TEXT, summary TEXT, summary_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE leaves(id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, ord INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(path, title, body, tokenize='trigram');
    CREATE TABLE access(path TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, path TEXT, actor TEXT NOT NULL DEFAULT 'pi', created_at TEXT NOT NULL DEFAULT (datetime('now')), tree TEXT NOT NULL);
    CREATE TABLE changes(id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER, op TEXT NOT NULL, path TEXT, from_text TEXT, to_text TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  const tree             = { title: "Memory", leaves: [], children: [{ title: "工作", leaves: ["旧事实"], children: [] }] };
  raw.prepare("INSERT INTO nodes(parent_id,ord,title,path,depth) VALUES (NULL,0,'Memory','',0)").run();
  raw.prepare("INSERT INTO nodes(parent_id,ord,title,path,depth) VALUES (1,0,'工作','工作',1)").run();
  raw.prepare("INSERT INTO leaves(node_id,ord,text) VALUES (2,0,'旧事实')").run();
  raw.prepare("INSERT INTO revisions(op,path,actor,tree) VALUES ('upsert','工作','pi',?)").run(JSON.stringify(tree));
  raw.close();

  const mf = await MemoryFile.open(dir);
  assert.deepEqual(mf.readSection("工作") .node.leaves, ["旧事实"], "旧数据可读");
  assert.equal(mf.listRevisions(10)[0] .op, "baseline", "旧历史丢弃，从 baseline 起");

  const db = new DatabaseSync(join(dir, ".memory", "memory.db"));
  const cols = (db.prepare("PRAGMA table_info(revisions)").all()                           ).map((c) => c.name);
  assert.ok(!cols.includes("tree"), "revisions 不应再有 tree 列");
  const changeCols = (db.prepare("PRAGMA table_info(changes)").all()                           ).map((c) => c.name);
  assert.deepEqual(changeCols, ["revision_id", "uid", "path", "deleted", "before", "before_leaves"], "changes 为新 undo log 结构");
  const nulls = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE uid IS NULL").get()                 ).n;
  assert.equal(nulls, 0, "uid 已回填");
  const distinct = (db.prepare("SELECT COUNT(DISTINCT uid) AS n FROM nodes").get()                 ).n;
  assert.equal(distinct, 2, "uid 唯一");
  db.close();

  // 不存在的版本 id → 回滚报 ok:false；新写入可回滚
  assert.equal((await mf.restoreRevision(999)).ok, false);
  const r = await mf.upsertNode("工作", "新事实");
  assert.deepEqual(mf.readSection("工作") .node.leaves, ["旧事实", "新事实"]);
  await mf.restoreRevision(Number(mf.listRevisions(2)[1] .id));
  assert.deepEqual(mf.readSection("工作") .node.leaves, ["旧事实"], "回滚可用");
  assert.ok(r.revision);
});
