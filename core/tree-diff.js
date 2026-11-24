                                             

                          
               
               
 
                          
               
                
 
                             
               
                              
 

/** 两棵树之间的结构性差异（叶子级 add/remove + 节点 add/remove + content/summary 变更）。 */
                           
                        
                          
                         
                           
                             
 

/** 扁平化：物化路径 → 节点（重名兄弟带 [n]，与 store.flatten 同一套规则；不含根）。 */
export function flattenTree(root            )                          {
  const out = new Map                    ();
  const walk = (children              , parentPath        ) => {
    const counts = new Map                ();
    for (const c of children) {
      const seen = (counts.get(c.title) ?? 0) + 1;
      counts.set(c.title, seen);
      const seg = seen > 1 ? `${c.title}[${seen}]` : c.title;
      const path = parentPath ? `${parentPath}/${seg}` : seg;
      out.set(path, c);
      walk(c.children, path);
    }
  };
  walk(root.children, "");
  return out;
}

export function diffTrees(base            , next            )           {
  const b = flattenTree(base);
  const n = flattenTree(next);
  const diff           = {
    addedNodes: [],
    removedNodes: [],
    addedLeaves: [],
    removedLeaves: [],
    changedNotes: [],
  };

  for (const [path, node] of n) if (!b.has(path)) diff.addedNodes.push({ path, title: node.title });
  for (const [path, node] of b) if (!n.has(path)) diff.removedNodes.push({ path, title: node.title });

  for (const [path, node] of n) {
    const old = b.get(path);
    if (!old) {
      for (const leaf of node.leaves) diff.addedLeaves.push({ path, leaf });
      continue;
    }
    const oldSet = new Set(old.leaves);
    const newSet = new Set(node.leaves);
    for (const leaf of node.leaves) if (!oldSet.has(leaf)) diff.addedLeaves.push({ path, leaf });
    for (const leaf of old.leaves) if (!newSet.has(leaf)) diff.removedLeaves.push({ path, leaf });
    if ((old.content ?? null) !== (node.content ?? null)) diff.changedNotes.push({ path, kind: "content" });
    if ((old.summary ?? null) !== (node.summary ?? null)) diff.changedNotes.push({ path, kind: "summary" });
  }
  return diff;
}

/** 把 diff 压成「操作行」，写入 changes 审计表。 */
export function diffToChangeRows(
  diff          ,
)                                                                              {
  return [
    ...diff.addedNodes.map((x) => ({ op: "add-node", path: x.path, from: null, to: x.title })),
    ...diff.removedNodes.map((x) => ({ op: "remove-node", path: x.path, from: x.title, to: null })),
    ...diff.addedLeaves.map((x) => ({ op: "add", path: x.path, from: null, to: x.leaf })),
    ...diff.removedLeaves.map((x) => ({ op: "remove", path: x.path, from: x.leaf, to: null })),
    ...diff.changedNotes.map((x) => ({ op: `note-${x.kind}`, path: x.path, from: null, to: null })),
  ];
}
