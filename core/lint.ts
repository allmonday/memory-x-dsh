import type { MemoryNode } from "./types.js";

export interface LintIssue {
  level: "warn" | "info";
  rule: string;
  path: string;
  message: string;
}

export interface LintOptions {
  /** 深于该层提示提升（文法硬上限 5） */
  maxDepth?: number;
  /** 子节点少于该数且自身无叶子 → 冗余层 */
  minChildren?: number;
  /** 子节点多于该数 → 建议分裂 */
  maxChildren?: number;
  /** 叶子多于该数 → 建议分叉 */
  maxLeaves?: number;
  /** 顶层域上限（骨架克制） */
  maxTopDomains?: number;
  /** 叶子字符数上限（写入规范：短句） */
  maxLeafChars?: number;
}

const TIME_NAME_RE = /(19|20)\d{2}\s*年|第?[1-4]季度|\bQ[1-4]\b/;
/** 含糊/修饰词（写入规范：去修饰） */
const VAGUE_RE = /(大约|大概|可能|也许|似乎|非常|很多|一些|尽量|基本上|差不多|左右|或许|应该会)/;

/**
 * 结构体检：目录最佳实践的机器可判定子集。
 * 拓扑（深度/广度/叶子堆叠/一对一链）+ 命名（重名/时间性命名/顶层克制）。
 * 只报告不修改——修复交给 tidy（做梦）或人。
 */
export function lintTree(root: MemoryNode, opts: LintOptions = {}): LintIssue[] {
  const maxDepth = opts.maxDepth ?? 4;
  const minChildren = opts.minChildren ?? 3; // 供 breadth 语义参考（保留扩展口）
  const maxChildren = opts.maxChildren ?? 9;
  const maxLeaves = opts.maxLeaves ?? 20;
  const maxTopDomains = opts.maxTopDomains ?? 7;
  const maxLeafChars = opts.maxLeafChars ?? 60;

  const issues: LintIssue[] = [];

  const dupAmong = (siblings: MemoryNode[], parentPath: string) => {
    const seen = new Map<string, number>();
    for (const c of siblings) {
      seen.set(c.title, (seen.get(c.title) ?? 0) + 1);
    }
    for (const [title, n] of seen) {
      if (n > 1) {
        issues.push({
          level: "info",
          rule: "dup-title",
          path: parentPath ? `${parentPath}/${title}` : title,
          message: `兄弟重名「${title}」×${n}——[n] 寻址可用但有成本，建议更具辨识度的命名`,
        });
      }
    }
  };
  dupAmong(root.children, "");

  if (root.children.length > maxTopDomains) {
    issues.push({
      level: "warn",
      rule: "top-domains",
      path: "",
      message: `顶层域 ${root.children.length} 个超过 ${maxTopDomains}——顶层是常驻注入的骨架，新增域要克制；考虑合并或把部分下沉`,
    });
  }

  const walk = (node: MemoryNode, segs: string[], depth: number) => {
    const path = segs.join("/");
    const children = node.children;

    if (depth > maxDepth) {
      issues.push({
        level: "warn",
        rule: "depth",
        path,
        message: `已达第 ${depth} 层（建议 ≤${maxDepth}）——深埋的内容通常是新主题信号，考虑提升为兄弟节点`,
      });
    }
    if (children.length === 1 && node.leaves.length === 0 && depth >= 1) {
      issues.push({
        level: "info",
        rule: "redundant-layer",
        path,
        message: `仅有一个子节点且自身无叶子——一对一传导层零信息量，考虑塌陷（子节点上提一层）`,
      });
    }
    if (children.length > maxChildren) {
      issues.push({
        level: "warn",
        rule: "breadth",
        path,
        message: `子节点 ${children.length} 个超过 ${maxChildren}——缺一条分类轴，考虑按子主题再分一层`,
      });
    }
    if (node.leaves.length > maxLeaves) {
      issues.push({
        level: "warn",
        rule: "leaf-pile",
        path,
        message: `叶子 ${node.leaves.length} 条超过 ${maxLeaves}——某类事实在扎堆，考虑分叉子节点`,
      });
    }
    if (depth >= 1 && depth <= 2 && TIME_NAME_RE.test(node.title)) {
      issues.push({
        level: "warn",
        rule: "temporal-name",
        path,
        message: `稳定层含时间性命名「${node.title}」——会腐烂；时间放叶子的 ← 日期 标注，不进结构`,
      });
    }

    // 写入规范（借 STE）：短句 / 一句一事 / 去修饰；原文重要时引用保留
    for (const lf of node.leaves) {
      if (lf.length > maxLeafChars) {
        issues.push({ level: "info", rule: "style-long", path, message: `叶子偏长（${lf.length} 字，建议 ≤${maxLeafChars}）——拆成短句：${lf.slice(0, 24)}…` });
      }
      if (VAGUE_RE.test(lf)) {
        issues.push({ level: "info", rule: "style-vague", path, message: `叶子含含糊/修饰词——去修饰、写确定事实：${lf.slice(0, 24)}…` });
      }
      if (lf.includes("；") || (lf.match(/，/g)?.length ?? 0) >= 2) {
        issues.push({ level: "info", rule: "style-multi", path, message: `叶子疑似一句多事——一条一事拆分：${lf.slice(0, 24)}…` });
      }
    }
    if (node.content && node.content.length > 200 && !node.content.split("\n").some((l) => l.trimStart().startsWith(">"))) {
      issues.push({ level: "info", rule: "style-quote", path, message: "content 较长但无引用块——若含重要原文/摘要，用 `> …` 原样保留以免改写失真" });
    }

    // 兄弟重名
    dupAmong(children, path);

    for (const c of children) walk(c, [...segs, c.title], depth + 1);
  };
  for (const c of root.children) walk(c, [c.title], 1);

  return issues;
}

/**
 * 归类建议（自动生成树状结构的决策程序核心，M2 地基）：
 * 事实文本 → 与各节点标题的词汇重合度 → 候选路径（浅层优先）。
 * 调用方决定未命中时的策略（新主题 / 收件箱）。
 */
export function suggestPath(root: MemoryNode, fact: string, maxCandidates = 3): string[] {
  const tokens = (fact.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  interface Cand {
    path: string;
    score: number;
    depth: number;
  }
  const cands: Cand[] = [];
  const walk = (node: MemoryNode, segs: string[], depth: number) => {
    let score = 0;
    for (const t of tokens) {
      if (node.title.includes(t)) score += t.length; // 长词重合权重更高
    }
    if (score > 0 && depth >= 1) cands.push({ path: segs.join("/"), score, depth });
    for (const c of node.children) walk(c, [...segs, c.title], depth + 1);
  };
  walk(root, [], 0);

  // 同分浅层优先（能挂浅层不深埋）；去重
  const seen = new Set<string>();
  return cands
    .sort((a, b) => b.score - a.score || a.depth - b.depth)
    .filter((c) => (seen.has(c.path) ? false : seen.add(c.path)))
    .slice(0, maxCandidates)
    .map((c) => c.path);
}
