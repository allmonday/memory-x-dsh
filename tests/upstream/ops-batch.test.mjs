/**
 * Ported from memory-x packages/core/tests/ops-batch.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../../core/memory-file.js";
import { applyOps, OpError,             } from "../../core/ops-batch.js";
import { canonicalPathOf } from "../../core/path.js";
                                                  

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-ops-"));
}

/** 造一棵树：工作{A(叶子 事实1), B} + 生活。 */
function seed()             {
  return {
    title: "Memory",
    leaves: [],
    children: [
      {
        title: "工作",
        leaves: [],
        children: [
          { title: "A", leaves: ["事实1"], children: [] },
          { title: "B", leaves: [], children: [] },
        ],
      },
      { title: "生活", leaves: ["体检"], children: [] },
    ],
  };
}

test("applyOps：叶子增/改/删", () => {
  const root = seed();
  applyOps(root, [
    { op: "add_leaf", path: "工作/A", leaf: "事实2" },
    { op: "update_leaf", path: "工作/A", match: "事实1", leaf: "事实1改" },
    { op: "remove_leaf", path: "生活", match: "体检" },
  ]);
  const work = root.children[0] ;
  assert.deepEqual(work.children[0] .leaves, ["事实1改", "事实2"]);
  assert.deepEqual(root.children[1] .leaves, []);
});

test("applyOps：rename / add_node / move / delete", () => {
  const root = seed();
  applyOps(root, [
    { op: "rename", path: "工作/A", title: "调研" },
    { op: "add_node", parent: "工作", title: "待办" },
    { op: "move", from: "生活", to: "工作/待办" },
    { op: "delete", path: "工作/B" },
  ]);
  const work = root.children[0] ;
  assert.deepEqual(work.children.map((c) => c.title), ["调研", "待办"]);
  assert.deepEqual(work.children[1] .children.map((c) => c.title), ["生活"]);
  assert.deepEqual(root.children.map((c) => c.title), ["工作"]);
});

test("applyOps：set_note / set_summary", () => {
  const root = seed();
  applyOps(root, [
    { op: "set_note", path: "工作/A", content: "# 正文\n内容" },
    { op: "set_summary", path: "工作/A", summary: "一句话摘要" },
  ]);
  const a = root.children[0] .children[0] ;
  assert.equal(a.content, "# 正文\n内容");
  assert.equal(a.summary, "一句话摘要");
  assert.ok(a.summaryHash, "写入摘要时记指纹");
});

test("applyOps：无实际改动时 changed=false", () => {
  const root = seed();
  const r = applyOps(root, [
    { op: "add_leaf", path: "工作/A", leaf: "事实1" }, // 已存在
    { op: "rename", path: "工作/A", title: "A" }, // 同名
  ]);
  assert.equal(r.changed, false);
});

test("applyOps：update_leaf / remove_leaf 的 match 忽略末尾「← 日期」尾巴", () => {
  const root = seed();
  root.children[0] .children[0] .leaves = ["事实1 ← 2026-11-18", "事实2 ← 2026-11-19"];
  applyOps(root, [
    { op: "update_leaf", path: "工作/A", match: "事实1", leaf: "事实1改 ← 2026-11-21" },
    { op: "remove_leaf", path: "工作/A", match: "事实2 ← 1999-01-01" }, // 带错误日期也能命中
  ]);
  assert.deepEqual(root.children[0] .children[0] .leaves, ["事实1改 ← 2026-11-21"]);
});

test("applyOps：归一化后多条命中则拒绝（仅日期不同的两条叶子）", () => {
  const root = seed();
  root.children[0] .children[0] .leaves = ["事实1 ← 2026-11-18", "事实1 ← 2026-11-19"];
  assert.throws(
    () => applyOps(root, [{ op: "remove_leaf", path: "工作/A", match: "事实1" }]),
    /唯一命中/,
  );
});

