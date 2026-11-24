/**
 * Ported from memory-x packages/core/tests/replay-order.test.ts (7fbd36c) by
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
                                                  

/**
 * 从叶级行回放历史版本（materializeTree）的两条不变量。回滚与版本 diff 都靠它：
 * 拿不到正确的旧树，回滚就会把错的树写成新版本。
 *
 *   1. 版本必须严格降序撤销；
 *   2. remove 行按 before_ord 插回前，该节点现存叶子的序位必须是稠密下标。
 */

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-replay-"));
}

function rawDb(dir        )               {
  return new DatabaseSync(join(dir, ".memory", "memory.db"));
}

function storeOf(mf            )                                                     {
  return (mf                                                                            ).store;
}

/** 某节点在某版本的叶子（按序）；节点不存在返回 null。 */
function leavesAt(tree                   , path        )                  {
  const walk = (node            , trail        )                    => {
    const at = trail ? `${trail}/${node.title}` : node.title;
    if (at === path) return node;
    for (const c of node.children ?? []) {
      const hit = walk(c, at);
      if (hit) return hit;
    }
    return null;
  };
  for (const c of tree?.children ?? []) {
    const hit = walk(c, "");
    if (hit) return hit.leaves;
  }
  return null;
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
 * 与 backfill-legacy.test.ts 同构。
 */
function legacyize(dir        , mf            , fromRev        , toRev        )       {
  const store = storeOf(mf);
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

test("回放：只有节点行的版本不晚于更高版本的叶级行回放", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("甲/X", "一"); // #1
  await mf.upsertNode("乙/锚", "锚"); // #2
  // #3 带叶级行（按桶的插入序会先于只有节点行的版本被走到），同时把 X 挪到乙下面
  await mf.applyOps([{ op: "move", from: "甲/X", to: "乙" }, { op: "add_leaf", path: "乙/锚", leaf: "锚二" }]);
  await mf.writeSummary("乙/X", "摘要"); // #4：只有节点行
  assert.deepEqual(mf.readSection("乙/X") .node.leaves, ["一"], "当前态：X 在乙下面");
  const store = storeOf(mf);
  // #1 时乙还不存在。#4 若晚于 #3 回放，X 会被挂到随后才被撤销掉的乙上，从树里消失
  assert.deepEqual(leavesAt(store.materializeTree(1), "甲/X"), ["一"], "#1：X 仍在甲下面");
  assert.equal(leavesAt(store.materializeTree(1), "乙/锚"), null, "#1：乙尚未创建");
  const r = await mf.restoreRevision(1);
  assert.equal(r.ok, true);
  assert.deepEqual(mf.readSection("甲/X") .node.leaves, ["一"], "回滚到 #1 后 X 在甲下面");
  assert.deepEqual(
    mf.root.children.map((c) => c.title),
    ["甲"],
    "回滚到 #1 后乙不存在",
  );
});

test("回放：撤销 add 留下的序位空档不让更早版本的叶子错位（旧格式迁移数据）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "一"); // #1
  await mf.upsertNode("域", "二"); // #2
  await mf.upsertNode("域", "三"); // #3
  await mf.upsertNode("域", "四"); // #4
  await mf.applyOps([{ op: "remove_leaf", path: "域", match: "四" }]); // #5 → 一 二 三
  await mf.updateNode("域", "二", "二改"); // #6 → 一 二改 三
  await mf.upsertNode("域", "五"); // #7 → 一 二改 三 五
  legacyize(dir, mf, 1, 7); // 旧格式：原地改写是一次 remove + 一次 add
  const migrated = await MemoryFile.open(dir);
  const db = rawDb(dir);
  const blobs = (db.prepare("SELECT COUNT(*) AS n FROM changes WHERE before_leaves IS NOT NULL").get()                 ).n;
  db.close();
  assert.equal(blobs, 0, "旧格式已回填为叶级行");
  const store = storeOf(migrated);
  assert.deepEqual(migrated.readSection("域") .node.leaves, ["一", "二改", "三", "五"]);
  assert.deepEqual(leavesAt(store.materializeTree(6), "域"), ["一", "二改", "三"]);
  assert.deepEqual(leavesAt(store.materializeTree(5), "域"), ["一", "二", "三"]);
  // #6 撤销后 三 的序位留着空档；不重编号就按 #5 的 before_ord 插回 四，四 会排到 三 前面
  assert.deepEqual(leavesAt(store.materializeTree(4), "域"), ["一", "二", "三", "四"], "#4：三仍排在四之前");
  assert.deepEqual(leavesAt(store.materializeTree(2), "域"), ["一", "二"]);
  assert.equal((await migrated.restoreRevision(4)).ok, true);
  assert.deepEqual(migrated.readSection("域") .node.leaves, ["一", "二", "三", "四"], "回滚到 #4：顺序精确恢复");
});
