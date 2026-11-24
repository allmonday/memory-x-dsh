/**
 * Ported from memory-x packages/core/tests/path.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "../../core/parser.js";
import { resolvePath, splitDisambig } from "../../core/path.js";
import { serializeMarkdown } from "../../core/serializer.js";
                                                  

const DOC = `# Memory

## 工作
### pi 生态调研
- 结论 A

## 项目
### pi-web 集成
- 待办 B

## 项目
### 旧版迁移
- 笔记 C
`;

function tree()             {
  return parseMarkdown(DOC);
}

test("精确路径解析", () => {
  const r = resolvePath(tree(), "工作/pi 生态调研") ;
  assert.ok(r);
  assert.equal(r.node.leaves[0], "结论 A");
  assert.equal(r.parent .title, "工作");
});

test("兄弟重名消歧：项目[2]", () => {
  assert.equal(resolvePath(tree(), "项目") .node.children[0] .title, "pi-web 集成");
  assert.equal(resolvePath(tree(), "项目[2]") .node.children[0] .title, "旧版迁移");
  assert.equal(splitDisambig("项目[3]").nth, 3);
  assert.equal(splitDisambig("项目").nth, 1);
});

test("路径不存在返回 null", () => {
  assert.equal(resolvePath(tree(), "工作/不存在"), null);
  assert.equal(resolvePath(tree(), "项目[3]"), null);
});

test("末段模糊匹配（编辑距离容错）", () => {
  // "pi生态调研" vs "pi 生态调研"：差一个空格，距离 1 ≤ 阈值
  const r = resolvePath(tree(), "工作/pi生态调研", { fuzzy: true }) ;
  assert.ok(r);
  assert.equal(r.node.leaves[0], "结论 A");
  // fuzzy 关闭时同路径失败
  assert.equal(resolvePath(tree(), "工作/pi生态调研"), null);
  // 末段差一字符也能容错："pi-web 集成" vs "pi-web集成"
  const r2 = resolvePath(tree(), "项目/pi-web集成", { fuzzy: true }) ;
  assert.equal(r2.node.leaves[0], "待办 B");
});

test("模糊匹配不越阈值：距离过大不命中", () => {
  const r = resolvePath(tree(), "工作/完全无关的标题", { fuzzy: true });
  assert.equal(r, null);
});
