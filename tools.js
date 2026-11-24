/**
 * The model-facing tool set.
 *
 * Each tool is a thin declaration over `MemoryService`: parameters, one
 * description, and the call. Write tools are denied here only by tidy mode,
 * which the plugin installs as a synchronous guard; the service itself enforces
 * the anchor protocol so the panel and the tools behave the same way.
 */

import { TREE_OP_NAMES } from './core/index.js';

/**
 * The session identity a call belongs to. Anchor-state and tidy mode are per
 * session, so two sessions sharing this Host never see each other's write gate.
 * @param exec - the running call; `agent` is set for model-requested calls.
 */
function sessionOf(exec) {
  return exec.agent?.sessionId ?? null;
}

/** Render one canonical string result as model text. */
const text = (value) => [{ type: 'text', text: value }];
/** Output declaration for every tool in this set: one string. */
const STRING_OUTPUT = { schema: { type: 'string' }, render: (_args, value) => text(value) };

const PATH_PARAM = {
  type: 'string',
  required: true,
  description: '节点路径，如 工作/pi生态调研（兄弟重名用 项目[2] 消歧）',
};

/**
 * Build the tool definitions bound to one service instance.
 * @param service - the shared memory service.
 * @param defineTool - the registry's tool factory, passed in so this module has no
 *   dependency on the DSH installation layout.
 * @returns the definitions to register.
 */
