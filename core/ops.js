import { parsePath, resolvePath, splitDisambig } from "./path.js";
                                             

                               
                   
                                
                       
                  
                         
 

/**
 * 剥掉叶子末尾自动附加的「← YYYY-MM-DD」时间锚点。
 * 仅用于 match 比对归一化（update/remove 不因日期尾巴而失配）；写入侧 withDate 不变。
 */
export function stripDateMark(s        )         {
  return s.replace(/\s*←\s*\d{4}-\d{2}-\d{2}\s*$/, "");
}

/**
 * 新增/更新一条叶子事实。路径中的缺失节点按序创建（含消歧复用既有同名节点）。
 * 精确重复（leaf 全等）为幂等 no-op。
 */
export function upsertNode(root            , path        , leaf        )               {
  const created           = [];
  let current = root;
  const walked           = [];

  for (const seg of parsePath(path)) {
    const { title, nth } = splitDisambig(seg);
    let next                        ;
    if (nth > 1) {
      // 显式消歧：只走指定序号的同名节点，不存在即创建
      let seen = 0;
      for (const c of current.children) {
        if (c.title === title && ++seen === nth) {
          next = c;
          break;
        }
      }
    } else {
      next = current.children.find((c) => c.title === title);
    }
    if (!next) {
      next = { title, leaves: [], children: [] };
      current.children.push(next);
      created.push(title);
    }
    walked.push(next.title);
    current = next;
  }

  if (current.leaves.includes(leaf)) {
    return { changed: false, resolvedPath: walked.join("/"), createdNodes: created };
  }
  current.leaves.push(leaf);
  if (current.leafUids) current.leafUids.push(null); // 无身份：写入时按文本收养或新发
  return { changed: true, resolvedPath: walked.join("/"), createdNodes: created };
}

/** 移动子树：把 from 节点（含子树）挂到 to 节点之下（作为其最后一个子节点）。 */
export function moveNode(root            , from        , to        )          {
  const src = resolvePath(root, from);
  const dst = resolvePath(root, to, { fuzzy: true });
  if (!src || !dst || !src.parent) return false;
  // 防环：不允许把自己移到自己子树下
  let p                    = dst.node;
  while (p) {
    if (p === src.node) return false;
    p = parentOf(root, p);
  }
  src.parent.children.splice(src.index, 1);
  dst.node.children.push(src.node);
  return true;
}

/** 删除子树。 */
export function deleteNode(root            , path        )          {
  const r = resolvePath(root, path, { fuzzy: true });
  if (!r || !r.parent) return false;
  r.parent.children.splice(r.index, 1);
  return true;
}

function parentOf(root            , target            )                    {
  const stack               = [root];
  while (stack.length) {
    const n = stack.pop() ;
    for (const c of n.children) {
      if (c === target) return n;
      stack.push(c);
    }
  }
  return null;
}
