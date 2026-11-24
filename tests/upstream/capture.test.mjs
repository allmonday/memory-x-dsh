/**
 * Ported from memory-x packages/core/tests/capture.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../../core/memory-file.js";
import { diffTrees, diffToChangeRows } from "../../core/tree-diff.js";
import { leafHash } from "../../core/store.js";
                                                  

async function file()                      {
  const dir = await mkdtemp(join(tmpdir(), "mx-capture-"));
  return MemoryFile.open(dir);
}

// ---------- episodes ----------

test("episodes：追加 / 列出 / 计数 / 会话过滤", async () => {
  const mf = await file();
  const ids = mf.captureEpisodes("s1", [
    { role: "user", kind: "user", text: "你好" },
    { role: "assistant", kind: "assistant", text: "在的" },
    { role: "tool", kind: "tool_result", text: "输出", toolName: "bash" },
  ]);
  assert.equal(ids.length, 3);
  assert.equal(mf.countEpisodes(), 3);
  const all = mf.listEpisodes({ limit: 10 });
  assert.deepEqual(all.map((e) => e.text), ["你好", "在的", "输出"]);
  assert.equal(all[2] .toolName, "bash");
  const s1 = mf.listEpisodes({ sessionId: "s1", limit: 10 });
  assert.equal(s1.length, 3);
  assert.equal(mf.listEpisodes({ sessionId: "nope", limit: 10 }).length, 0);
  const since = mf.listEpisodes({ sinceId: ids[0] , limit: 10 });
  assert.deepEqual(since.map((e) => e.text), ["在的", "输出"]);
});

test("episodes：prune 保留最新，级联删除 evidence", async () => {
  const mf = await file();
  const ids = mf.captureEpisodes(null, [
    { role: "user", kind: "user", text: "a" },
    { role: "user", kind: "user", text: "b" },
    { role: "user", kind: "user", text: "c" },
  ]);
  mf.linkEvidence("工作/甲", "事实", [ids[0] , ids[1] ]);
  assert.equal(mf.evidenceFor("工作/甲", "事实").length, 2);
  const removed = mf.pruneEpisodes(1);
  assert.equal(removed, 2);
  assert.equal(mf.countEpisodes(), 1);
  assert.equal(mf.evidenceFor("工作/甲", "事实").length, 0, "被裁剪事件的 evidence 应级联删除");
});

test("evidence：按节点 / 按叶子指纹查询", async () => {
  const mf = await file();
  const [e1, e2] = mf.captureEpisodes("s", [
    { role: "user", kind: "user", text: "第一条来源" },
    { role: "user", kind: "user", text: "第二条来源" },
  ]);
  mf.linkEvidence("工作/甲", "叶子一", [e1 ]);
  mf.linkEvidence("工作/甲", "叶子二", [e2 ]);
  assert.equal(mf.evidenceFor("工作/甲").length, 2);
  const one = mf.evidenceFor("工作/甲", "叶子一");
  assert.equal(one.length, 1);
  assert.equal(one[0] .episodeId, e1);
  assert.equal(one[0] .leafHash, leafHash("叶子一"));
  assert.equal(mf.evidenceFor("工作/甲", "不存在").length, 0);
});

// ---------- 变更审计 ----------

test("changes：写入自动记录 add/add-node，删除记录 remove", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "事实一");
  let changes = mf.listChanges({ limit: 100 });
  assert.ok(changes.some((c) => c.op === "add" && c.path === "工作/甲" && c.toText === "事实一"));
  assert.ok(changes.some((c) => c.op === "add-node" && c.path === "工作/甲"));
  await mf.deleteNode("工作/甲");
  changes = mf.listChanges({ limit: 100 });
  assert.ok(changes.some((c) => c.op === "remove-node" && c.path === "工作/甲"));
});

test("changes：update 记录旧值→新值；writeSummary 记录 note-summary", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "旧");
  await mf.updateNode("工作/甲", "旧", "新");
  await mf.writeSummary("工作/甲", "摘要");
  const changes = mf.listChanges({ limit: 100 });
  assert.ok(changes.some((c) => c.op === "update" && c.fromText === "旧" && c.toText === "新"), "update 一行携 from→to");
  assert.ok(changes.some((c) => c.op === "note-summary" && c.path === "工作/甲"));
});

test("changes：带 revision_id，可按版本查询", async () => {
  const mf = await file();
  const r = await mf.upsertNode("工作/甲", "事实");
  const rev = Number(r.revision);
  const forRev = mf.listChanges({ revisionId: rev });
  assert.ok(forRev.length > 0);
  assert.ok(forRev.every((c) => c.revisionId === rev));
});

// ---------- tree diff ----------

const node = (o                     )             => ({ title: "t", leaves: [], children: [], ...o });

test("diffTrees：节点/叶子增删 + content/summary 变更", () => {
  const base = node({ children: [node({ title: "甲", leaves: ["a"], content: "旧正文" })] });
  const next = node({
    children: [
      node({ title: "甲", leaves: ["a", "b"], content: "新正文", summary: "摘要" }),
      node({ title: "乙", leaves: ["c"] }),
    ],
  });
  const d = diffTrees(base, next);
  assert.deepEqual(d.addedNodes.map((x) => x.path), ["乙"]);
  assert.deepEqual(d.addedLeaves.map((x) => `${x.path}:${x.leaf}`), ["甲:b", "乙:c"]);
  assert.deepEqual(d.removedLeaves, []);
  assert.ok(d.changedNotes.some((x) => x.kind === "content" && x.path === "甲"));
  assert.ok(d.changedNotes.some((x) => x.kind === "summary" && x.path === "甲"));
});

test("diffTrees：删除叶子与节点", () => {
  const base = node({ children: [node({ title: "甲", leaves: ["a", "b"] }), node({ title: "乙" })] });
  const next = node({ children: [node({ title: "甲", leaves: ["a"] })] });
  const d = diffTrees(base, next);
  assert.deepEqual(d.removedNodes.map((x) => x.path), ["乙"]);
  assert.deepEqual(d.removedLeaves.map((x) => x.leaf), ["b"]);
  const rows = diffToChangeRows(d);
  assert.ok(rows.some((r) => r.op === "remove-node" && r.path === "乙"));
  assert.ok(rows.some((r) => r.op === "remove" && r.from === "b"));
});

test("diffSince：相对历史版本的结构差异", async () => {
  const mf = await file();
  await mf.upsertNode("工作/甲", "一");
  const r = await mf.upsertNode("工作/乙", "二");
  const rev = Number(r.revision);
  await mf.upsertNode("工作/甲", "一之后");
  const d = mf.diffSince(rev);
  assert.ok(d);
  assert.deepEqual(d .addedLeaves.map((x) => x.leaf), ["一之后"]);
  assert.equal(mf.diffSince(999999), null);
});
