import { createHash } from "node:crypto";
                                             

/** 摘要默认长度上限（L0 一行，用于导航判断相关性）。 */
export const SUMMARY_MAX_CHARS = 120;

                                 
                  
                                                           
                        
 

/**
 * 节点内容指纹：标题 + 叶子事实 + 直接子节点标题。
 * 用于判断「显式摘要」是否已陈旧（叶子/子节点变动后 hash 不符 → 回退推导摘要）。
 */
export function summaryHash(node            )         {
  const src = [node.title, ...node.leaves, ...node.children.map((c) => c.title)].join("\u0001");
  return createHash("sha1").update(src).digest("hex").slice(0, 16);
}

/** 取 content 的首个有意义行：跳过空行与围栏，剥掉 markdown 前缀。 */
function firstMeaningfulLine(text        )                {
  for (const raw of text.split("\n")) {
    let s = raw.trim();
    if (!s) continue;
    if (s.startsWith("```")) continue;
    s = s
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s?/, "")
      .trim();
    if (s) return s;
  }
  return null;
}

function clamp(s        , maxLen        )         {
  return s.length > maxLen ? `${s.slice(0, Math.max(1, maxLen - 1))}…` : s;
}

/**
 * 确定性推导摘要（无需 LLM）：content 首句 → 首条叶子 → 子节点标题拼接（可关）。
 * 始终可用、不腐坏，作为显式摘要缺失/陈旧时的兜底。
 */
export function deriveSummary(node            , opts                 = {})         {
  const maxLen = opts.maxLen ?? SUMMARY_MAX_CHARS;
  const fromContent = node.content ? firstMeaningfulLine(node.content) : null;
  const fromChildren =
    opts.childTitles === false || node.children.length === 0
      ? null
      : node.children.map((c) => c.title).join("、");
  const text = fromContent ?? node.leaves[0] ?? fromChildren ?? "";
  return text ? clamp(text, maxLen) : "";
}

/** 有效摘要：显式摘要且未陈旧则用它，否则回退确定性推导。 */
export function effectiveSummary(node            , opts                 = {})         {
  if (node.summary != null && node.summary !== "" && node.summaryHash === summaryHash(node)) {
    return clamp(node.summary, opts.maxLen ?? SUMMARY_MAX_CHARS);
  }
  return deriveSummary(node, opts);
}
