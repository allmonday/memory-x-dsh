                                             
import { effectiveSummary } from "./summary.js";

                             
                        
                    
                             
                    
                              
                      
 

/**
 * 目录摘要：`- 标题 [子树叶子总数]` 的缩进列表。
 * 用于注入 system prompt（P2：渐进披露，只给地图不给内容）。
 */
export function tocDigest(root            , opts             = {})         {
  const maxDepth = opts.maxDepth ?? 3;
  const maxChars = opts.maxChars ?? 1200;
  const withSummary = opts.summaries ?? true;
  const lines           = [];

  const countLeaves = (n            )         =>
    n.leaves.length + n.children.reduce((s, c) => s + countLeaves(c), 0);

  const walk = (n            , depth        ) => {
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

                              
                       
                 
 

/**
 * 整树导出（box-drawing 结构视图，全深度）。
 * `◆` 标记该节点有完整信息（content）。用于 /memory dump。
 */
export function dumpTree(root            , opts              = {})         {
  const lines           = ["# Memory"];

  const countLeaves = (n            )         =>
    n.leaves.length + n.children.reduce((s, c) => s + countLeaves(c), 0);

  const walk = (children              , prefix        ) => {
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
