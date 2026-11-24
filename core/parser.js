                                             

export const ROOT_TITLE = "Memory";
export const MAX_DEPTH = 5; // H2..H6

export class ParseError extends Error {
           line        ;

  constructor(message        , line        ) {
    super(`第 ${line} 行：${message}`);
    this.name = "ParseError";
    this.line = line;
  }
}

const HEADING_RE = /^(#{1,6}) (.+)$/;
const BULLET_RE = /^- (.+)$/;
const FENCE_RE = /^(`{3,})\s*$/;
/** 标题禁用字符：'/'（路径分隔）、'['（消歧语法） */
const TITLE_FORBIDDEN = /[/[]/;

/**
 * 解析 MEMORY.md 文法为记忆树。
 *
 * 文法（严格模式，无法识别的行直接报错）：
 * - `# Memory` 唯一根
 * - `##`..`######` 标题 = 结构节点，层级不允许跳跃（如 H2 后直接 H4）
 * - `- xxx` 列表 = 当前节点的叶子事实
 * - ``` fenced block = 当前节点的完整信息（content），块内为原文
 * - 空行 = 分隔，无语义
 */
export function parseMarkdown(md        )             {
  const root             = { title: ROOT_TITLE, leaves: [], children: [] };
  // stack[0] = 根（深度 0）；stack[i] = 当前深度 i 的节点
  const stack               = [root];
  let sawRoot = false;

  const lines = md.split("\n");
  let inFence = false;
  let fenceMark = "";
  const contentLines           = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] .trimEnd();

    if (inFence) {
      if (line === fenceMark) {
        stack[stack.length - 1] .content = contentLines.join("\n");
        inFence = false;
      } else {
        contentLines.push(lines[i] ); // fence 内保留原始行（不 trimEnd）
      }
      continue;
    }
    if (line === "") continue;

    const fm = FENCE_RE.exec(line);
    if (fm) {
      if (!sawRoot || stack.length < 2) {
        throw new ParseError("content 块必须位于结构节点标题之下", i + 1);
      }
      inFence = true;
      fenceMark = fm[1] ;
      contentLines.length = 0;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2] .trim();
      if (level === 1) {
        if (sawRoot) throw new ParseError(`"${ROOT_TITLE}" 根标题只能出现一次`, i + 1);
        if (title !== ROOT_TITLE) throw new ParseError(`根标题必须是 "# ${ROOT_TITLE}"，实际 "${title}"`, i + 1);
        sawRoot = true;
        continue;
      }
      if (!sawRoot) throw new ParseError(`首个标题必须是 "# ${ROOT_TITLE}"`, i + 1);
      const titleErr = validateTitle(title);
      if (titleErr) throw new ParseError(titleErr, i + 1);

      const depth = level - 1; // 1..5
      if (depth > stack.length) {
        throw new ParseError(
          `标题层级跳跃："${"#".repeat(level)} ${title}" 出现在第 ${stack.length} 层节点之下`,
          i + 1,
        );
      }
      if (depth > MAX_DEPTH) throw new ParseError(`标题层级不能深于 H${MAX_DEPTH + 1}`, i + 1);
      stack.length = depth; // 回退到父层
      const node             = { title, leaves: [], children: [] };
      stack[depth - 1] .children.push(node);
      stack.push(node);
      continue;
    }

    const b = BULLET_RE.exec(line);
    if (b) {
      if (!sawRoot || stack.length < 2) {
        throw new ParseError("列表项必须位于结构节点标题之下（根节点不挂叶子）", i + 1);
      }
      const leaf = b[1] .trim();
      if (leaf === "") throw new ParseError("列表项内容为空", i + 1);
      stack[stack.length - 1] .leaves.push(leaf);
      continue;
    }

    throw new ParseError(`无法识别的行（文法仅支持标题 / 列表 / 空行）："${line.slice(0, 40)}"`, i + 1);
  }

  if (!sawRoot) throw new ParseError(`缺少根标题 "# ${ROOT_TITLE}"`, lines.length);
  if (inFence) throw new ParseError("content 块未闭合", lines.length);
  return root;
}

function validateTitle(title        )                     {
  if (title === "") return "标题为空";
  if (TITLE_FORBIDDEN.test(title)) return `标题含禁用字符（"/" 或 "["）："${title}"`;
  return undefined;
}