export function memoryTools(service, defineTool) {
  return [
    defineTool({
      name: 'memory_read',
      description:
        'Read one subtree of the long-term memory tree as a markdown outline. Use it when the conversation touches a topic the catalog shows in memory.',
      parameters: { path: PATH_PARAM },
      output: STRING_OUTPUT,
      async execute(args, exec) {
        const result = await service.read(args.path, sessionOf(exec));
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_search',
      description:
        'Search the long-term memory tree and return each hit’s full path, ancestors, and a snippet. Use it instead of guessing a path; pass scope to search only one subtree.',
      parameters: {
        query: { type: 'string', required: true, description: '检索词（关键词、话题、同义改写均可）' },
        scope: { type: 'string', description: '可选：限定检索的节点路径（只搜该节点及其子树）' },
        top_k: { type: 'integer', description: '返回条数，默认 5' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const hits = await service.search(args.query, args.top_k ?? 5, args.scope);
        if (hits.length === 0) {
          const scoped = args.scope ? `（范围：${args.scope}）` : '';
          return `无命中：「${args.query}」${scoped}。可换关键词，或 memory_read 目录下钻。`;
        }
        const lines = hits.map((hit, index) => {
          const chain = [...hit.ancestors, hit.title].join(' › ');
          const meta = [hit.hasContent ? '有完整信息' : null, hit.leafCount > 0 ? `${hit.leafCount} 条事实` : null]
            .filter(Boolean)
            .join('，');
          return `${index + 1}. ${chain}${meta ? `（${meta}）` : ''}\n   ${hit.summary ? `${hit.summary}\n   ` : ''}${hit.snippet}`;
        });
        return `命中 ${hits.length} 条：\n${lines.join('\n')}\n（取全文：memory_read 对应路径）`;
      },
    }),

    defineTool({
      name: 'memory_upsert',
      description:
        'Add one leaf fact to the memory tree. An exact duplicate is a no-op and missing intermediate nodes are created. Use it when the conversation yields a conclusion, decision, entity relation, or long-term todo worth keeping across sessions.',
      parameters: {
        path: PATH_PARAM,
        leaf: { type: 'string', required: true, description: '一条叶子事实（短句；写入日期自动附加，无需手写）' },
      },
      output: STRING_OUTPUT,
      async execute(args, exec) {
        const result = await service.upsert(sessionOf(exec), args.path, args.leaf);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_update',
      description:
        'Replace one existing leaf fact in place. `match` must uniquely identify the old leaf inside the node, otherwise nothing changes; a trailing “← YYYY-MM-DD” mark is ignored on both sides. Use it when new information supersedes an existing fact instead of adding a duplicate.',
      parameters: {
        path: PATH_PARAM,
        match: { type: 'string', required: true, description: '要被替换的旧叶子原文（在该节点内需唯一命中）' },
        leaf: { type: 'string', required: true, description: '新的叶子文本（写入日期自动附加）' },
      },
      output: STRING_OUTPUT,
      async execute(args, exec) {
        const result = await service.update(sessionOf(exec), args.path, args.match, args.leaf);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_write_note',
      description:
        'Write a node’s long-form body as Markdown (headings, lists, tables, quotes, code). Use it when the information exceeds one leaf; do not put long text in leaves.',
      parameters: {
        path: PATH_PARAM,
        content: { type: 'string', required: true, description: '节点的完整信息（Markdown 文本，可含围栏代码块）' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.writeNote(args.path, args.content);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_summary',
      description:
        'Read or write a node’s one-line navigation summary. Omit `text` to read it; pass an empty string to clear it. It is navigation, not a fact.',
      parameters: {
        path: PATH_PARAM,
        text: { type: 'string', description: '摘要文本（一行）；省略则只读取当前摘要' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.writeSummary(args.path, args.text);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_history',
      description:
        'Read a node’s past values newest first, one entry per revision that wrote it. Works for deleted nodes too.',
      parameters: { path: PATH_PARAM },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.history(args.path);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_changes',
      description:
        'Review recent tree activity, grouped by revision with value-level from→to rows; an update is one row, old → new. Use it to audit a tidy batch, confirm a write landed, or learn what changed lately. Whole revisions are kept or skipped as a unit, so pass `revision` to list every row of one revision when a batch is larger than the budget.',
      parameters: {
        limit: { type: 'integer', description: '行数预算（默认 10，上限 30）；放不下的版本整体略过' },
        revision: { type: 'integer', description: '可选：只列这一个版本的全部变更行，不看预算（版本号见 /memory log）' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        if (args.revision != null) {
          const { rows, text: body } = await service.changes(10, args.revision);
          if (rows.length === 0) return `版本 #${args.revision} 不存在，或该版本没有变更行（用 /memory log 查版本号）。`;
          return `版本 #${args.revision} 的变更（${rows.length} 行）：\n${body}`;
        }
        const limit = args.limit ?? 10;
        const { rows, text: body } = await service.changes(limit);
        if (rows.length === 0) return '暂无变更记录（新库）。';
        return `最近变更（新→旧，按版本分组，预算 ${limit} 行）：\n${body}\n\n（回滚某版本：/memory rollback <id>）`;
      },
    }),

    defineTool({
      name: 'memory_move',
      description: 'Move a subtree under another node.',
      parameters: {
        from: PATH_PARAM,
        to: { type: 'string', required: true, description: '目标父节点路径' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.move(args.from, args.to);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_delete',
      description:
        'Delete a subtree with all its leaves and descendants. Revisions keep the old state, so this is reversible; use it only to clean up content that no longer means anything.',
      parameters: { path: PATH_PARAM },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.remove(args.path);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_diary',
      description:
        'Read one day’s activity. A cached diary returns directly; otherwise the raw material for that day comes back and you summarize it into the diary node.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD；省略=今天' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.diary(args.date);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_stats',
      description: 'Report the tree’s scale: node count, leaf count, depth, and top-level domains.',
      parameters: {},
      output: STRING_OUTPUT,
      async execute() {
        const stats = await service.stats();
        return (
          `节点 ${stats.nodes}，叶子 ${stats.leaves}，深度 ${stats.depth}\n` +
          `顶层：${stats.roots.join('、') || '（空）'}\n位置：${stats.dir}`
        );
      },
    }),

    defineTool({
      name: 'memory_evidence',
      description: 'List the source session events a node or one of its leaves came from.',
      parameters: {
        path: PATH_PARAM,
        leaf: { type: 'string', description: '可选：叶子原文，精确查该条来源' },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.evidence(args.path, args.leaf);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_link_evidence',
      description:
        'Link one leaf to the session event ids that justify it, so the conclusion stays traceable.',
      parameters: {
        path: PATH_PARAM,
        leaf: { type: 'string', required: true, description: '叶子原文（须在该节点内存在）' },
        event_ids: {
          type: 'array',
          required: true,
          items: { type: 'integer' },
          description: '来源事件 id 列表（会话事件序号）',
        },
      },
      output: STRING_OUTPUT,
      async execute(args) {
        const result = await service.linkEvidence(args.path, args.leaf, args.event_ids);
        return result.text;
      },
    }),

    defineTool({
      name: 'memory_propose',
      description:
        'Tidy only: submit a structured operation list and apply it as one revision. Only valid while a tidy task is running; after it lands, report the change summary and the rollback command.',
      parameters: {
        ops: {
          type: 'array',
          required: true,
          items: { type: 'object', additionalProperties: true },
          description:
            '结构化操作列表（按序应用）。op 与必填字段：add_leaf{path,leaf} / update_leaf{path,match,leaf} / ' +
            `remove_leaf{path,match} / rename{path,title} / move{from,to} / add_node{parent,title} / ` +
            `delete{path} / set_note{path,content} / set_summary{path,summary}。可用 op：${TREE_OP_NAMES.join(', ')}`,
        },
        summary: { type: 'string', description: '一句话说明本次整理做了什么（给用户看）' },
      },
      output: STRING_OUTPUT,
      async execute(args, exec) {
        const result = await service.tidy(sessionOf(exec), args.ops, args.summary);
        return result.text;
      },
    }),
  ];
}
