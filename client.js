// Memory tree, browser half.
//
// Adds a "记忆树" entry to the left sidebar and the panel it opens in the
// layout's root `main` slot. The panel is read-only: it lists the tree, renders
// each node's leaves and markdown body, searches, and walks revision history with
// a colour-coded diff. In the tree, one click selects a node and folds or unfolds
// it; folding on a single click follows the host's own sidebar rows. Editing
// happens in conversation through the memory_* tools; rollback is the one action
// offered here, and it goes through the same Host service the tools use.
//
// Data reaches this module through the Host half's `memory-x-dsh/service`
// import, so there is no second HTTP surface and no separate port to manage.

window.__ModuleLoader__.load({
  id: 'memory-x-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'memoryX';
    const PANEL_ID = 'memory-tree';

    // ── copy ────────────────────────────────────────────────────────────────
    const dict = {
      en: {
        panel: 'Memory tree',
        title: 'Memory tree',
        refresh: 'Refresh',
        searchPlaceholder: 'Search memory…',
        searching: 'Searching…',
        noResults: 'No match',
        tree: 'Tree',
        versions: 'Versions',
        lint: 'Lint',
        leaves: 'Facts',
        content: 'Full note',
        summary: 'Summary',
        empty: 'Memory is empty. Facts written in conversation appear here.',
        loading: 'Loading memory…',
        loadFailed: 'Could not read the memory tree.',
        retry: 'Retry',
        nodes: 'nodes',
        facts: 'facts',
        revision: 'revision',
        dir: 'Data',
        noVersions: 'No revisions yet.',
        noLint: 'Structure is healthy.',
        rollback: 'Copy rollback command',
        rollbackHint: 'Copied. Run it in the conversation:',
        diff: 'Diff',
        warn: 'warning',
        info: 'hint',
        searchScope: 'Search results',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        noFacts: 'No facts are recorded on this level; they live in the child nodes below.',
        nodeEmpty: 'This node has no facts recorded yet.',
        noSelection: 'Pick a node on the left to read it.',
        children: 'Child nodes',
        renderError: 'The memory tree panel failed to render: ',
      },
      zh: {
        panel: '记忆树',
        title: '记忆树',
        refresh: '刷新',
        searchPlaceholder: '搜索记忆…',
        searching: '搜索中…',
        noResults: '无匹配',
        tree: '目录',
        versions: '版本',
        lint: '体检',
        leaves: '事实',
        content: '完整信息',
        summary: '摘要',
        empty: '记忆树还是空的。对话中写下的长期事实会出现在这里。',
        loading: '正在读取记忆…',
        loadFailed: '读取记忆树失败。',
        retry: '重试',
        nodes: '节点',
        facts: '条事实',
        revision: '版本号',
        dir: '数据',
        noVersions: '暂无版本历史。',
        noLint: '结构健康。',
        rollback: '复制回滚命令',
        rollbackHint: '已复制，在对话里执行：',
        diff: '差异',
        warn: '警告',
        info: '建议',
        searchScope: '搜索结果',
        expandAll: '全部展开',
        collapseAll: '全部收起',
        noFacts: '这一层没有直接记事实，内容在下面的子节点里。',
        nodeEmpty: '这个节点还没有记录事实。',
        noSelection: '在左侧选一个节点查看。',
        children: '子节点',
        renderError: '记忆树面板渲染出错：',
      },
    };

    // ── styles ──────────────────────────────────────────────────────────────
    // Only alias tokens: a renamed token degrades appearance but never breaks.
    const CSS = `
      .mx-tree-page{height:100%;box-sizing:border-box;display:flex;flex-direction:column;
        color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.5;
        padding:16px clamp(16px,2.4vw,28px) 0;}
      .mx-head{display:flex;align-items:center;gap:10px;flex:none;padding-bottom:12px;
        border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}
      .mx-title{font-size:18px;font-weight:600;margin:0;flex:none;}
      .mx-meta{color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .mx-grow{flex:1;min-width:0;}
      .mx-ghost{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
        background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);border-radius:8px;
        padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;}
      .mx-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));
        color:var(--dsw-alias-label-primary,#1f2328);}
      .mx-ghost[disabled]{opacity:.5;cursor:default;}
      .mx-tabs{display:flex;gap:4px;flex:none;padding:10px 0 0;}
      .mx-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);
        border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;}
      .mx-tab[data-on='true']{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));
        color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;}
      .mx-input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
        border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;color:inherit;
        background:var(--dsw-alias-bg-layer-1,transparent);outline:none;}
      .mx-input:focus{border-color:var(--dsw-alias-border-selected,var(--dsw-alias-label-primary,#1f2328));}
      .mx-body{flex:1;min-height:0;display:flex;gap:0;}
      .mx-side{width:290px;flex:none;display:flex;flex-direction:column;min-height:0;
        border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding:10px 8px 10px 0;}
      .mx-pane{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:14px 0 24px 18px;}
      /* Tree rows borrow the host sidebar's row treatments — the hover fill of any
         list row, a stronger fill for the selected one, the focus ring drawn inside
         the row — on the panel's own 13px type, so the list stays dense. The fold
         chevron sits at the title's own indent, so it reads as part of the row it
         belongs to rather than as a column of its own. */
      .mx-row{display:flex;align-items:center;gap:2px;min-height:26px;padding:2px 6px;
        border-radius:var(--dsw-radius-md,6px);cursor:pointer;white-space:nowrap;overflow:hidden;
        user-select:none;-webkit-user-select:none;}
      .mx-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
      .mx-row[data-on='true']{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.09));}
      .mx-row[data-on='true'] .mx-name{font-weight:600;}
      .mx-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
        var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2f6fed));outline-offset:-2px;}
      .mx-indent{flex:none;}
      .mx-caret{width:18px;height:18px;flex:none;display:inline-flex;align-items:center;justify-content:center;
        color:var(--dsw-alias-label-tertiary,#8a919d);}
      .mx-row:hover .mx-caret{color:var(--dsw-alias-label-secondary,#5f6672);}
      .mx-caret svg{transition:transform 150ms var(--ds-ease-in-out,ease-in-out);}
      .mx-row[aria-expanded='true'] .mx-caret svg{transform:rotate(90deg);}
      @media (prefers-reduced-motion:reduce){.mx-caret svg{transition:none;}}
      .mx-leafcount{color:var(--dsw-alias-label-tertiary,#8a919d);font-size:11px;flex:none;}
      .mx-name{min-width:0;overflow:hidden;text-overflow:ellipsis;}
      .mx-children{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px;}
      .mx-tools{display:flex;justify-content:flex-end;gap:2px;margin-top:6px;}
      .mx-textbtn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);
        border-radius:var(--dsw-radius-xs,4px);padding:3px 8px;font-size:12px;font-family:inherit;cursor:pointer;}
      .mx-textbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));
        color:var(--dsw-alias-label-primary,#1f2328);}
      .mx-textbtn[disabled]{opacity:.45;cursor:default;background:transparent;
        color:var(--dsw-alias-label-secondary,#5f6672);}
      .mx-textbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
        var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2f6fed));outline-offset:-2px;}
      .mx-crumb{color:var(--dsw-alias-label-tertiary,#8a919d);font-size:12px;margin-bottom:4px;word-break:break-all;}
      .mx-node-title{font-size:17px;font-weight:600;margin:0 0 6px;}
      .mx-summary{color:var(--dsw-alias-label-secondary,#5f6672);margin:0 0 14px;}
      .mx-section{font-size:11px;letter-spacing:.04em;text-transform:uppercase;
        color:var(--dsw-alias-label-tertiary,#8a919d);margin:16px 0 6px;}
      .mx-facts{margin:0;padding-left:18px;}
      .mx-facts li{padding:2px 0;}
      .mx-md{white-space:normal;}
      .mx-md > :first-child{margin-top:0;}
      .mx-md h1,.mx-md h2,.mx-md h3,.mx-md h4{margin:14px 0 6px;line-height:1.3;}
      .mx-md h1{font-size:18px;} .mx-md h2{font-size:16px;} .mx-md h3{font-size:14px;}
      .mx-md h4{font-size:13px;color:var(--dsw-alias-label-secondary,#5f6672);}
      .mx-md p{margin:0 0 8px;}
      .mx-md ul,.mx-md ol{margin:0 0 8px;padding-left:22px;}
      .mx-md li{margin:1px 0;}
      .mx-md code{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));border-radius:4px;
        padding:0 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
      .mx-md pre{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border-radius:8px;
        padding:10px 12px;overflow:auto;margin:0 0 8px;}
      .mx-md pre code{background:none;padding:0;}
      .mx-md blockquote{margin:0 0 8px;padding:2px 12px;
        border-left:3px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));
        color:var(--dsw-alias-label-secondary,#5f6672);}
      .mx-md table{border-collapse:collapse;margin:0 0 8px;}
      .mx-md th,.mx-md td{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
        padding:4px 10px;text-align:left;}
      .mx-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));margin:12px 0;}
      .mx-rev{display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-radius:8px;
        cursor:pointer;margin-bottom:4px;border:1px solid transparent;}
      .mx-rev:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
      .mx-rev[data-on='true']{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14));
        background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
      .mx-rev-id{font-family:ui-monospace,Menlo,monospace;flex:none;
        color:var(--dsw-alias-label-primary,#1f2328);}
      .mx-rev-op{font-size:11px;padding:1px 7px;border-radius:9px;flex:none;
        background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));
        color:var(--dsw-alias-label-secondary,#5f6672);}
      .mx-rev-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
      .mx-rev-time{margin-left:auto;font-size:11px;flex:none;
        color:var(--dsw-alias-label-tertiary,#8a919d);}
      .mx-diff{font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.65;
        white-space:pre-wrap;margin:0;padding:10px 12px;border-radius:8px;
        background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));overflow-x:auto;}
      .mx-diff .a{display:block;color:var(--dsw-alias-state-success-primary,#15803d);
        background:var(--dsw-alias-state-success-bg,rgba(21,128,61,.1));}
      .mx-diff .d{display:block;color:var(--dsw-alias-state-error-primary,#c4443c);
        background:var(--dsw-alias-state-error-bg,rgba(196,68,60,.1));}
      .mx-issue{padding:8px 12px;border-left:3px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));
        margin-bottom:6px;border-radius:0 8px 8px 0;
        background:var(--dsw-alias-card-fill,rgba(127,127,127,.06));}
      .mx-issue[data-warn='true']{border-left-color:var(--dsw-alias-state-warning-primary,#b45309);}
      .mx-rule{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919d);}
      .mx-note{color:var(--dsw-alias-label-secondary,#5f6672);padding:12px 0;}
      .mx-error{color:var(--dsw-alias-state-error-primary,#c4443c);}
      .mx-hit{padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:6px;
        border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));}
      .mx-hit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
      .mx-hit:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
        var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2f6fed));outline-offset:-2px;}
      .mx-hit-chain{font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);margin-bottom:2px;}
      .mx-hit-snip{font-size:12px;}
      @media (max-width:900px){
        .mx-side{width:210px;}
        .mx-tree-page{padding:14px 14px 0;}
      }
    `;

    // ── tiny markdown renderer ──────────────────────────────────────────────
    // The panel must not import a markdown package (client plugins cannot add
    // runtime dependencies), so this covers the subset memory bodies use:
    // headings, lists, quotes, fenced code, tables, rules, and inline marks.
    function inline(text, keyBase) {
      const nodes = [];
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyBase}-i${index++}`;
        if (token.startsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)));
        else if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
        else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)));
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    /** Render one markdown body into React nodes. Never injects raw HTML. */
    function markdown(source) {
      const lines = String(source ?? '').split('\n');
      const blocks = [];
      let index = 0;
      let key = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (/^```/.test(line)) {
          const body = [];
          index++;
          while (index < lines.length && !/^```/.test(lines[index])) body.push(lines[index++]);
          index++;
          blocks.push(h('pre', { key: key++ }, h('code', null, body.join('\n'))));
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          blocks.push(h(`h${Math.min(heading[1].length, 4)}`, { key: key++ }, inline(heading[2], `h${key}`)));
          index++;
          continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
            items.push(h('li', { key: items.length }, inline(lines[index].replace(/^\s*[-*+]\s+/, ''), `li${key}-${items.length}`)));
            index++;
          }
          blocks.push(h('ul', { key: key++ }, items));
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
            items.push(h('li', { key: items.length }, inline(lines[index].replace(/^\s*\d+[.)]\s+/, ''), `ol${key}-${items.length}`)));
            index++;
          }
          blocks.push(h('ol', { key: key++ }, items));
          continue;
        }
        if (/^>\s?/.test(line)) {
          const body = [];
          while (index < lines.length && /^>\s?/.test(lines[index])) body.push(lines[index++].replace(/^>\s?/, ''));
          blocks.push(h('blockquote', { key: key++ }, markdown(body.join('\n'))));
          continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[-\s:|]+\|\s*$/.test(lines[index + 1] ?? '')) {
          const rows = [];
          const header = lines[index];
          index += 2;
          while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) rows.push(lines[index++]);
          const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
          blocks.push(
            h('table', { key: key++ },
              h('thead', null, h('tr', null,
                cells(header).map((cell, i) => h('th', { key: i }, inline(cell, `th${i}`))))),
              h('tbody', null, rows.map((row, r) =>
                h('tr', { key: r },
                  cells(row).map((cell, i) => h('td', { key: i }, inline(cell, `td${r}-${i}`))))))),
          );
          continue;
        }
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
          blocks.push(h('hr', { key: key++ }));
          index++;
          continue;
        }
        if (line.trim() === '') {
          index++;
          continue;
        }
        const paragraph = [];
        while (
          index < lines.length &&
          lines[index].trim() !== '' &&
          !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[index]) &&
          !/^\s*\|.*\|\s*$/.test(lines[index])
        ) {
          paragraph.push(lines[index++]);
        }
        blocks.push(h('p', { key: key++ }, inline(paragraph.join(' '), `p${key}`)));
      }
      return blocks;
    }

    // ── data ────────────────────────────────────────────────────────────────
    // The Host half answers these reads on the page's own origin, so the panel
    // needs no second port and no cross-origin setup. Reads only: every mutation
    // goes through the memory_* tools or the /memory command.
    const API = '/api/memory-x';

    async function getJson(path, signal) {
      const response = await fetch(`${API}${path}`, { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    /** One snapshot the whole panel renders from. */
    function loadSnapshot(signal) {
      return getJson('/snapshot', signal);
    }

    /** Search the tree for the search box. */
    function searchTree(query, signal) {
      return getJson(`/search?q=${encodeURIComponent(query)}`, signal).then((answer) => answer.hits ?? []);
    }

    /** Diff for one revision. */
    function loadDiff(id, signal) {
      return getJson(`/diff?id=${encodeURIComponent(id)}`, signal);
    }

    /**
     * Normalise a diff payload into renderable rows.
     * Older hosts returned `lines` as one joined string; a string reaching the
     * renderer used to throw inside React and blank the whole panel. Accept both
     * shapes so a version click can never take the panel down.
     * @param {any} diff - the `/diff` payload.
     * @returns {Array<{kind: string, text: string}>} rows to render.
     */
    function diffRowsOf(diff) {
      const lines = diff?.lines;
      if (Array.isArray(lines)) {
        return lines.filter((line) => line && typeof line.text === 'string');
      }
      if (typeof lines === 'string') {
        return lines.split('\n').map((text) => ({
          kind: text.startsWith('+ ') ? 'add' : text.startsWith('- ') ? 'del' : 'ctx',
          text,
        }));
      }
      return [];
    }

    /** One tree level of indent, in pixels. */
    const INDENT = 14;

    /** The node a path hangs under; null for a top-level node. */
    const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null);

    /**
     * The rows the outline draws, each with its depth, leaving out every node
     * below a folded one. `collapsed` maps a path to true while it is folded.
     * @param {Array<{path: string}>} outline - every node, parents first.
     * @param {Map<string, boolean>} collapsed - folded paths.
     * @returns {Array<object>} the visible nodes with a `depth`.
     */
    function visibleRows(outline, collapsed) {
      const rows = [];
      for (const node of outline) {
        let folded = false;
        for (let cursor = parentOf(node.path); cursor != null; cursor = parentOf(cursor)) {
          if (collapsed.get(cursor) === true) {
            folded = true;
            break;
          }
        }
        if (!folded) rows.push({ ...node, depth: node.path.split('/').length - 1 });
      }
      return rows;
    }

    /**
     * The fold chevron. A text triangle such as ▶ is drawn by whichever font the
     * browser picks, and on macOS it can come out as a blue play button; a stroked
     * chevron means "folds out" and turns 90 degrees when it has.
     */
    function Chevron() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 12,
        height: 12,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M9 5l7 7-7 7' }));
    }

    /**
     * Last line of defence for the panel: a throw anywhere below it renders one
     * readable error card instead of unmounting the whole tree into a blank page.
     * React only offers error boundaries as class components.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error) {
          const say = typeof this.props.t === 'function' ? this.props.t : (key, fallback) => fallback;
          return h('div', { className: 'mx-note mx-error', style: { margin: 12 } },
            `${say('renderError', 'render error: ')}${this.state.error.message}`);
        }
        return this.props.children;
      }
    }

    function GuardedMemoryTreePage(props) {
      // The page's own locale seat reaches the boundary, so its one message is translated too.
      return h(PanelBoundary, { t: props.t }, h(MemoryTreePage, props));
    }

    function MemoryTreePage({ t }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [phase, setPhase] = React.useState('loading'); // loading | ready | error
      const [selected, setSelected] = React.useState(null);
      const [tab, setTab] = React.useState('tree'); // tree | versions | lint
      const [query, setQuery] = React.useState('');
      const [hits, setHits] = React.useState(null);
      const [searching, setSearching] = React.useState(false);
      const [collapsed, setCollapsed] = React.useState(() => new Map());
      const [openRevision, setOpenRevision] = React.useState(null);
      const [diff, setDiff] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      /** The rendered tree rows by path, for focusing and scrolling to one. */
      const rowEls = React.useRef(null);
      if (rowEls.current === null) rowEls.current = new Map();

      const refresh = React.useCallback(async () => {
        try {
          const next = await loadSnapshot();
          setSnapshot(next);
          setPhase('ready');
          setSelected((current) => current && next.outline.some((node) => node.path === current)
            ? current
            : next.outline[0]?.path ?? null);
        } catch (error) {
          setPhase('error');
          setNotice({ kind: 'error', text: `${t('loadFailed')} ${error?.message ?? ''}`.trim() });
        }
      }, [t]);

      React.useEffect(() => {
        const controller = new AbortController();
        loadSnapshot(controller.signal)
          .then((next) => {
            setSnapshot(next);
            setPhase('ready');
            setSelected(next.outline[0]?.path ?? null);
          })
          .catch((error) => {
            if (error?.name !== 'AbortError') setPhase('error');
          });
        return () => controller.abort();
      }, []);

      // Search is debounced and ignores stale answers.
      React.useEffect(() => {
        const text = query.trim();
        if (text.length < 1) {
          setHits(null);
          return undefined;
        }
        setSearching(true);
        // The previous answer no longer matches what is being typed; drop it now
        // rather than after the debounce.
        setHits(null);
        const controller = new AbortController();
        const timer = setTimeout(() => {
          searchTree(text, controller.signal)
            .then((found) => {
              setHits(found);
              setSearching(false);
            })
            .catch((error) => {
              if (error?.name === 'AbortError') return;
              setHits([]);
              setSearching(false);
            });
        }, 260);
        return () => {
          controller.abort();
          clearTimeout(timer);
        };
      }, [query]);

      const showRevision = React.useCallback(async (id) => {
        if (openRevision === id) {
          setOpenRevision(null);
          setDiff(null);
          return;
        }
        setOpenRevision(id);
        setDiff(null);
        try {
          setDiff(await loadDiff(id));
        } catch {
          setDiff({ ok: false, text: t('loadFailed') });
        }
      }, [openRevision, t]);

      // The panel is read-only by design, exactly like the standalone memory-x UI:
      // writing is the conversation's job. Rollback is offered as a prefilled
      // instruction the user can hand to the agent in one click.
      const rollback = React.useCallback((id) => {
        const command = `/memory rollback ${id}`;
        setNotice({ kind: 'ok', text: `${t('rollbackHint')} ${command}` });
        navigator.clipboard?.writeText(command).catch(() => {});
      }, [t]);

      /** Fold (`open` false) or unfold one subtree; a no-op when it already is. */
      const setExpanded = React.useCallback((path, open) => {
        if (path == null) return;
        setCollapsed((current) => {
          if ((current.get(path) !== true) === open) return current;
          const next = new Map(current);
          next.set(path, !open);
          return next;
        });
      }, []);

      /** Select a row and unfold everything above it, so the row is on screen. */
      const reveal = React.useCallback((path) => {
        setSelected(path);
        for (let cursor = parentOf(path); cursor != null; cursor = parentOf(cursor)) setExpanded(cursor, true);
      }, [setExpanded]);

      /** The row to focus once it is rendered; set when the control that selected it unmounts. */
      const focusRequest = React.useRef(null);
      const revealAndFocus = React.useCallback((path) => {
        focusRequest.current = path;
        reveal(path);
      }, [reveal]);

      // Keep the selected row on screen: a search hit or a child shortcut can
      // select a row far down the list, or one that was folded away a moment ago.
      // When the selecting control was itself focused (a search hit, a child
      // shortcut) and has just unmounted, hand focus to the row.
      React.useEffect(() => {
        if (tab !== 'tree' || query.trim()) return;
        rowEls.current?.get(selected)?.scrollIntoView?.({ block: 'nearest' });
        if (focusRequest.current != null) {
          rowEls.current?.get(focusRequest.current)?.focus?.();
          focusRequest.current = null;
        }
      }, [selected, tab, query, collapsed]);

      const node = snapshot?.outline.find((entry) => entry.path === selected) ?? null;

      const header = h('div', { className: 'mx-head' },
        h('h1', { className: 'mx-title' }, t('title')),
        snapshot
          ? h('span', { className: 'mx-meta' },
              `${snapshot.stats.nodes} ${t('nodes')} · ${snapshot.stats.leaves} ${t('facts')} · ` +
              `#${snapshot.stats.revision} · ${snapshot.stats.dir}`)
          : h('span', { className: 'mx-meta' }, t('loading')),
        h('span', { className: 'mx-grow' }),
        h('button', { className: 'mx-ghost', type: 'button', onClick: refresh, disabled: phase === 'loading' },
          t('refresh')),
      );

      if (phase === 'loading') {
        return h('div', { className: 'mx-tree-page' }, h('style', null, CSS), header,
          h('div', { className: 'mx-note' }, t('loading')));
      }
      if (phase === 'error') {
        return h('div', { className: 'mx-tree-page' }, h('style', null, CSS), header,
          h('div', { className: 'mx-note mx-error' }, t('loadFailed'),
            h('button', {
              className: 'mx-ghost',
              type: 'button',
              style: { marginLeft: 8 },
              onClick: () => {
                setPhase('loading');
                refresh();
              },
            }, t('retry'))));
      }

      const tabs = h('div', { className: 'mx-tabs' },
        ['tree', 'versions', 'lint'].map((id) =>
          h('button', {
            key: id,
            className: 'mx-tab',
            type: 'button',
            'data-on': String(tab === id),
            onClick: () => setTab(id),
          }, id === 'versions'
            ? `${t('versions')}${snapshot.revisions.length ? ` (${snapshot.revisions.length})` : ''}`
            : id === 'lint'
              ? `${t('lint')}${snapshot.lint.length ? ` (${snapshot.lint.length})` : ''}`
              : t('tree'))),
      );

      const noticeBar = notice
        ? h('div', {
            className: `mx-note ${notice.kind === 'error' ? 'mx-error' : ''}`,
            role: notice.kind === 'error' ? 'alert' : 'status',
          }, notice.text)
        : null;

      if (tab === 'versions') {
        return h('div', { className: 'mx-tree-page' }, h('style', null, CSS), header, tabs, noticeBar,
          h('div', { className: 'mx-pane', style: { paddingLeft: 0 } },
            snapshot.revisions.length === 0
              ? h('div', { className: 'mx-note' }, t('noVersions'))
              : snapshot.revisions.map((revision) =>
                  h('div', { key: revision.id },
                    h('div', {
                      className: 'mx-rev',
                      'data-on': String(openRevision === revision.id),
                      onClick: () => showRevision(revision.id),
                      role: 'button',
                      tabIndex: 0,
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') showRevision(revision.id);
                      },
                    },
                      h('span', { className: 'mx-rev-id' }, `#${revision.id}`),
                      h('span', { className: 'mx-rev-op' }, revision.op),
                      h('span', { className: 'mx-rev-detail' },
                        revision.path ?? revision.detail ?? ''),
                      h('span', { className: 'mx-rev-time' },
                        // `at` is the Host's local time; `createdAt` (UTC, as stored) only backs up an older Host
                        String(revision.at ?? revision.createdAt ?? '').slice(5, 16))),
                    openRevision === revision.id
                      ? h('div', { style: { margin: '2px 0 10px' } },
                          diff === null
                            ? h('div', { className: 'mx-note' }, t('loading'))
                            : diff.ok
                              ? h('pre', { className: 'mx-diff' },
                                  diffRowsOf(diff).map((line, i) =>
                                    h('span', { key: i, className: line.kind === 'add' ? 'a' : line.kind === 'del' ? 'd' : undefined },
                                      `${line.text}\n`)))
                              : h('div', { className: 'mx-note mx-error' }, diff.text ?? t('loadFailed')),
                          h('div', { style: { marginTop: 6 } },
                            h('button', {
                              className: 'mx-ghost',
                              type: 'button',
                              disabled: busy,
                              onClick: () => rollback(revision.id),
                            }, t('rollback'))))
                      : null,
                  )),
          ));
      }

      if (tab === 'lint') {
        return h('div', { className: 'mx-tree-page' }, h('style', null, CSS), header, tabs, noticeBar,
          h('div', { className: 'mx-pane', style: { paddingLeft: 0 } },
            snapshot.lint.length === 0
              ? h('div', { className: 'mx-note' }, t('noLint'))
              : snapshot.lint.map((issue, index) =>
                  h('div', { key: index, className: 'mx-issue', 'data-warn': String(issue.level === 'warn') },
                    h('div', { className: 'mx-rule' }, `${issue.level === 'warn' ? t('warn') : t('info')} · ${issue.rule} @ ${issue.path || '/'}`),
                    h('div', null, issue.message))),
          ));
      }

      // Tree tab: the outline plus the selected node.
      const branches = new Set(snapshot.outline.map((entry) => parentOf(entry.path)).filter((path) => path != null));
      const isOpen = (path) => collapsed.get(path) !== true;
      const rows = visibleRows(snapshot.outline, collapsed);
      const foldedCount = [...branches].filter((path) => collapsed.get(path) === true).length;

      // One click selects a row and, when it has children, folds or unfolds it.
      // Single-click folding is how the host's own sidebar rows behave, and it
      // guarantees the first click on a row does something visible: selecting
      // alone changed nothing when the row was already the selected one.
      const activate = (entry) => {
        setSelected(entry.path);
        if (branches.has(entry.path)) setExpanded(entry.path, !isOpen(entry.path));
      };

      // Arrow keys walk the visible rows; left and right fold the row in place.
      const onRowKey = (event, entry) => {
        // A modified arrow is the browser's or the OS's shortcut, not tree navigation.
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const index = rows.findIndex((row) => row.path === entry.path);
        const go = (path) => {
          if (path == null) return;
          event.preventDefault();
          reveal(path);
          rowEls.current?.get(path)?.focus?.();
        };
        const fold = (open) => {
          event.preventDefault();
          setExpanded(entry.path, open);
        };
        const branch = branches.has(entry.path);
        switch (event.key) {
          case 'Enter':
          case ' ':
            activate(entry);
            event.preventDefault();
            return;
          case 'ArrowRight':
            // Unfold a folded branch; a leaf, or a branch already open, stays put.
            if (branch && !isOpen(entry.path)) fold(true);
            return;
          case 'ArrowLeft':
            if (branch && isOpen(entry.path)) fold(false);
            else go(parentOf(entry.path));
            return;
          case 'ArrowDown':
            go(rows[index + 1]?.path);
            return;
          case 'ArrowUp':
            go(rows[index - 1]?.path);
            return;
          case 'Home':
            go(rows[0]?.path);
            return;
          case 'End':
            go(rows[rows.length - 1]?.path);
            return;
          default:
        }
      };

      // Folding everything leaves only the top level on screen, so the selection
      // moves to the selected node's top-level ancestor: the highlighted row and
      // the right pane keep showing the same branch.
      const foldAll = (open) => {
        setCollapsed(open ? new Map() : new Map([...branches].map((path) => [path, true])));
        if (!open && selected != null) {
          let top = selected;
          while (parentOf(top) != null) top = parentOf(top);
          setSelected(top);
        }
      };
      const browsing = query.trim().length === 0;
      const foldButton = (key, open, disabled) =>
        h('button', {
          className: 'mx-textbtn',
          type: 'button',
          disabled: !browsing || disabled,
          onClick: () => foldAll(open),
        }, t(key));

      const side = h('div', { className: 'mx-side' },
        h('div', { style: { padding: '0 8px 0 0', display: 'flex', flexDirection: 'column' } },
          h('input', {
            className: 'mx-input',
            type: 'search',
            placeholder: t('searchPlaceholder'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
            'aria-label': t('searchPlaceholder'),
          }),
          h('div', { className: 'mx-tools' },
            foldButton('collapseAll', false, foldedCount === branches.size),
            foldButton('expandAll', true, foldedCount === 0))),
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8 } },
          !browsing
            ? searching && hits === null
              ? h('div', { className: 'mx-note' }, t('searching'))
              : (hits ?? []).length === 0
                ? h('div', { className: 'mx-note' }, t('noResults'))
                : (hits ?? []).map((hit, index) =>
                    h('div', {
                      key: `${hit.path}-${index}`,
                      className: 'mx-hit',
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => {
                        setQuery('');
                        revealAndFocus(hit.path);
                      },
                      onKeyDown: (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setQuery('');
                        revealAndFocus(hit.path);
                      },
                    },
                      h('div', { className: 'mx-hit-chain' }, [...hit.ancestors, hit.title].join(' › ')),
                      h('div', { className: 'mx-hit-snip' }, hit.snippet)))
            : rows.length === 0
              ? h('div', { className: 'mx-note' }, t('empty'))
              : h('div', { role: 'tree', 'aria-label': t('tree') }, rows.map((entry, rowIndex) => {
                  const branch = branches.has(entry.path);
                  const on = entry.path === selected;
                  return h('div', {
                    key: entry.path,
                    ref: (element) => {
                      if (element) rowEls.current.set(entry.path, element);
                      else rowEls.current.delete(entry.path);
                    },
                    className: 'mx-row',
                    role: 'treeitem',
                    'aria-level': entry.depth + 1,
                    'aria-selected': String(on),
                    'aria-expanded': branch ? String(isOpen(entry.path)) : undefined,
                    // Roving tab stop: Tab enters the list at the selected row (the
                    // first one when nothing is selected); the arrow keys take over.
                    tabIndex: on || (selected == null && rowIndex === 0) ? 0 : -1,
                    'data-on': String(on),
                    // The second click of a double-click would fold straight back;
                    // folding used to need a double-click, so let one land as one.
                    onClick: (event) => {
                      if (event.detail > 1) return;
                      activate(entry);
                    },
                    onKeyDown: (event) => onRowKey(event, entry),
                    title: entry.summary || entry.path,
                  },
                    // Indent first, then the chevron: the marker belongs to the row's own column.
                    h('span', { className: 'mx-indent', style: { width: entry.depth * INDENT }, 'aria-hidden': true }),
                    h('span', { className: 'mx-caret' }, branch ? h(Chevron) : null),
                    h('span', { className: 'mx-name' }, entry.title),
                    entry.leafTotal > 0
                      ? h('span', { className: 'mx-leafcount' }, `[${entry.leafTotal}]`)
                      : null);
                }))),
      );

      // A level that only groups other nodes used to answer with "memory is
      // empty". It is not: say so, and offer the children as shortcuts.
      const children = node ? snapshot.outline.filter((entry) => parentOf(entry.path) === node.path) : [];
      const detail = h('div', { className: 'mx-pane' },
        !node
          ? h('div', { className: 'mx-note' }, snapshot.outline.length === 0 ? t('empty') : t('noSelection'))
          : h('div', null,
              h('div', { className: 'mx-crumb' }, node.path),
              h('h2', { className: 'mx-node-title' }, node.title),
              node.summary ? h('p', { className: 'mx-summary' }, node.summary) : null,
              node.leaves.length > 0
                ? h('div', null,
                    h('div', { className: 'mx-section' }, `${t('leaves')} (${node.leaves.length})`),
                    h('ul', { className: 'mx-facts' }, node.leaves.map((leaf, index) => h('li', { key: index }, leaf))))
                : null,
              node.content
                ? h('div', null,
                    h('div', { className: 'mx-section' }, t('content')),
                    h('div', { className: 'mx-md' }, markdown(node.content)))
                : null,
              node.leaves.length === 0 && !node.content
                ? children.length > 0
                  ? h('div', null,
                      h('div', { className: 'mx-note' }, t('noFacts')),
                      h('div', { className: 'mx-section' }, `${t('children')} (${children.length})`),
                      h('ul', { className: 'mx-children' },
                        children.map((child) => h('li', { key: child.path },
                          h('button', { className: 'mx-ghost', type: 'button', onClick: () => revealAndFocus(child.path) },
                            child.title, child.leafTotal > 0 ? ` [${child.leafTotal}]` : '')))))
                  : h('div', { className: 'mx-note' }, t('nodeEmpty'))
                : null));

      return h('div', { className: 'mx-tree-page' }, h('style', null, CSS), header, tabs, noticeBar,
        h('div', { className: 'mx-body' }, side, detail));
    }

    /** The sidebar row's icon; the sidebar owns the button, label, and selection. */
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('path', { d: 'M12 3v5' }),
        h('path', { d: 'M12 8H6.5v4' }),
        h('path', { d: 'M12 8h5.5v4' }),
        h('rect', { x: 3.5, y: 12, width: 6, height: 6, rx: 1.6 }),
        h('rect', { x: 14.5, y: 12, width: 6, height: 6, rx: 1.6 }),
        h('circle', { cx: 12, cy: 3.2, r: 1.6 }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, dict), 'memory-x-dsh: dictionaries');
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon)), 'memory-x-dsh: sidebar entry');
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, GuardedMemoryTreePage)), 'memory-x-dsh: memory page');
      },
    };
  },
});
