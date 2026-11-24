/**
 * Ported from memory-x packages/core/tests/leaf-changes.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryFile } from "../../core/memory-file.js";
                                                  

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-leaf-"));
}

function rawDb(dir        )               {
  return new DatabaseSync(join(dir, ".memory", "memory.db"));
}

test("叶子变更落 leaf_changes 叶级行：add/update/remove 各自最小记录", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲");
  await mf.updateNode("域/节点", "事实甲", "事实甲改");
  const db = rawDb(dir);
  const rows = db
    .prepare("SELECT kind, before_text, after_text FROM leaf_changes ORDER BY revision_id")
    .all()                                                                                  ;
  db.close();
  assert.equal(rows.length, 2, "一次 add + 一次 update");
  assert.equal(rows[0] .kind, "add");
  assert.equal(rows[0] .after_text, "事实甲");
  assert.equal(rows[1] .kind, "update");
  assert.equal(rows[1] .before_text, "事实甲");
  assert.equal(rows[1] .after_text, "事实甲改");
  // update 是同 uid 链（版本身份不断）
  const db2 = rawDb(dir);
  const uids = db2
    .prepare("SELECT leaf_uid, kind FROM leaf_changes ORDER BY revision_id")
    .all()                                             ;
  db2.close();
  assert.equal(uids[0] .leaf_uid, uids[1] .leaf_uid, "add 与 update 同 leaf uid（supersede 链）");
});

test("undo 体积：巨节点上的叶子追加不再快照全量", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  for (let i = 0; i < 30; i++) await mf.upsertNode("域/巨", `事实${i}`);
  const db1 = rawDb(dir);
  const sizeBefore = (
    db1.prepare("SELECT COALESCE(SUM(LENGTH(COALESCE(before,''))+LENGTH(COALESCE(before_leaves,''))),0) AS b FROM changes").get()                 
  ).b;
  db1.close();
  for (let i = 30; i < 35; i++) await mf.upsertNode("域/巨", `事实${i}`);
  const db2 = rawDb(dir);
  const sizeAfter = (
    db2.prepare("SELECT COALESCE(SUM(LENGTH(COALESCE(before,''))+LENGTH(COALESCE(before_leaves,''))),0) AS b FROM changes").get()                 
  ).b;
  const nodeRows = (db2.prepare("SELECT COUNT(*) AS n FROM changes WHERE before IS NOT NULL").get()                 ).n;
  db2.close();
  // 旧格式下每次 upsert 会落一份全量快照（30+ 叶 → 每份数 KB）；新格式叶子变更不落节点行
  assert.ok(sizeAfter - sizeBefore <= 64, `节点 undo 体积几乎不增长（Δ=${sizeAfter - sizeBefore}）`);
  assert.equal(nodeRows, 0, "纯叶子变更不产生节点 before 行");
});

test("回滚：叶子 update/remove 后可精确恢复（含顺序）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "一");
  const revA = Number((await mf.upsertNode("域", "二")).revision);
  await mf.updateNode("域", "二", "二改");
  await mf.upsertNode("域", "三");
  await mf.restoreRevision(revA);
  assert.deepEqual(mf.readSection("域") .node.leaves, ["一", "二"], "回滚恢复 update 前文本与顺序");
});

test("迁移：旧格式 before（含 leaves 数组）拆为元数据并回填叶级行，历史可读可回滚", async () => {
  const dir = await tmpDir();
  await mkdir(join(dir, ".memory"), { recursive: true });
  const raw = new DatabaseSync(join(dir, ".memory", "memory.db"));
  raw.exec(`
    CREATE TABLE nodes(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE, ord INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE, depth INTEGER NOT NULL, content TEXT, summary TEXT, summary_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE leaves(id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, ord INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
    CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, path TEXT, actor TEXT NOT NULL DEFAULT 'pi', detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE changes(revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE, uid TEXT NOT NULL, path TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, before TEXT, PRIMARY KEY(revision_id, uid)) WITHOUT ROWID;
    CREATE TABLE episodes(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  const uid = "11111111-2222-3333-4444-555555555555";
  raw.prepare("INSERT INTO nodes(uid,parent_id,ord,title,path,depth) VALUES (?,NULL,0,'Memory','',0)").run(uid);
  raw.prepare("INSERT INTO nodes(uid,parent_id,ord,title,path,depth) VALUES (?,1,0,'工作','工作',1)").run("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  raw.prepare("INSERT INTO leaves(node_id,ord,text) VALUES (2,0,'旧一'),(2,1,'旧二')").run();
  // 旧格式 before：整节点状态含 leaves 数组
  const legacyState = JSON.stringify({
    title: "工作",
    leaves: ["旧一"],
    content: null,
    summary: null,
    summaryHash: null,
    parentUid: uid,
    ord: 0,
  });
  raw.prepare("INSERT INTO revisions(op,path,actor) VALUES ('upsert','工作','pi')").run();
  raw.prepare("INSERT INTO changes(revision_id,uid,path,deleted,before) VALUES (1,?,'工作',0,?)").run("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", legacyState);
  raw.close();

  const mf = await MemoryFile.open(dir);
  assert.deepEqual(mf.readSection("工作") .node.leaves, ["旧一", "旧二"], "当前态完整");
  const db = rawDb(dir);
  const legacyLeft = (
    db.prepare("SELECT COUNT(*) AS n FROM changes WHERE before LIKE '%\"leaves\"%'").get()                 
  ).n;
  const blobs = (db.prepare("SELECT COUNT(*) AS n FROM changes WHERE before_leaves IS NOT NULL").get()                 ).n;
  const backfilled = db
    .prepare("SELECT kind, after_text FROM leaf_changes ORDER BY revision_id")
    .all()                                                      ;
  db.close();
  assert.equal(legacyLeft, 0, "旧格式 before 已拆分");
  assert.equal(blobs, 0, "blob 已进一步回填为叶级行（before_leaves 清空）");
  assert.deepEqual(
    backfilled.map((r) => `${r.kind}:${r.after_text}`),
    ["add:旧二"],
    "回填行 = 点时 diff（blob [旧一] → 末态 [旧一,旧二]）",
  );
  // 历史可读：旧版本的 add 可见
  const hist = mf.nodeHistory("工作").rows;
  assert.ok(hist.some((r) => r.op === "add" && r.value === "旧二"), "跨版本 set-diff 可见旧增量");
  // 旧格式版本可回滚（blob 整体恢复）
  const revs = mf.listRevisions(10);
  const r = await mf.restoreRevision(revs[revs.length - 1] .id);
  assert.equal(r.ok, true);
  // 迁移后新写入走叶级行
  await mf.updateNode("工作", "旧二", "旧二改");
  const db2 = rawDb(dir);
  const upd = db2.prepare("SELECT kind FROM leaf_changes WHERE kind='update'").get()                                ;
  db2.close();
  assert.equal(upd?.kind, "update", "迁移后 update 走叶级行");
});

test("纯移动/重命名：不产生叶级行（叶子没变）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/A", "事实");
  await mf.upsertNode("域二", "锚");
  const db1 = rawDb(dir);
  const leafBefore = (db1.prepare("SELECT COUNT(*) AS n FROM leaf_changes").get()                 ).n;
  db1.close();
  await mf.moveNode("域/A", "域二");
  const db2 = rawDb(dir);
  const leafAfter = (db2.prepare("SELECT COUNT(*) AS n FROM leaf_changes").get()                 ).n;
  db2.close();
  assert.equal(leafAfter, leafBefore, "移动不产生叶级行");
});

test("删除中间叶子后回滚：顺序精确恢复（before_ord）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "一");
  await mf.upsertNode("域", "二");
  const revA = Number((await mf.upsertNode("域", "三")).revision);
  // 删中间叶 → 剩余叶子 ord 重写，但 undo 行记了 before_ord
  await mf.applyOps([{ op: "remove_leaf", path: "域", match: "二" }]);
  const leaves = mf.readSection("域") .node.leaves;
  assert.ok(leaves.includes("一") && leaves.includes("三") && !leaves.includes("二"));
  await mf.restoreRevision(revA);
  assert.deepEqual(mf.readSection("域") .node.leaves, ["一", "二", "三"], "回滚后顺序精确恢复");
});
