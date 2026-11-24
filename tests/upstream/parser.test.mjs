/**
 * Ported from memory-x packages/core/tests/parser.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ParseError, parseMarkdown } from "../../core/parser.js";
import { serializeMarkdown } from "../../core/serializer.js";

const DOC = `# Memory

## 工作

### pi 生态调研
- RPC 模式与 SDK 是兄弟关系，共享 core 层
- pi-web 用 SDK 进程内嵌入，Next.js 全栈

#### 待办
- 验证 SQLite 镜像方案的崩溃窗口

## 生活
- 每周三体检提醒
`;

test("解析完整文档为树", () => {
  const root = parseMarkdown(DOC);
  assert.equal(root.title, "Memory");
  assert.equal(root.children.length, 2);
  const work = root.children[0] ;
  assert.equal(work.title, "工作");
  assert.equal(work.leaves.length, 0);
  const research = work.children[0] ;
  assert.equal(research.title, "pi 生态调研");
  assert.equal(research.leaves.length, 2);
  assert.equal(research.leaves[0], "RPC 模式与 SDK 是兄弟关系，共享 core 层");
  const todo = research.children[0] ;
  assert.equal(todo.title, "待办");
  assert.equal(todo.leaves[0], "验证 SQLite 镜像方案的崩溃窗口");
  const life = root.children[1] ;
  assert.equal(life.leaves[0], "每周三体检提醒");
});

test("规范往返：serialize(parse(x)) === x", () => {
  assert.equal(serializeMarkdown(parseMarkdown(DOC)), DOC);
});

test("缺少根标题报错", () => {
  assert.throws(() => parseMarkdown("## 工作\n- x\n"), ParseError);
});

test("根标题重名报错", () => {
  assert.throws(() => parseMarkdown("# Memory\n\n# Memory\n"), ParseError);
});

test("根标题必须是 Memory", () => {
  assert.throws(() => parseMarkdown("# 脑图\n\n## 工作\n"), ParseError);
});

test("标题层级跳跃报错（H2 后直接 H4）", () => {
  assert.throws(
    () => parseMarkdown("# Memory\n\n## 工作\n\n#### 深层\n- x\n"),
    /层级跳跃/,
  );
});

test("标题含禁用字符报错", () => {
  assert.throws(() => parseMarkdown("# Memory\n\n## a/b\n"), ParseError);
  assert.throws(() => parseMarkdown("# Memory\n\n## a[1]\n"), ParseError);
});

test("根节点下直接挂列表报错", () => {
  assert.throws(() => parseMarkdown("# Memory\n- 不允许\n"), ParseError);
});

test("无法识别的行报错", () => {
  assert.throws(() => parseMarkdown("# Memory\n\n## 工作\n随便一段散文\n"), ParseError);
});

test("空行容忍：多余空行不影响解析", () => {
  const root = parseMarkdown("# Memory\n\n\n## 工作\n\n\n- a\n\n\n");
  assert.equal(root.children[0] .leaves[0], "a");
});
