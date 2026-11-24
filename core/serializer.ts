import type { MemoryNode } from "./types.js";

/**
 * 序列化为规范 Markdown。
 * 规范形态：标题行 → 叶子列表 → 空行 → 子节点块；文件以单个换行结尾。
 * 保证 serialize(parse(x)) === x（当 x 已是规范形态时）。
 */
export function serializeMarkdown(root: MemoryNode): string {
  const out: string[] = [`# ${root.title}`, ""];
  for (const child of root.children) writeBlock(out, child, 1);
  return out.join("\n");
}

/** 序列化子树片段（无根标题），level 为该节点对应的标题层级（2 = ##）。 */
export function serializeSubtree(node: MemoryNode, level = 2): string {
  if (level > 6) throw new Error(`子树层级超出 H6："${node.title}"`);
  const out: string[] = [];
  writeBlock(out, node, level - 1);
  return out.join("\n");
}

/**
 * 序列化节点的「内容大纲」（叶子 + 子节点），**不含节点自身标题、不含 content**。
 * 只作只读 review 视图：局部整理（tidy）时给模型看的素材——content 不进 outline。
 */
export function serializeOutline(node: MemoryNode): string {
  const out: string[] = [];
  for (const leaf of node.leaves) out.push(`- ${leaf}`);
  const emit = (children: MemoryNode[], depth: number) => {
    for (const child of children) {
      if (out.length > 0) out.push("");
      out.push(`${"#".repeat(depth + 1)} ${child.title}`);
      for (const leaf of child.leaves) out.push(`- ${leaf}`);
      emit(child.children, depth + 1);
    }
  };
  emit(node.children, 1);
  return out.join("\n");
}

function writeBlock(out: string[], node: MemoryNode, depth: number) {
  out.push(`${"#".repeat(depth + 1)} ${node.title}`);
  for (const leaf of node.leaves) out.push(`- ${leaf}`);
  if (node.content != null) {
    const fence = contentFence(node.content);
    out.push("", fence, node.content, fence);
  }
  out.push("");
  for (const child of node.children) writeBlock(out, child, depth + 1);
}

/** 为 content 选一个不与其中反引号冲突的围栏：比最长连续反引号串长 1，且至少 3。 */
function contentFence(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}
