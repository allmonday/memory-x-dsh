/**
 * Ported from memory-x packages/core/tests/backfill-legacy.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryFile } from "../../core/memory-file.js";
                                                  

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-backfill-"));
}

function rawDb(dir        )               {
  return new DatabaseSync(join(dir, ".memory", "memory.db"));
}

function findNode(n            , uid        )                    {
  if (n.uid === uid) return n;
  for (const c of n.children ?? []) {
    const r = findNode(c, uid);
    if (r) return r;
  }
  return null;
}

/**
 * 降级 [fromRev, toRev] 为旧代码写的格式：每版本落节点行（before 合并点时全量 leaves），删叶级行。
 * before 态用 materializeTree(rev-1) 现算，须升序执行（r 及以上保持未降级才可重放）。
 */
function legacyize(dir        , mf            , fromRev        , toRev        )       {
  const store = (mf                                                                            ).store;
  const db = rawDb(dir);
  const metaOf = (before                   , uid        )                      => {
    if (!before) return null;
    const parent = (n            , target        , p                   )                                                 => {
      if (n.uid === target) return { n, p };
      for (const c of n.children ?? []) {
        const r = parent(c, target, n);
        if (r) return r;
      }
      return null;
    };
    const hit = parent(before, uid, null);
    if (!hit) return null;
    const siblings = hit.p ? hit.p.children ?? [] : before.children ?? [];
    return {
      title: hit.n.title,
      content: hit.n.content ?? null,
      summary: hit.n.summary ?? null,
      summaryHash: hit.n.summaryHash ?? null,
      parentUid: hit.p?.uid ?? null,
      ord: siblings.findIndex((s) => s.uid === uid),
      leaves: hit.n.leaves,
    };
  };
  for (let rev = fromRev; rev <= toRev; rev++) {
    const before = rev > 1 ? store.materializeTree(rev - 1) : null;
    const touched = db
      .prepare(
        `SELECT node_uid AS uid, path FROM leaf_changes WHERE revision_id = ?
         UNION SELECT uid, path FROM changes WHERE revision_id = ?`,
      )
      .all(rev, rev)                                        ;
    db.exec("BEGIN");
    db.prepare("DELETE FROM leaf_changes WHERE revision_id = ?").run(rev);
    db.prepare("DELETE FROM changes WHERE revision_id = ?").run(rev);
    const ins = db.prepare("INSERT INTO changes(revision_id, uid, path, deleted, before) VALUES (?, ?, ?, ?, ?)");
    const seen = new Set        ();
    for (const t of touched) {
      if (seen.has(t.uid)) continue;
      seen.add(t.uid);
      const meta = metaOf(before, t.uid);
      ins.run(rev, t.uid, t.path, 0, meta == null ? null : JSON.stringify(meta));
    }
    db.exec("COMMIT");
  }
  db.close();
}

                     
                
                         
                         
                             
                           
              
                   
  

test("回填：旧格式末行的变更视图点时定格，后续新写入不串台", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲"); // #1 创建（before=null）
  await mf.upsertNode("域/节点", "事实乙"); // #2 add 乙
  legacyize(dir, mf, 2, 2); // #2 → 旧格式（blob=[事实甲]）
  await mf.upsertNode("域/节点", "事实丙"); // #3 新格式 add 丙
  const mf2 = await MemoryFile.open(dir); // 触发 migrate：splitter → blob → 回填
  const rows = mf2.listChanges({ revisionId: 2 });
  const summary = rows.map((r) => `${r.op}:${r.toText ?? r.fromText}`);
  assert.deepEqual(summary, ["add:事实乙"]);
});

test("回填后可回滚到旧格式时代的任意版本（叶集精确还原）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲"); // #1
  await mf.updateNode("域/节点", "事实甲", "事实甲改"); // #2 update（旧格式时代）
  await mf.upsertNode("域/节点", "事实乙"); // #3 add（旧格式时代）
  legacyize(dir, mf, 2, 3);
  await mf.upsertNode("域/节点", "事实丙"); // #4 新格式 add
  await mf.updateNode("域/节点", "事实乙", "事实乙改"); // #5 新格式 update
  const mf2 = await MemoryFile.open(dir); // 回填 + 清 blob
  const r3 = await mf2.restoreRevision(3);
  assert.equal(r3.ok, true);
  assert.deepEqual(mf2.readSection("域/节点") .node.leaves, ["事实甲改", "事实乙"], "回滚到 #3：点时叶集");
  const r2 = await mf2.restoreRevision(2);
  assert.equal(r2.ok, true);
  assert.deepEqual(mf2.readSection("域/节点") .node.leaves, ["事实甲改"], "回滚到 #2：点时叶集");
});

