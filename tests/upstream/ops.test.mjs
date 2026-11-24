/**
 * Ported from memory-x packages/core/tests/ops.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteNode, moveNode, upsertNode } from "../../core/ops.js";
import { parseMarkdown } from "../../core/parser.js";
import { resolvePath } from "../../core/path.js";
import { serializeMarkdown } from "../../core/serializer.js";

test("upsert 创建缺失的中间节点并追加叶子", () => {
  const root = parseMarkdown("# Memory\n\n## 工作\n");
  const r = upsertNode(root, "工作/pi生态调研/架构结论", "RPC 与 SDK 共享 core 层");
  assert.equal(r.changed, true);
  assert.deepEqual(r.createdNodes, ["pi生态调研", "架构结论"]);
  const node = resolvePath(root, "工作/pi生态调研/架构结论") ;
  assert.equal(node.node.leaves[0], "RPC 与 SDK 共享 core 层");
});

test("upsert 精确重复是幂等 no-op", () => {
  const root = parseMarkdown("# Memory\n\n## 工作\n- 事实一\n");
  const r = upsertNode(root, "工作", "事实一");
  assert.equal(r.changed, false);
  assert.equal(resolvePath(root, "工作") .node.leaves.length, 1);
});

test("upsert 消歧段复用既有同名节点", () => {
  const root = parseMarkdown("# Memory\n\n## 项目\n### 新版\n\n## 项目\n### 旧版\n");
  upsertNode(root, "项目[2]", "旧版笔记");
  assert.equal(resolvePath(root, "项目") .node.children[0] .title, "新版");
  assert.equal(resolvePath(root, "项目[2]") .node.leaves[0], "旧版笔记");
});

test("move 移动子树且防环", () => {
  const root = parseMarkdown("# Memory\n\n## A\n### 子\n- x\n\n## B\n");
  assert.equal(moveNode(root, "A/子", "B"), true);
  assert.equal(resolvePath(root, "A/子"), null);
  assert.equal(resolvePath(root, "B/子") .node.leaves[0], "x");
  // 把 B 移到自己的子孙下 → 拒绝
  assert.equal(moveNode(root, "B", "B/子"), false);
});

test("delete 删除子树", () => {
  const root = parseMarkdown("# Memory\n\n## A\n### 子\n\n## B\n");
  assert.equal(deleteNode(root, "A/子"), true);
  assert.equal(resolvePath(root, "A") .node.children.length, 0);
  assert.equal(deleteNode(root, "不存在"), false);
});
