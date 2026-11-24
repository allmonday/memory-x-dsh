/** 记忆树节点。根节点 title 固定为 "Memory"，只有 children，没有 leaves。 */
export interface MemoryNode {
  /** 跨版本稳定标识（内部寻址用；不参与 Markdown 序列化，不进 outline 协议） */
  uid?: string;
  title: string;
  /** 标题下的叶子事实（bullet 行，不含 "- " 前缀） */
  leaves: string[];
  /** 与 leaves 索引对齐的叶子稳定身份（uid）。缺省 = 无身份（写入时按文本收养或新发）。
   *  update 原地替换文本时 uid 不变 → 叶级版本链（supersede 可追溯）。仅内存树携带，
   *  不参与 Markdown 序列化；push/filter/map 类操作需自行保持对齐。 */
  leafUids?: Array<string | null>;
  /** 节点完整信息（RAG 语料）。导出为 fenced block；内容不得含 ``` 行 */
  content?: string | null;
  /** 节点级摘要（L0，一行，导航用）。显式写入；缺省/陈旧时用确定性推导兜底 */
  summary?: string | null;
  /** 生成 summary 时的内容指纹（summaryHash(node)）；用于陈旧检测 */
  summaryHash?: string | null;
  children: MemoryNode[];
}

/** 写操作结果 */
export interface OpResult {
  ok: boolean;
  path: string;
  /** git commit sha（未产生变更时为 null） */
  revision: string | null;
  /** 本次操作是否改变了树 */
  changed: boolean;
}

/** 路径解析结果 */
export interface Resolved {
  node: MemoryNode;
  parent: MemoryNode | null;
  /** node 在 parent.children 中的下标；根节点为 -1 */
  index: number;
}