test("回填安全降级：无法解析的 blob 保留不炸，读取层容错", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲"); // #1
  await mf.upsertNode("域/节点", "事实乙"); // #2
  legacyize(dir, mf, 2, 2);
  // 直接 staging 分裂后形态，但 blob 是坏 JSON（模拟外部损坏）
  const db = rawDb(dir);
  const before = JSON.parse((db.prepare("SELECT before FROM changes WHERE revision_id = 2").get()                      ).before)                           ;
  delete before.leaves;
  db.prepare("UPDATE changes SET before = ?, before_leaves = '{oops-not-json' WHERE revision_id = 2").run(JSON.stringify(before));
  db.close();
  await mf.upsertNode("域/节点", "事实丙"); // #3 新格式
  const mf2 = await MemoryFile.open(dir); // 回填遇坏 blob → 跳过该行，打开不炸
  const rows = mf2.listChanges({ revisionId: 2 }); // 读取层容错，不抛异常
  assert.ok(Array.isArray(rows));
  const hist = mf2.nodeHistory("域/节点"); // history 同样容错
  assert.ok(Array.isArray(hist.rows));
  const db2 = rawDb(dir);
  const blobs = (db2.prepare("SELECT COUNT(*) AS n FROM changes WHERE before_leaves IS NOT NULL").get()                 ).n;
  db2.close();
  assert.ok(blobs >= 1, "坏 blob 未被清除（回填安全跳过）");
});

test("回填幂等：重复打开不产生重复叶级行", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲"); // #1 原生 add 甲
  await mf.upsertNode("域/节点", "事实乙"); // #2（待降级）
  legacyize(dir, mf, 2, 2);
  await mf.upsertNode("域/节点", "事实丙"); // #3 新格式
  await MemoryFile.open(dir); // 第一次：回填
  const probe = () => {
    const db = rawDb(dir);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM leaf_changes").get()                 ).n;
    const blobs = (db.prepare("SELECT COUNT(*) AS n FROM changes WHERE before_leaves IS NOT NULL").get()                 ).n;
    db.close();
    return { n, blobs };
  };
  const first = probe();
  await MemoryFile.open(dir); // 第二次：应无变化
  const second = probe();
  assert.equal(first.blobs, 0);
  assert.equal(first.n, 3, "三条 add（#1 原生 + #2 回填 + #3 新写入）");
  assert.deepEqual(second, first, "重复打开不增不改");
});

test("listChanges：预算不足时按整版本取舍，不静默吞行", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲");
  await mf.upsertNode("域/节点", "事实乙");
  await mf.deleteNode("域/节点"); // 单版本 ≥3 行：remove×2 + remove-node
  const rows = mf.listChanges({ limit: 2 });
  assert.ok(rows.some((r) => r.op === "remove-node"), "remove-node 不因预算被吞");
  assert.ok(rows.length > 0 && rows.every((r) => r.revisionId === rows[0] .revisionId), "预算内只给完整版本，不辛半版本");
});

test("回填：幸存者排在被改者之后不误伤（出现次数 vs 数组下标回归）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲"); // #1 [甲]
  await mf.upsertNode("域/节点", "事实乙"); // #2 [甲,乙]
  await mf.updateNode("域/节点", "事实甲", "事实丙"); // #3 [丙,乙]（乙幸存于下标 1）
  legacyize(dir, mf, 3, 3);
  await mf.upsertNode("域/节点", "事实丁"); // #4 新格式
  const mf2 = await MemoryFile.open(dir);
  const rows = mf2.listChanges({ revisionId: 3 }).map((r) => `${r.op}:${r.toText ?? r.fromText}`);
  assert.deepEqual([...rows].sort(), ["add:事实丙", "remove:事实甲"], "幸存的乙不产生幻影 remove");
});

test("节点 uid 缺失回填：旧进程丢 uid 不炸回放（根不漂移）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/子", "事实甲"); // #1
  await mf.upsertNode("域/子", "事实乙"); // #2
  // 模拟旧进程（INSERT 不带 uid 列）删光重插：父节点 uid 丢失 → 子节点 parentUid 解析为 null → 假根
  const db = rawDb(dir);
  db.prepare("UPDATE nodes SET uid = NULL WHERE path = '域'").run();
  db.close();
  await mf.upsertNode("域/子", "事实丙"); // #3（纯叶子写，不碰节点行）
  const mf2 = await MemoryFile.open(dir); // migrate 回填 uid
  const r = await mf2.restoreRevision(2); // 回滚依赖 materializeTree（根不漂移才成功）
  assert.equal(r.ok, true);
  assert.deepEqual(mf2.readSection("域/子") .node.leaves, ["事实甲", "事实乙"]);
});

test("回填：链中间行显示为 remove+add 对，末行不串台（多行 blob 链）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/节点", "事实甲"); // #1
  await mf.updateNode("域/节点", "事实甲", "事实甲改"); // #2 update 甲→甲改
  await mf.upsertNode("域/节点", "事实乙"); // #3 add 乙
  legacyize(dir, mf, 2, 3); // #2、#3 → 旧格式（blob 链 [甲]→[甲改]→[甲改,乙]）
  await mf.upsertNode("域/节点", "事实丙"); // #4 新格式
  const mf2 = await MemoryFile.open(dir);
  const rows2 = mf2.listChanges({ revisionId: 2 }).map((r) => `${r.op}:${r.toText ?? r.fromText}`);
  assert.deepEqual([...rows2].sort(), ["add:事实甲改", "remove:事实甲"].sort());
  const rows3 = mf2.listChanges({ revisionId: 3 }).map((r) => `${r.op}:${r.toText ?? r.fromText}`);
  assert.deepEqual(rows3, ["add:事实乙"], "末行只出真实 diff，不串入 #4 的丙");
});
