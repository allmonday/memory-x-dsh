/**
 * Ported from memory-x packages/core/tests/summary.test.ts (7fbd36c) by
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
import { deriveSummary, effectiveSummary, summaryHash } from "../../core/summary.js";
import { tocDigest } from "../../core/digest.js";
import { parseMarkdown } from "../../core/parser.js";
                                                  

const node = (o                     )             => ({ title: "t", leaves: [], children: [], ...o });

async function file()                      {
  const dir = await mkdtemp(join(tmpdir(), "mx-summary-"));
  return MemoryFile.open(dir);
}

// ---------- 确定性推导 ----------

test("deriveSummary：content 首句优先", () => {
  const n = node({ content: "# 标题行\n\n正文首句在这里。", leaves: ["叶子"] });
  assert.equal(deriveSummary(n), "标题行");
});

test("deriveSummary：无 content 用首条叶子", () => {
  assert.equal(deriveSummary(node({ leaves: ["第一条", "第二条"] })), "第一条");
});

test("deriveSummary：无 content/叶子则拼子节点标题（可关）", () => {
  const n = node({ children: [node({ title: "甲" }), node({ title: "乙" })] });
  assert.equal(deriveSummary(n), "甲、乙");
  assert.equal(deriveSummary(n, { childTitles: false }), "");
});

test("deriveSummary：超长截断加省略号", () => {
  const long = "字".repeat(200);
  const s = deriveSummary(node({ leaves: [long] }), { maxLen: 10 });
  assert.equal(s.length, 10);
  assert.ok(s.endsWith("…"));
});

test("summaryHash：随叶子/子节点标题变化", () => {
  const a = node({ title: "t", leaves: ["x"] });
  const b = node({ title: "t", leaves: ["y"] });
  assert.equal(summaryHash(a), summaryHash(node({ title: "t", leaves: ["x"] })));
  assert.notEqual(summaryHash(a), summaryHash(b));
});

test("effectiveSummary：显式有效则用显式，否则推导", () => {
  const n = node({ leaves: ["推导值"] });
  n.summary = "显式值";
  n.summaryHash = summaryHash(n);
  assert.equal(effectiveSummary(n), "显式值");
  n.summaryHash = "过时";
  assert.equal(effectiveSummary(n), "推导值");
});

// ---------- MemoryFile 集成 ----------

test("writeSummary/getSummary：写入、幂等、清除", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "事实一");
  const r = await mf.writeSummary("工作/甲", "手写摘要");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(mf.getSummary("工作/甲"), "手写摘要");
  const again = await mf.writeSummary("工作/甲", "手写摘要");
  assert.equal(again.changed, false);
  await mf.writeSummary("工作/甲", "");
  assert.equal(mf.getSummary("工作/甲"), "事实一", "清除后回退首条叶子");
});

test("显式摘要陈旧后回退推导", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "旧事实");
  await mf.writeSummary("工作/甲", "手写摘要");
  assert.equal(mf.getSummary("工作/甲"), "手写摘要");
  await mf.upsertNode("工作/甲", "新事实");
  assert.equal(mf.getSummary("工作/甲"), "旧事实", "hash 不符 → 回退首条叶子");
});

test("持久化：重开库后摘要仍在（含 hash）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-summary-persist-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/甲", "事实一");
  await mf.writeSummary("工作/甲", "手写摘要");
  const mf2 = await MemoryFile.open(dir);
  assert.equal(mf2.getSummary("工作/甲"), "手写摘要");
});

test("applyOps：set_summary 写摘要，无关节点不受影响", async () => {
  const mf = await file();
  await mf.upsertNode("工作/子", "事实");
  await mf.upsertNode("工作/甲", "别的");
  await mf.applyOps([{ op: "set_summary", path: "工作/子", summary: "子摘要" }]);
  assert.equal(mf.getSummary("工作/子"), "子摘要");
});

test("restoreRevision 恢复摘要", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "事实");
  const rev = await mf.writeSummary("工作/甲", "v1 摘要");
  await mf.writeSummary("工作/甲", "v2 摘要");
  assert.equal(mf.getSummary("工作/甲"), "v2 摘要");
  await mf.restoreRevision(Number(rev.revision));
  assert.equal(mf.getSummary("工作/甲"), "v1 摘要");
});

test("tocDigest：读者用摘要；无 content/叶子时不重复子标题", () => {
  const root = parseMarkdown("# Memory\n\n## 工作\n- 事实一\n\n## 空域\n### 子甲\n- x\n");
  const toc = tocDigest(root);
  assert.match(toc, /- 工作 \[1\]：事实一/);
  assert.match(toc, /- 空域/);
  assert.doesNotMatch(toc, /空域.*：子甲/);
});

test("search 命中携带有效摘要", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "关键词 alpha");
  await mf.writeSummary("工作/甲", "甲节点摘要");
  const hits = mf.search("alpha");
  assert.equal(hits[0] .summary, "甲节点摘要");
});

test("迁移：旧库（无 summary 列）打开时自动补列", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-summary-migrate-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/甲", "事实");
  // 模拟旧库：删掉 summary 列
  const db = new DatabaseSync(join(dir, ".memory", "memory.db"));
  db.exec("ALTER TABLE nodes DROP COLUMN summary");
  db.exec("ALTER TABLE nodes DROP COLUMN summary_hash");
  db.close();
  // 重新打开应自动补列
  const mf2 = await MemoryFile.open(dir);
  const r = await mf2.writeSummary("工作/甲", "迁移后摘要");
  assert.equal(r.ok, true);
  assert.equal(mf2.getSummary("工作/甲"), "迁移后摘要");
});
