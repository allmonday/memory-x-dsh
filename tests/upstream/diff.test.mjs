/**
 * Ported from memory-x packages/core/tests/diff.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats, formatDiff } from "../../core/diff.js";

test("diffLines：增删改识别", () => {
  const a = ["# Memory", "", "## 工作", "- 事实A", "- 事实B"];
  const b = ["# Memory", "", "## 工作", "- 事实A", "- 事实B2", "", "## 生活", "- 体检"];
  const diff = diffLines(a, b);
  const s = diffStats(diff);
  assert.equal(s.added, 4); // 事实B2 + 空行 + 生活 + 体检
  assert.equal(s.removed, 1); // 事实B
  const out = formatDiff(diff);
  assert.match(out, /- - 事实B/);
  assert.match(out, /\+ - 事实B2/);
  assert.match(out, /\+ ## 生活/);
});

test("diffStats：相同内容零变更", () => {
  const same = ["a", "b"];
  assert.deepEqual(diffStats(diffLines(same, [...same])), { added: 0, removed: 0 });
});