test("applyOps：失败即抛 OpError（含序号），调用方整批回滚", () => {
  const root = seed();
  const ops           = [
    { op: "add_leaf", path: "工作/A", leaf: "x" },
    { op: "remove_leaf", path: "工作/A", match: "不存在" },
  ];
  assert.throws(
    () => applyOps(root, ops),
    (e         ) => e instanceof OpError && e.index === 1 && /唯一命中/.test((e         ).message),
  );
});

test("applyOps：路径不存在 / rename 重名 / move 成环 / 根不可动 → 报错", () => {
  assert.throws(() => applyOps(seed(), [{ op: "add_leaf", path: "没有/这个", leaf: "x" }]), /路径不存在/);
  assert.throws(() => applyOps(seed(), [{ op: "rename", path: "工作/A", title: "B" }]), /同名/);
  assert.throws(
    () => applyOps(seed(), [
      { op: "add_node", parent: "工作/A", title: "子" },
      { op: "move", from: "工作/A", to: "工作/A/子" },
    ]),
    /环/,
  );
  assert.throws(() => applyOps(seed(), [{ op: "delete", path: "" }]), /path 为空/);
});

test("MemoryFile.applyOps：批次原子（中途失败整批回滚，无新版本）", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("工作/甲", "旧");
  const head = mf.listRevisions(1)[0] .id;

  await assert.rejects(
    () =>
      mf.applyOps([
        { op: "add_leaf", path: "工作/甲", leaf: "新" },
        { op: "update_leaf", path: "工作/甲", match: "不存在", leaf: "x" },
      ]),
    /唯一命中/,
  );
  assert.deepEqual(mf.readSection("工作/甲") .node.leaves, ["旧"], "树未变");
  assert.equal(mf.listRevisions(1)[0] .id, head, "未产生新版本");
});

test("MemoryFile.applyOps：一次落为一个版本，可回滚", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("工作/甲", "旧");
  const head = Number(mf.listRevisions(1)[0] .id);

  const r = await mf.applyOps([
    { op: "update_leaf", path: "工作/甲", match: "旧", leaf: "新" },
    { op: "rename", path: "工作/甲", title: "甲2" },
    { op: "add_leaf", path: "工作/甲2", leaf: "追加" },
  ]);
  assert.ok(r.revision);
  assert.equal(Number(r.revision), head + 1, "整批一个版本");
  assert.deepEqual(mf.readSection("工作/甲2") .node.leaves, ["新", "追加"]);

  await mf.restoreRevision(head);
  assert.deepEqual(mf.readSection("工作/甲") .node.leaves, ["旧"], "回滚整批");
});

test("applyOps：落盘为一版，detail 与 changes 可查（含 revOp/revDetail）", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("工作/甲", "旧");
  const r = await mf.applyOps([{ op: "update_leaf", path: "工作/甲", match: "旧", leaf: "新" }], "整理说明X");
  const rev = Number(r.revision);
  const head = mf.listRevisions(1)[0] ;
  assert.equal(head.op, "tidy");
  assert.equal(head.detail, "整理说明X");
  const rows = mf.listChanges({ revisionId: rev });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((c) => c.revisionId === rev && c.revOp === "tidy" && c.revDetail === "整理说明X"));
  assert.ok(rows.some((c) => c.op === "update" && c.fromText === "旧" && c.toText === "新"));
});

test("MemoryFile.previewOps：对克隆树试跑，不改动真树", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("工作/甲", "旧");
  const uidBefore = canonicalPathOf(mf.root, mf.readSection("工作/甲") .node);

  const ok = mf.previewOps([{ op: "add_leaf", path: "工作/甲", leaf: "新" }]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.diff.addedLeaves.map((x) => x.leaf), ["新"]);
  assert.deepEqual(mf.readSection("工作/甲") .node.leaves, ["旧"], "真树未改");

  const bad = mf.previewOps([{ op: "delete", path: "不存在" }]);
  assert.equal(bad.ok, false);
  assert.equal(canonicalPathOf(mf.root, mf.readSection("工作/甲") .node), uidBefore);
});
