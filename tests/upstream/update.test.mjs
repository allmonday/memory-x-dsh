/**
 * Ported from memory-x packages/core/tests/update.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../../core/memory-file.js";

async function fresh()                      {
  const dir = await mkdtemp(join(tmpdir(), "mx-update-"));
  return MemoryFile.open(dir);
}

test("updateNode：唯一命中则原地替换（旧值消失、新值出现、记版本）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/prefs", "数据库用 SQLite");
  await mf.upsertNode("工作/prefs", "给他起名叫 Bob");
  const r = await mf.updateNode("工作/prefs", "数据库用 SQLite", "数据库用 Postgres ← 2026-11-18");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(String(r.revision), /.+/);
  const leaves = mf.readSection("工作/prefs") .node.leaves;
  assert.ok(leaves.includes("数据库用 Postgres ← 2026-11-18"));
  assert.ok(!leaves.includes("数据库用 SQLite"), "旧值应被替换掉");
  assert.ok(leaves.includes("给他起名叫 Bob"), "无关叶子不动");
});

test("updateNode：match 未命中则不改动（ok=false）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/prefs", "数据库用 SQLite");
  const r = await mf.updateNode("工作/prefs", "数据库用 MySQL", "数据库用 Postgres");
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.deepEqual(mf.readSection("工作/prefs") .node.leaves, ["数据库用 SQLite"]);
});

test("updateNode：不动节点 content", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/调研", "阶段=进行中");
  await mf.writeNote("工作/调研", "# 调研正文\n不参与叶子替换");
  await mf.updateNode("工作/调研", "阶段=进行中", "阶段=已完成");
  assert.equal(mf.readNote("工作/调研"), "# 调研正文\n不参与叶子替换");
  assert.deepEqual(mf.readSection("工作/调研") .node.leaves, ["阶段=已完成"]);
});

test("updateNode：match 省略末尾「← 日期」尾巴也能命中（归一化比对）", async () => {
  const mf = await fresh();
  const stored = "数据库用 Postgres ← 2026-11-18";
  await mf.upsertNode("工作/prefs", stored);
  const r = await mf.updateNode("工作/prefs", "数据库用 Postgres", "数据库用 SQLite ← 2026-11-21");
  assert.equal(r.ok, true);
  assert.deepEqual(mf.readSection("工作/prefs") .node.leaves, ["数据库用 SQLite ← 2026-11-21"]);
});

test("updateNode：match 带旧/错误日期尾巴同样命中（尾巴不参与比对）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/prefs", "数据库用 Postgres ← 2026-11-18");
  const r = await mf.updateNode("工作/prefs", "数据库用 Postgres ← 1999-01-01", "数据库用 SQLite");
  assert.equal(r.ok, true);
  assert.deepEqual(mf.readSection("工作/prefs") .node.leaves, ["数据库用 SQLite"]);
});

test("updateNode：归一化后多条命中则拒绝（仅日期不同的两条叶子）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/prefs", "数据库用 Postgres ← 2026-11-18");
  await mf.upsertNode("工作/prefs", "数据库用 Postgres ← 2026-11-19");
  const r = await mf.updateNode("工作/prefs", "数据库用 Postgres", "数据库用 SQLite");
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(mf.readSection("工作/prefs") .node.leaves.length, 2);
});

test("updateNode：日期尾巴只认末尾（正文中间的「← 日期」不归一化）", async () => {
  const mf = await fresh();
  await mf.upsertNode("工作/log", "记录 ← 2026-01-01 当天的备注");
  const r = await mf.updateNode("工作/log", "记录", "改写");
  assert.equal(r.ok, false);
  assert.deepEqual(mf.readSection("工作/log") .node.leaves, ["记录 ← 2026-01-01 当天的备注"]);
});
