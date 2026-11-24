/**
 * Ported from memory-x packages/core/tests/revisions.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryFile } from "../../core/memory-file.js";

function tmpDir()                  {
  return mkdtemp(join(tmpdir(), "mx-rev-"));
}

test("每次写入记录一条版本；幂等不产生新版本", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);

  const r1 = await mf.upsertNode("工作/调研", "事实一");
  assert.ok(r1.revision, "应返回版本号");
  const r2 = await mf.upsertNode("工作/调研", "事实二");
  assert.ok(Number(r2.revision) > Number(r1.revision), "版本号单调前进");

  const before = mf.listRevisions(1)[0] .id;
  await mf.upsertNode("工作/调研", "事实二"); // 幂等
  assert.equal(mf.listRevisions(1)[0] .id, before, "幂等写入不记版本");

  const log = mf.listRevisions(10);
  assert.equal(log.length, 2);
  assert.equal(log[0] .op, "upsert");
  assert.equal(log[0] .path, "工作/调研");
});

test("回滚：加载快照落为新版本，历史不改写，可再回滚回来", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  const revA = Number((await mf.upsertNode("域", "事实A")).revision); // 只有 事实A
  await mf.upsertNode("域", "事实B"); // A+B

  // 回滚到 revA（只有 事实A）
  const r = await mf.restoreRevision(revA);
  assert.equal(r.ok, true);
  const sec = mf.readSection("域") ;
  assert.deepEqual(sec.node.leaves, ["事实A"], "应恢复到 revA 状态");

  // 历史追加 restore，不删旧记录
  const log = mf.listRevisions(10);
  assert.equal(log[0] .op, "restore");
  assert.equal(log.length, 3, "A、A+B 两个版本 + 一条 restore");

  // "前滚"：回滚到回滚前的版本（revA+1 = 事实A+B）
  await mf.restoreRevision(revA + 1);
  assert.deepEqual(mf.readSection("域") .node.leaves, ["事实A", "事实B"]);
});

test("回滚到不存在的版本报 ok:false", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "x");
  const r = await mf.restoreRevision(999);
  assert.equal(r.ok, false);
});

test("存量数据打开时自动记 baseline 版本", async () => {
  const dir = await tmpDir();
  await writeFile(join(dir, "MEMORY.md"), "# Memory\n\n## 工作\n- 事实\n", "utf8");
  const mf = await MemoryFile.open(dir);
  // 旧版 md 走 import 路径
  const log = mf.listRevisions(5);
  assert.equal(log[0] .op, "import");
});

test("重开：状态与版本历史从 db 完整恢复", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "事实");
  const revCount = mf.listRevisions(100).length;

  const mf2 = await MemoryFile.open(dir);
  assert.equal(mf2.readSection("域") .node.leaves[0], "事实");
  assert.equal(mf2.listRevisions(100).length, revCount, "版本历史不丢");
});

test("写入后不再产生 MEMORY.md / .git（镜像已移除）", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域", "事实");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => !f.startsWith(".memory"));
  assert.deepEqual(files, [], "目录里除 .memory/ 外应无其它文件");
  const db = new DatabaseSync(join(dir, ".memory", "memory.db"), { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM nodes").get()                 ).n;
  assert.equal(n, 2, "根+域");
});

test("rewriteCounts：创建/移动不计，语义改写计，未动节点为 0", async () => {
  const dir = await tmpDir();
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("域/A", "事实一");
  await mf.upsertNode("域/B", "事实X");
  const uidA = mf.readSection("域/A") .node.uid ;
  const uidB = mf.readSection("域/B") .node.uid ;
  assert.equal(mf.historyCounts().get(uidA) ?? 0, 0, "创建不计改写");
  assert.equal(mf.historyCounts().get(uidB) ?? 0, 0, "创建不计改写");

  // 同节点幂等 upsert 不产生 undo 行 → 计数不变
  await mf.upsertNode("域/A", "事实一");
  assert.equal(mf.historyCounts().get(uidA) ?? 0, 0, "幂等写入不计");

  // 叶子替换（真正改写）→ 计 1
  await mf.updateNode("域/A", "事实一", "事实一改");
  assert.equal(mf.historyCounts().get(uidA) ?? 0, 1, "改写计 1");

  // 纯移动（uid 不变、语义态不变）→ 不计；兄弟 ord 重排也不计入 B
  await mf.upsertNode("域二/D", "占位");
  await mf.moveNode("域/A", "域二");
  assert.equal(mf.readSection("域二/A") .node.uid, uidA, "移动后 uid 稳定");
  assert.equal(mf.historyCounts().get(uidA) ?? 0, 1, "纯位置变化不计改写");
  assert.equal(mf.historyCounts().get(uidB) ?? 0, 0, "兄弟重排不计改写");

  // 追加叶子是语义改写；回滚（restore 到早期版本）是一次前进写入，也计改写
  const revY = Number((await mf.upsertNode("域/B", "事实Y")).revision);
  assert.equal(mf.historyCounts().get(uidB) ?? 0, 1, "追加叶子计改写");
  await mf.upsertNode("域/B", "事实Z");
  await mf.restoreRevision(revY);
  assert.equal(mf.historyCounts().get(uidB) ?? 0, 3, "回滚撤销也计改写");
});
