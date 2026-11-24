import { resolvePath } from "./path.js";
import { stripDateMark } from "./ops.js";
import { summaryHash } from "./summary.js";
import type { MemoryNode } from "./types.js";

/**
 * 结构化批量操作（tidy 的写入原语）。
 *
 * 逐操作打补丁：只动被操作触碰的节点，未提及的节点一律不变；路径为精确匹配（区分 `[n]`）。
 * 一批操作由调用方在同一个 mutate 事务里按序应用；任一条失败即抛错，整批回滚。
 */
export type TreeOp =
  | { op: "add_leaf"; path: string; leaf: string }
  | { op: "update_leaf"; path: string; match: string; leaf: string }
  | { op: "remove_leaf"; path: string; match: string }
  | { op: "rename"; path: string; title: string }
  | { op: "move"; from: string; to: string }
  | { op: "add_node"; parent: string; title: string }
  | { op: "delete"; path: string }
  | { op: "set_note"; path: string; content: string | null }
  | { op: "set_summary"; path: string; summary: string | null };

export const TREE_OP_NAMES = [
  "add_leaf",
  "update_leaf",
  "remove_leaf",
  "rename",
  "move",
  "add_node",
  "delete",
  "set_note",
  "set_summary",
] as const;

/** 批量操作中的一条失败（带序号，便于定位）。 */
export class OpError extends Error {
  readonly index: number;
  readonly opName: string;
  constructor(index: number, opName: string, message: string) {
    super(`操作 #${index + 1}（${opName}）失败：${message}`);
    this.name = "OpError";
    this.index = index;
    this.opName = opName;
  }
}

const TITLE_FORBIDDEN = /[/[]/;

function titleError(title: unknown): string | null {
  if (typeof title !== "string" || title.trim() === "") return "标题为空";
  if (TITLE_FORBIDDEN.test(title)) return "标题不能含 “/” 或 “[”";
  return null;
}

function parentOf(root: MemoryNode, target: MemoryNode): MemoryNode | null {
  const stack: MemoryNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of n.children) {
      if (c === target) return n;
      stack.push(c);
    }
  }
  return null;
}

/**
 * 按序在树上应用一批操作（原地修改）。
 * 任一条失败即抛 `OpError`（调用方负责回滚整批，不要捕获后继续）。
 */
export function applyOps(root: MemoryNode, ops: TreeOp[]): { changed: boolean; applied: number } {
  if (!Array.isArray(ops)) throw new Error("ops 必须是数组");
  let changed = false;
  ops.forEach((op, i) => {
    if (applyOne(root, op, i)) changed = true;
  });
  return { changed, applied: ops.length };
}

function mustResolve(root: MemoryNode, path: unknown, opName: string, i: number) {
  if (typeof path !== "string" || path.trim() === "") throw new OpError(i, opName, "path 为空");
  const r = resolvePath(root, path); // 精确匹配，不做模糊
  if (!r) throw new OpError(i, opName, `路径不存在：${path}`);
  return r;
}

function applyOne(root: MemoryNode, op: TreeOp, i: number): boolean {
  switch (op.op) {
    case "add_leaf": {
      const r = mustResolve(root, op.path, op.op, i);
      if (typeof op.leaf !== "string" || op.leaf.trim() === "") throw new OpError(i, op.op, "leaf 为空");
      if (r.node.leaves.includes(op.leaf)) return false;
      r.node.leaves.push(op.leaf);
      r.node.leafUids?.push(null); // 无身份：写入时按文本收养或新发
      return true;
    }
    case "update_leaf": {
      const r = mustResolve(root, op.path, op.op, i);
      const m = stripDateMark(op.match);
      const hits = r.node.leaves.filter((l) => stripDateMark(l) === m).length;
      if (hits !== 1) throw new OpError(i, op.op, `match 须唯一命中（日期尾巴已归一化；当前 ${hits} 次）：${op.match}`);
      if (typeof op.leaf !== "string" || op.leaf.trim() === "") throw new OpError(i, op.op, "leaf 为空");
      r.node.leaves = r.node.leaves.map((l) => (stripDateMark(l) === m ? op.leaf : l));
      return true;
    }
    case "remove_leaf": {
      const r = mustResolve(root, op.path, op.op, i);
      const m = stripDateMark(op.match);
      const idx = r.node.leaves.findIndex((l) => stripDateMark(l) === m);
      if (idx < 0) throw new OpError(i, op.op, `match 须唯一命中（日期尾巴已归一化；当前 0 次）：${op.match}`);
      if (r.node.leaves.filter((l) => stripDateMark(l) === m).length !== 1)
        throw new OpError(i, op.op, `match 须唯一命中（日期尾巴已归一化）：${op.match}`);
      r.node.leaves.splice(idx, 1); // 索引同步剪，保持 leafUids 对齐
      r.node.leafUids?.splice(idx, 1);
      return true;
    }
    case "rename": {
      const r = mustResolve(root, op.path, op.op, i);
      if (!r.parent) throw new OpError(i, op.op, "不能重命名根节点");
      const err = titleError(op.title);
      if (err) throw new OpError(i, op.op, err);
      if (r.parent.children.some((c) => c !== r.node && c.title === op.title)) {
        throw new OpError(i, op.op, `同层已有同名节点「${op.title}」（拒绝静默消歧，请先合并或改用独立标题）`);
      }
      if (r.node.title === op.title) return false;
      r.node.title = op.title;
      return true;
    }
    case "move": {
      const src = mustResolve(root, op.from, op.op, i);
      const dst = mustResolve(root, op.to, op.op, i);
      if (!src.parent) throw new OpError(i, op.op, "不能移动根节点");
      let p: MemoryNode | null = dst.node;
      while (p) {
        if (p === src.node) throw new OpError(i, op.op, `移动会构成环：${op.from} → ${op.to}`);
        p = parentOf(root, p);
      }
      src.parent.children.splice(src.index, 1);
      dst.node.children.push(src.node);
      return true;
    }
    case "add_node": {
      const p = mustResolve(root, op.parent, op.op, i);
      const err = titleError(op.title);
      if (err) throw new OpError(i, op.op, err);
      if (p.node.children.some((c) => c.title === op.title)) {
        throw new OpError(i, op.op, `同层已有同名节点「${op.title}」（拒绝静默消歧）`);
      }
      p.node.children.push({ title: op.title, leaves: [], children: [] });
      return true;
    }
    case "delete": {
      const r = mustResolve(root, op.path, op.op, i);
      if (!r.parent) throw new OpError(i, op.op, "不能删除根节点");
      r.parent.children.splice(r.index, 1);
      return true;
    }
    case "set_note": {
      const r = mustResolve(root, op.path, op.op, i);
      const next = op.content ?? null;
      if ((r.node.content ?? null) === next) return false;
      r.node.content = next;
      return true;
    }
    case "set_summary": {
      const r = mustResolve(root, op.path, op.op, i);
      const next = op.summary == null || op.summary.trim() === "" ? null : op.summary.trim();
      const hash = next == null ? null : summaryHash(r.node);
      if ((r.node.summary ?? null) === next && (r.node.summaryHash ?? null) === hash) return false;
      r.node.summary = next;
      r.node.summaryHash = hash;
      return true;
    }
    default:
      throw new OpError(i, (op as { op: string }).op, "未知操作");
  }
}
