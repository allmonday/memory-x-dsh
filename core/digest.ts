import type { MemoryNode } from "./types.js";
import { effectiveSummary } from "./summary.js";

export interface TocOptions {
  /** 目录展示的最大层级（默认 3） */
  maxDepth?: number;
  /** 输出字符上限（默认 1200，超出截断） */
  maxChars?: number;
  /** 是否在标题后附节点级摘要（默认 true） */
  summaries?: boolean;
}

/**
 * 目录摘要：`- 标题 [子树叶子总数]` 的缩进列表。
 * 用于注入 system prompt（P2：渐进披露，只给地图不给内容）。
 */
export function tocDigest(root: MemoryNode, opts: TocOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 3;
  const maxChars = opts.maxChars ?? 1200;
  const withSummary = opts.summaries ?? true;
  const lines: string[] = [];

  const countLeaves = (n: MemoryNode): number =>
    n.leaves.length + n.children.reduce((s, c) => s + countLeaves(c), 0);

  const walk = (n: MemoryNode, depth: number) => {
    if (depth > maxDepth) return;
    const total = countLeaves(n);
    // TOC 里关掉「子标题兜底」：子目录本来就会列在下面，重复无益
    const sum = withSummary ? effectiveSummary(n, { childTitles: false }) : "";
    const suffix = `${total > 0 ? ` [${total}]` : ""}${sum ? `：${sum}` : ""}`;
    lines.push(`${"  ".repeat(depth - 1)}- ${n.title}${suffix}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const c of root.children) walk(c, 1);

  if (lines.length === 0) return "（记忆树为空）";
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（已截断，用 memory_read 下钻）`;
  return out;
}

export interface DumpOptions {
  /** 包含叶子事实（默认只出结构） */
  full?: boolean;
}

/**
 * 整树导出（box-drawing 结构视图，全深度）。
 * `◆` 标记该节点有完整信息（content）。用于 /memory dump。
 */
export function dumpTree(root: MemoryNode, opts: DumpOptions = {}): string {
  const lines: string[] = ["# Memory"];

  const countLeaves = (n: MemoryNode): number =>
    n.leaves.length + n.children.reduce((s, c) => s + countLeaves(c), 0);

  const walk = (children: MemoryNode[], prefix: string) => {
    children.forEach((c, i) => {
      const last = i === children.length - 1;
      const branch = last ? "└─ " : "├─ ";
      const childPrefix = prefix + (last ? "   " : "│  ");
      const total = countLeaves(c);
      const mark = c.content != null ? " ◆" : "";
      lines.push(`${prefix}${branch}${c.title}${total > 0 ? ` [${total}]` : ""}${mark}`);
      if (opts.full) {
        for (const leaf of c.leaves) lines.push(`${childPrefix}  · ${leaf}`);
      }
      walk(c.children, childPrefix);
    });
  };
  walk(root.children, "");
  return lines.join("\n");
}
