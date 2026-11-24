# Memory tree

A long-term memory tree that survives session boundaries. Facts the conversation
produced are written into a durable tree, the tree’s catalog is part of the
prompt, and a read-only panel shows what is stored, how it changed, and what it
looks like compared with any earlier revision.

The tree engine is [memory-x](https://github.com/allmonday/memory-x)’s
`@memory-x/core` (MIT), vendored in `core/`. What is new here is the DSH
integration: the tools, the prompt contributions, per-session write guards, and
the panel. Storage and migration notes are at the end of this page.

## What the agent gets

Fourteen `memory_*` tools:

| Tool | Purpose |
| --- | --- |
| `memory_read` | Read one subtree as a markdown outline. |
| `memory_search` | Search the tree; a hit carries its path, ancestors, and a snippet. |
| `memory_upsert` | Add one leaf fact. Exact duplicates are a no-op; missing parent nodes are created. |
| `memory_update` | Replace one leaf in place, so a superseded fact disappears instead of piling up. |
| `memory_write_note` | Store a node’s long-form markdown body (the RAG corpus). |
| `memory_summary` | Read or write a node’s one-line navigation summary. |
| `memory_history` | Past values of a node, newest first, one row per revision that wrote it. |
| `memory_changes` | Recent activity grouped by revision, with value-level `old → new` (an update is one row). Whole revisions are kept or skipped as a unit; `revision` lists one revision in full. |
| `memory_move` / `memory_delete` | Restructure or remove a subtree. Both stay in history. |
| `memory_diary` | One day’s activity, cached after the agent summarizes it. |
| `memory_stats` | Node count, leaf count, depth, top-level domains. |
| `memory_evidence` / `memory_link_evidence` | Tie a leaf to the session events that justify it. |
| `memory_propose` | Apply a tidy plan (a structured operation list) as one revision. |

Every leaf write is stamped with the day automatically, so a fact keeps its date
without the model remembering to add one.

## What the prompt gets

- A **catalog** section: the tree’s headings with leaf counts, a rule for when to
  read, write, or supersede, and the write style. Its character budget is
  `catalogMaxChars` (1600 by default).
- A **recall** context per turn: up to three memories that match the user’s
  message, above `recallMinScore`. It is a dynamic context rather than a fixed
  section, so it travels with the turn it belongs to.

## Anchoring

`anchor` decides how hard the write protocol is:

| Value | Behavior |
| --- | --- |
| `off` | No protocol in the prompt, no guards. |
| `hint` (default) | The prompt asks the agent to resolve and read a node before writing; a write to a node this session has not read, or a likely duplicate outside the target subtree, comes back with a warning. |
| `strict` | The unread-node case refuses the write. |

Read state and tidy mode are tracked per session, so two sessions in one Host
never share a write gate.

## The panel

The sidebar’s **记忆树** entry opens a panel with three tabs:

- **目录** — the tree with leaf counts and a search box. One click selects a
  node and, when it has children, folds or unfolds it; arrow keys walk the
  rows, and two buttons beside the search box expand or collapse everything.
  The right pane shows the selected node’s facts plus its markdown body, or its
  child nodes when the level only groups them.
- **版本** — revisions newest-first; open one to see a colour-coded diff against
  its predecessor.
- **体检** — structural lint: deep nesting, oversized node, duplicate titles.

The panel is read-only, matching the original UI: writing is the conversation’s
job. The version tab offers a copyable `/memory rollback <id>` command instead of
a button that would bypass the agent.

## Commands

```
/memory                   catalog and scale
/memory stats             node and leaf counts, data location
/memory log [n]           revision history
/memory changes [n|#id]   recent changes within an n-row budget, or every row of revision #id
/memory rollback <id>     roll back (writes a new revision; history is kept)
/memory lint              structural issues
/memory diary <date>      one day’s activity
```

## Storage, migration, backups

The undo log is leaf-level: every leaf add, update, or removal is one row in
`leaf_changes`, so an update is recorded as `old → new` for that one leaf
instead of a snapshot of the whole node. Rolling back to any revision replays
those rows, which is what the version tab's diff and `/memory rollback` rely on.

The first start after upgrading from the snapshot format migrates the database
in place (about 0.2 s for a tree of 1200 revisions) and vacuums it. Take a
backup first:

```
node scripts/backup.mjs --label before-upgrade
```

It goes through SQLite's own backup API, so the copy is consistent even while
the Host has the database open, and it lands in `~/.dsh/memory-x/backups/`. To
restore: stop the Host, move `.memory/memory.db*` aside, copy the backup to
`.memory/memory.db`, start the Host.

The replay carries three changes over memory-x as of `b92d8c6`, each marked
`DSH 修正` / `DSH 新增` in `core/store.ts`: revisions are undone in strict
descending order, leaf positions are re-indexed before removed leaves are put
back, and leaves written when a node was created are kept in the audit view and
the history after migration. The first two are also on memory-x as of `7fbd36c`;
the third is DSH-only. Rehearsing the migration on a real tree had shown 986 of
1194 revisions materializing differently from the snapshot replay;
`tests/leaf-replay.test.mjs` pins each case.

The engine stores timestamps in UTC (`datetime('now')`, no zone marker). Every
time the tools, `/memory log`, or the panel print is the Host's local time;
`service.revisions()` keeps the stored value in `createdAt` and adds the
printable one in `at`.

## Tests

`npm test` runs the DSH tests (`tests/*.test.mjs`) and memory-x's own core
suite, ported under `tests/upstream/`. After syncing `core/` with a newer
memory-x, re-port the suite so it matches:

```
node scripts/port-upstream-tests.mjs            # defaults to ~/Documents/memory-x
node scripts/build-core.mjs && npm test
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `~/.dsh/memory-x/memory` | Directory holding `.memory/memory.db`. |
| `anchor` | `hint` | Anchor protocol strength. |
| `recallMinScore` | `1.0` | Recall injection gate; raise it to inject less. |
| `catalogMaxChars` | `1600` | Catalog budget in characters. |

The default location is deliberately separate from a pi installation’s
`~/memory-x/memory`: two processes writing one SQLite file is the one arrangement
the tree’s file lock cannot make safe.

Point `dataDir` at an existing memory-x directory to keep using that tree from
DSH. Do not run a pi session and a DSH session against the same directory at the
same time.

## Limitations

- The panel reads through one JSON route on the DSH page’s own origin. It has no
  write endpoint by design.
- Very large trees render every matching node; the catalog, not the panel, is
  what the model sees.
- The markdown renderer covers the subset memory bodies use (headings, lists,
  quotes, fenced code, tables, rules, inline marks). Raw HTML in a body renders as
  text.
