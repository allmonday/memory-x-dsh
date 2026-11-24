/**
 * Ported from memory-x packages/core/tests/search.test.ts (7fbd36c) by
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
import { escapeLike } from "../../core/index.js";

async function seeded()                                           {
  const dir = await mkdtemp(join(tmpdir(), "mx-search-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/pi生态调研", "RPC 模式与 SDK 模式是兄弟关系");
  await mf.upsertNode("工作/pi生态调研", "pi-web 用 SDK 进程内嵌入");
  await mf.writeNote(
    "工作/pi生态调研",
    "完整调研正文：包含 SQLite 镜像方案与崩溃窗口分析，信源为官方文档。",
  );
  await mf.upsertNode("生活/健康", "每周三体检提醒");
  return { dir, mf };
}

test("FTS 命中：≥3 字词走 trigram（bm25+snippet），返回完整链路/祖先/兄弟", async () => {
  const { mf } = await seeded();
  const hits = mf.search("生态调研"); // 4 字 → trigram
  assert.equal(hits.length, 1);
  const h = hits[0] ;
  assert.equal(h.path, "工作/pi生态调研");
  assert.deepEqual(h.ancestors, ["工作"]);
  assert.ok(h.siblings.includes("pi生态调研"), "兄弟应含自身（同层节点）");
  assert.equal(h.hasContent, true);
  assert.equal(h.leafCount, 2);
  assert.equal(h.via, "fts");
});

test("中文双字词（trigram 不可用）自动落 LIKE 兜底", async () => {
  const { mf } = await seeded();
  const hits = mf.search("调研"); // 2 字
  assert.equal(hits.length, 1);
  assert.equal(hits[0] .path, "工作/pi生态调研");
  assert.equal(hits[0] .via, "like");
});

test("content 正文命中（RAG 语料）", async () => {
  const { mf } = await seeded();
  const hits = mf.search("崩溃窗口");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0] .path, "工作/pi生态调研");
  assert.match(hits[0] .snippet, /崩溃窗口|…/);
});

test("LIKE 兜底：2 字短词（trigram 无法命中）", async () => {
  const { mf } = await seeded();
  const hits = mf.search("体检");
  assert.equal(hits.length, 1);
  assert.equal(hits[0] .path, "生活/健康");
  assert.equal(hits[0] .via, "like");
});

test("CJK 长词滑窗拆分：整句可命中包含其片段的文档", async () => {
  const { mf } = await seeded();
  // 整句作为子串匹配不到；滑窗 trigram 后应命中含「镜像方案」的 content
  const hits = mf.search("镜像方案的细节是什么");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0] .path, "工作/pi生态调研");
});

test("无命中返回空；topK 生效", async () => {
  const { mf } = await seeded();
  assert.equal(mf.search("完全不存在的词汇xyzq").length, 0);
  const all = mf.search("调研 pi", 1);
  assert.ok(all.length <= 1);
});

test("访问信号：search/read 记录 hits 与 last_hit", async () => {
  const { dir, mf } = await seeded();
  mf.search("调研");
  mf.recordAccess("工作/pi生态调研");
  const db = new DatabaseSync(join(dir, ".memory", "memory.db"), { readOnly: true });
  const row = db
    .prepare("SELECT hits FROM access WHERE path = ?")
    .get("工作/pi生态调研")                                ;
  assert.ok(row);
  assert.ok(row .hits >= 2);
});

test("旧库（无 FTS 数据）打开时自动补建索引", async () => {
  const { dir } = await seeded();
  // 模拟旧库：清空 FTS
  const db = new DatabaseSync(join(dir, ".memory", "memory.db"));
  db.exec("DELETE FROM memory_fts");
  db.close();

  const mf2 = await MemoryFile.open(dir);
  const hits = mf2.search("调研");
  assert.equal(hits.length, 1);
});

test("停用词：纯虚词查询返回空，不进 LIKE 兜底", async () => {
  const { mf } = await seeded();
  assert.equal(mf.search("什么 怎么").length, 0);
  assert.equal(mf.search("帮我看看").length, 0);
  assert.equal(mf.search("the a of").length, 0);
});

test("信号加成：高频访问的节点排序上升", async () => {
  const dir = (await seeded()).dir;
  const mf = await MemoryFile.open(dir);
  // 两个节点都含「调研」，给 工作方向 大量访问信号
  await mf.upsertNode("工作方向", "主题：儿童识字调研");
  for (let i = 0; i < 10; i++) mf.recordAccess("工作方向");
  const hits = mf.search("调研");
  assert.ok(hits.length >= 2);
  assert.equal(hits[0] .path, "工作方向", "访问频次应提升排序");
  assert.ok(hits[0] .score > hits[1] .score);
});

test("SearchHit 携带 score 字段", async () => {
  const { mf } = await seeded();
  const h = mf.search("生态调研")[0] ;
  assert.ok(typeof h.score === "number" && h.score > 0);
});

test("写入后索引自动刷新（新内容可搜）", async () => {
  const { mf } = await seeded();
  await mf.upsertNode("项目/新项目", "火山引擎函数计算调研");
  const hits = mf.search("函数计算");
  assert.equal(hits[0] .path, "项目/新项目");
});

test("检索不把根节点当命中（根标题 'Memory' 不再污染结果）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-search-root-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/调研", "Memory 管理策略"); // 含 memory 的真节点
  const hits = mf.search("memory");
  assert.ok(hits.some((h) => h.path === "工作/调研"), "真节点应命中");
  assert.ok(hits.every((h) => h.path !== ""), "不应返回根节点空路径");
});

// ---------- scope 限定子树（P1） ----------

async function scoped()                      {
  const dir = await mkdtemp(join(tmpdir(), "mx-scope-"));
  const mf = await MemoryFile.open(dir);
  await mf.upsertNode("工作/甲", "共用关键词 alpha");
  await mf.upsertNode("生活/乙", "共用关键词 alpha");
  await mf.upsertNode("工作2/丙", "边界关键词 gamma");
  await mf.upsertNode("工作/丁", "边界关键词 gamma");
  return mf;
}

test("scope 限定子树：只回该子树命中，且自身节点也算", async () => {
  const mf = await scoped();
  const all = mf.search("alpha");
  assert.equal(all.length, 2, "不传 scope 时全树命中");
  const scoped1 = mf.search("alpha", 5, "工作");
  assert.equal(scoped1.length, 1);
  assert.equal(scoped1[0] .path, "工作/甲");
  // 指向命中节点自身
  const self = mf.search("alpha", 5, "工作/甲");
  assert.equal(self.length, 1);
  assert.equal(self[0] .path, "工作/甲");
});

test("scope 前缀边界：'工作' 不误伤 '工作2'", async () => {
  const mf = await scoped();
  const scopedHits = mf.search("gamma", 5, "工作");
  assert.deepEqual(
    scopedHits.map((h) => h.path),
    ["工作/丁"],
    "'工作2/丙' 不应被 '工作/' 前缀命中",
  );
});

test("scope 指向根（或空）＝全树", async () => {
  const mf = await scoped();
  const rootScope = mf.search("alpha", 5, "");
  assert.equal(rootScope.length, 2);
});

test("scope 不存在返回空；模糊解析可容错", async () => {
  const mf = await scoped();
  assert.deepEqual(mf.search("alpha", 5, "根本没有的节点"), []);
  // '工昨' 编辑距离 1，容错命中 '工作'
  const fuzzy = mf.search("alpha", 5, "工昨");
  assert.deepEqual(
    fuzzy.map((h) => h.path),
    ["工作/甲"],
  );
});

test("escapeLike 转义 LIKE 通配符（%/_/\\）", () => {
  assert.equal(escapeLike("a%b_c\\d"), "a\\%b\\_c\\\\d");
  assert.equal(escapeLike("普通路径"), "普通路径");
});
