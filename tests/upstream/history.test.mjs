/**
 * Ported from memory-x packages/core/tests/history.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../../core/memory-file.js";

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-history-"));
}

test("nodeHistory：每个值只出现一次，新→旧，旧值挂在写入它的版本", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("工作/项目A", "初版结论");
  await mf.upsertNode("工作/项目A", "另一条事实");
  await mf.updateNode("工作/项目A", "初版结论", "修订后结论");

  const { rows, found, deleted } = mf.nodeHistory("工作/项目A");
  assert.ok(found);
  assert.ok(!deleted);

  // 新→旧：revisionId 单调不增
  const revs = rows.map((r) => r.revisionId);
  assert.ok(revs.every((v, i) => i === 0 || v <= revs[i - 1] ), "应按新→旧排序");

  // 值零冗余：同一文本不重复出现
  const values = rows.map((r) => r.value).filter((v)              => v != null);
  assert.equal(values.length, new Set(values).size, "每个值只出现一次");

  // 旧值在新值之前的版本写入
  const revOld = rows.find((r) => r.value === "初版结论") .revisionId;
  const revNew = rows.find((r) => r.value === "修订后结论") .revisionId;
  assert.ok(revNew > revOld, "修订后结论应挂在更晚的版本");

  // 建节点条目带初始标题
  assert.ok(rows.some((r) => r.op === "add-node" && r.value === "项目A"));
  assert.ok(values.includes("另一条事实"));
});

test("nodeHistory：writeNote 的正文历史逐版可追", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("域", "锚点");
  await mf.writeNote("域", "# 版本一");
  await mf.writeNote("域", "# 版本二");

  const { rows } = mf.nodeHistory("域");
  const notes = rows.filter((r) => r.op === "note").map((r) => r.value);
  assert.deepEqual(notes, ["# 版本二", "# 版本一"], "两个版本各出现一次，新的在前");
});

test("nodeHistory：rename 记录新标题", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("旧名", "事实");
  await mf.applyOps([{ op: "rename", path: "旧名", title: "新名" }]);

  const { rows } = mf.nodeHistory("新名");
  const ren = rows.find((r) => r.op === "rename");
  assert.ok(ren, "应有 rename 条目");
  assert.equal(ren .value, "新名", "rename 只记写入侧（新标题）");
});

test("nodeHistory：已删除节点按历史路径兜底，末条为 delete", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("临时", "事实X");
  await mf.deleteNode("临时");
  assert.equal(mf.readSection("临时"), null, "当前树已无此节点");

  const { rows, found, deleted } = mf.nodeHistory("临时");
  assert.ok(found, "按 changes 记录过的路径应能兜底命中");
  assert.ok(deleted);
  assert.ok(rows.some((r) => r.op === "delete"), "末版应有 delete 标记");
  assert.ok(rows.some((r) => r.value === "事实X"), "删除前的值在其写入版本仍可查");
  assert.equal(rows[0] .op, "delete", "最新一条是 delete");
});

test("nodeHistory：从未动过的路径 found=false", async () => {
  const mf = await MemoryFile.open(await tmpDir());
  await mf.upsertNode("域", "事实");
  const { rows, found } = mf.nodeHistory("不存在的路径");
  assert.ok(!found);
  assert.equal(rows.length, 0);
});
