/**
 * Ported from memory-x packages/core/tests/roundtrip.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "../../core/parser.js";
import { serializeMarkdown } from "../../core/serializer.js";
                                                  

/** 种子 PRNG（mulberry32）：fuzz 可复现 */
function rng(seed        )               {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = ["工作", "项目", "调研", "待办", "笔记", "生活", "长期", "临时", "pi", "架构"];
const LEAVES = [
  "RPC 与 SDK 共享 core 层",
  "turn_end 是 actionable hook",
  "agent_settled 才是空闲信号",
  "bge-small-zh 本地向量",
  "路径寻址对 LLM 最自然",
  "宁缺毋滥",
  "git 即版本系统",
  "trigram 对中文友好",
];

function randomTree(r              )             {
  const root             = { title: "Memory", leaves: [], children: [] };
  const build = (parent            , depth        ) => {
    if (depth >= 4) return;
    const n = Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      // 从小池子取标题 → 高概率重名，锻炼消歧与序列化
      const title = TITLES[Math.floor(r() * TITLES.length)] ;
      const node             = { title, leaves: [], children: [] };
      const leaves = Math.floor(r() * 4);
      for (let j = 0; j < leaves; j++) {
        node.leaves.push(LEAVES[Math.floor(r() * LEAVES.length)] );
      }
      parent.children.push(node);
      build(node, depth + 1);
    }
  };
  build(root, 0);
  return root;
}

test("fuzz：50 棵随机树的往返稳定性", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed);
    const t1 = randomTree(r);
    const md1 = serializeMarkdown(t1);
    const t2 = parseMarkdown(md1); // 不抛错即文法合法
    const md2 = serializeMarkdown(t2);
    assert.equal(md2, md1, `seed=${seed}：二次序列化漂移`);
    assert.deepEqual(t2, t1, `seed=${seed}：树往返不等`);
  }
});
