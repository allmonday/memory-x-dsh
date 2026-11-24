                                                       

                                 
                                          
                  
 

/**
 * 路径寻址：`工作/pi生态调研/待办`。
 * 兄弟重名消歧：`项目[2]`（1-based，省略 = 第 1 个）。
 */
export function parsePath(path        )           {
  const segs = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length === 0) throw new Error("路径为空");
  return segs;
}

export function splitDisambig(seg        )                                 {
  const m = /^(.*)\[(\d+)\]$/.exec(seg);
  if (m && m[1] .length > 0) return { title: m[1] , nth: parseInt(m[2] , 10) };
  return { title: seg, nth: 1 };
}

/** 沿路径解析节点；失败返回 null（不抛错，由调用方决定语义）。 */
export function resolvePath(root            , path        , opts                 = {})                  {
  let current = root;
  let parent                    = null;
  let index = -1;
  for (const seg of parsePath(path)) {
    const { title, nth } = splitDisambig(seg);
    let node = nthSibling(current.children, title, nth);
    if (!node && opts.fuzzy) node = fuzzySibling(current.children, title, nth);
    if (!node) return null;
    parent = current;
    index = current.children.indexOf(node);
    current = node;
  }
  return { node: current, parent, index };
}

function nthSibling(siblings              , title        , nth        )                         {
  if (nth < 1) return undefined;
  let seen = 0;
  for (const c of siblings) {
    if (c.title === title) {
      seen++;
      if (seen === nth) return c;
    }
  }
  return undefined;
}

/** 末段模糊匹配：编辑距离 ≤ max(1, len/4)，按距离升序取第 nth 个。 */
function fuzzySibling(siblings              , title        , nth        )                         {
  const threshold = Math.max(1, Math.floor(title.length / 4));
  const scored = siblings
    .map((c, i) => ({ c, i, d: levenshtein(c.title, title) }))
    .filter((s) => s.d > 0 && s.d <= threshold)
    .sort((a, b) => a.d - b.d || a.i - b.i);
  return scored[nth - 1]?.c;
}

/**
 * 按物化路径遍历子树（重名兄弟带 `[n]` 消歧，与 store.flatten 同一套规则）。
 * `parentPath` 为当前子树相对基准（"" 表示以 children 的直接父为根）。
 * 用于整理时按路径搬回节点 content。
 */
export function forEachWithPath(
  children              ,
  parentPath        ,
  fn                                          ,
)       {
  const counts = new Map                ();
  for (const child of children) {
    const seen = (counts.get(child.title) ?? 0) + 1;
    counts.set(child.title, seen);
    const seg = seen > 1 ? `${child.title}[${seen}]` : child.title;
    const path = parentPath ? `${parentPath}/${seg}` : seg;
    fn(child, path);
    forEachWithPath(child.children, path, fn);
  }
}

/**
 * 枚举全树节点及其物化规范路径（重名兄弟带 `[n]` 消歧，与 store.flatten 同一套规则）。
 * 供 scope 限定、整理 picker、路径规范化复用。
 */
export function enumerateNodePaths(root            )                                            {
  const out                                            = [];
  forEachWithPath(root.children, "", (node, path) => out.push({ node, path }));
  return out;
}

/** 目标节点在树中的物化规范路径；根节点返回 `""`，未找到返回 null。 */
export function canonicalPathOf(root            , target            )                {
  if (target === root) return "";
  let found                = null;
  forEachWithPath(root.children, "", (node, path) => {
    if (node === target) found = path;
  });
  return found;
}

export function levenshtein(a        , b        )         {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]  + 1, cur[j - 1]  + 1, prev[j - 1]  + cost);
    }
    prev = cur;
  }
  return prev[n] ;
}
