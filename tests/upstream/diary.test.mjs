/**
 * Ported from memory-x packages/core/tests/diary.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile } from "../../core/memory-file.js";

async function file()                      {
  const dir = await mkdtemp(join(tmpdir(), "mx-diary-"));
  return MemoryFile.open(dir);
}

/** 把全部 episodes/revisions 时间戳平移到指定历史日（03:00 UTC，东八区/UTC 机器均落在同一天） */
function shiftTime(mf            , utc        )       {
  const db = (mf       ).store.db;
  db.exec(`UPDATE episodes SET created_at = '${utc}'`);
  db.exec(`UPDATE revisions SET created_at = '${utc}'`);
}

test("dayDigest：按日聚合 sessions / 动过的节点 / 水位", async () => {
  const mf = await file();
  mf.captureEpisodes("sess-a", [
    { role: "user", kind: "user", text: "调研 hindsight 框架" },
    { role: "assistant", kind: "assistant", text: "好的，我先看本地项目。" },
    { role: "tool", kind: "tool_result", text: "ls 输出", toolName: "bash" },
  ]);
  mf.captureEpisodes("sess-b", [{ role: "user", kind: "user", text: "评估过拟合" }]);
  await mf.upsertNode("工作/日记测试/节点A", "事实一");
  shiftTime(mf, "2026-01-01 03:00:00");

  const d = mf.dayDigest("2026-01-01");
  assert.equal(d.empty, false);
  assert.equal(d.sessions.length, 2);
  assert.equal(d.sessions[0] .sessionId, "sess-a");
  assert.equal(d.sessions[0] .events, 3);
  assert.equal(d.sessions[0] .tools, 1);
  assert.equal(d.sessions[0] .replies, 1);
  assert.equal(d.sessions[0] .firstUser, "调研 hindsight 框架");
  assert.deepEqual(d.sessions[0] .userSamples, ["调研 hindsight 框架"]);
  assert.equal(d.sessions[1] .sessionId, "sess-b");
  assert.equal(d.sessions[1] .tools, 0);
  assert.equal(d.nodes.length, 1);
  assert.equal(d.nodes[0] .path, "工作/日记测试/节点A");
  assert.ok(d.nodes[0] .ops >= 1);
  const wm = d.watermark;
  assert.ok(wm.maxEpisodeId >= 4 && wm.maxRevisionId >= 1);

  // 无记录的日子
  assert.equal(mf.dayDigest("2026-05-05").empty, true);

  // 水位推进：当天再追加一条事件 → maxEpisodeId +1（缓存失效判定的基础）
  const [newId] = mf.captureEpisodes("sess-a", [{ role: "user", kind: "user", text: "追加一句" }]);
  (mf       ).store.db.exec(`UPDATE episodes SET created_at = '2026-01-01 03:05:00' WHERE id = ${newId}`);
  const d2 = mf.dayDigest("2026-01-01");
  assert.equal(d2.watermark.maxEpisodeId, wm.maxEpisodeId + 1);
  assert.equal(d2.sessions[0] .events, 4);
});

test("dayDigest：动过的节点取最深路径（祖先折叠）", async () => {
  const mf = await file();
  await mf.upsertNode("工作/项目甲/子节点/更深", "事实");
  shiftTime(mf, "2026-01-02 03:00:00");
  const d = mf.dayDigest("2026-01-02");
  assert.equal(d.nodes.length, 1);
  assert.equal(d.nodes[0] .path, "工作/项目甲/子节点/更深");
});

test("dayDigest：非法日期报错；今天默认可用", async () => {
  const mf = await file();
  assert.throws(() => mf.dayDigest("2026-1-1"));
  const local = new Date();
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  mf.captureEpisodes("now", [{ role: "user", kind: "user", text: "今天的事" }]);
  const d = mf.dayDigest(today);
  assert.equal(d.sessions.length, 1);
});
