/**
 * Leaf-level replay regression: the vendored core records leaf changes per leaf
 * (memory-x 52f89a4 / f5ec70d), and replaying them must rebuild every past
 * revision exactly — rollback and the panel's version diff both depend on it.
 *
 * These cases came out of rehearsing the migration on a copy of a real tree
 * (1194 revisions): with the upstream replay as it shipped, 986 of them
 * materialized differently from the snapshot-based replay it replaced.
 *
 * Run with: node --test tests/*.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { MemoryFile } from '../core/index.js';
import { MemoryService, withDate } from '../service.js';

const freshDir = (prefix) => mkdtemp(join(tmpdir(), prefix));
const rawDb = (dir) => new DatabaseSync(join(dir, '.memory', 'memory.db'));

/** Leaves of one node as a past revision had them, in order; null when the node did not exist. */
const leavesAt = (tree, path) => {
  const walk = (node, trail) => {
    const at = trail ? `${trail}/${node.title}` : node.title;
    if (at === path) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child, at);
      if (hit) return hit;
    }
    return null;
  };
  for (const child of tree.children ?? []) {
    const hit = walk(child, '');
    if (hit) return hit.leaves;
  }
  return null;
};

/**
 * Rewrite revisions [fromRev, toRev] the way the pre-leaf-level code stored
 * them: one node row per revision whose `before` carries the full leaf array,
 * and no leaf rows. Same construction as memory-x's backfill-legacy test.
 */
function legacyize(dir, file, fromRev, toRev) {
  const db = rawDb(dir);
  for (let rev = fromRev; rev <= toRev; rev++) {
    const before = rev > 1 ? file.treeAt(rev - 1) : null;
    const touched = db
      .prepare(
        `SELECT node_uid AS uid, path FROM leaf_changes WHERE revision_id = ?
         UNION SELECT uid, path FROM changes WHERE revision_id = ?`,
      )
      .all(rev, rev);
    const seen = new Set();
    db.exec('BEGIN');
    db.prepare('DELETE FROM leaf_changes WHERE revision_id = ?').run(rev);
    db.prepare('DELETE FROM changes WHERE revision_id = ?').run(rev);
    const ins = db.prepare('INSERT INTO changes(revision_id, uid, path, deleted, before) VALUES (?, ?, ?, ?, ?)');
    for (const row of touched) {
      if (seen.has(row.uid)) continue;
      seen.add(row.uid);
      // the node as it stood right before this revision: null when it did not exist yet
      const hit = before ? findRow(before, row.uid) : null;
      ins.run(
        rev,
        row.uid,
        row.path,
        0,
        hit
          ? JSON.stringify({
              title: hit.node.title,
              leaves: hit.node.leaves,
              parentUid: hit.parent?.uid ?? null,
              ord: hit.parent ? hit.parent.children.indexOf(hit.node) : 0,
            })
          : null,
      );
    }
    db.exec('COMMIT');
  }
  db.close();
}

function findRow(node, uid, parent = null) {
  if (node.uid === uid) return { node, parent };
  for (const child of node.children ?? []) {
    const hit = findRow(child, uid, node);
    if (hit) return hit;
  }
  return null;
}

test('replay: a revision that only has node rows is undone before higher leaf rows', async () => {
  const dir = await freshDir('mx-replay-order-');
  const file = await MemoryFile.open(dir);
  await file.upsertNode('甲/X', '一'); // #1
  await file.upsertNode('乙/锚', '锚'); // #2
  // #3 carries a leaf row, so the engine files it under "leaf" revisions, and moves X under 乙
  await file.applyOps([
    { op: 'move', from: '甲/X', to: '乙' },
    { op: 'add_leaf', path: '乙/锚', leaf: '锚二' },
  ]);
  await file.writeSummary('乙/X', '摘要'); // #4: a node row only
  assert.deepEqual(file.readSection('乙/X').node.leaves, ['一'], '当前态：X 在乙下面');
  // At #1 乙 did not exist. Replaying #4 after #3 would park X under a node that
  // is then removed, and X would silently drop out of the tree.
  assert.deepEqual(leavesAt(file.treeAt(1), '甲/X'), ['一'], '#1：X 仍在甲下面');
  assert.equal(leavesAt(file.treeAt(1), '乙/锚'), null, '#1：乙尚未创建');
  assert.equal((await file.restoreRevision(1)).ok, true);
  assert.deepEqual(file.readSection('甲/X').node.leaves, ['一'], '回滚到 #1 后 X 在甲下面');
  assert.deepEqual(
    file.root.children.map((child) => child.title),
    ['甲'],
    '回滚到 #1 后乙不存在',
  );
});

test('replay: a gap left by an undone add does not shift earlier leaves (migrated data)', async () => {
  const dir = await freshDir('mx-replay-gap-');
  const file = await MemoryFile.open(dir);
  await file.upsertNode('域', '一'); // #1
  await file.upsertNode('域', '二'); // #2
  await file.upsertNode('域', '三'); // #3
  await file.upsertNode('域', '四'); // #4
  await file.applyOps([{ op: 'remove_leaf', path: '域', match: '四' }]); // #5 → 一 二 三
  await file.updateNode('域', '二', '二改'); // #6 → 一 二改 三
  await file.upsertNode('域', '五'); // #7 → 一 二改 三 五
  legacyize(dir, file, 1, 7); // the pre-leaf-level format: an in-place update is a remove + an add
  const migrated = await MemoryFile.open(dir);
  const db = rawDb(dir);
  const blobs = db.prepare('SELECT COUNT(*) AS n FROM changes WHERE before_leaves IS NOT NULL').get().n;
  db.close();
  assert.equal(blobs, 0, '旧格式已回填为叶级行');
  assert.deepEqual(migrated.readSection('域').node.leaves, ['一', '二改', '三', '五']);
  assert.deepEqual(leavesAt(migrated.treeAt(7), '域'), ['一', '二改', '三', '五']);
  assert.deepEqual(leavesAt(migrated.treeAt(6), '域'), ['一', '二改', '三']);
  assert.deepEqual(leavesAt(migrated.treeAt(5), '域'), ['一', '二', '三']);
  assert.deepEqual(leavesAt(migrated.treeAt(4), '域'), ['一', '二', '三', '四'], '#4：三 仍排在四 之前');
  assert.deepEqual(leavesAt(migrated.treeAt(2), '域'), ['一', '二']);
  assert.deepEqual(leavesAt(migrated.treeAt(1), '域'), ['一']);
  assert.equal((await migrated.restoreRevision(4)).ok, true);
  assert.deepEqual(migrated.readSection('域').node.leaves, ['一', '二', '三', '四'], '回滚到 #4：顺序精确恢复');
});

test('migration: leaves written when a node was created stay in the audit view and the history', async () => {
  const dir = await freshDir('mx-creation-');
  const file = await MemoryFile.open(dir);
  await file.upsertNode('域/节点', '事实甲'); // #1 建节点 + 初始叶子（旧格式时代没有叶级行）
  await file.upsertNode('域/节点', '事实乙'); // #2
  legacyize(dir, file, 1, 2);
  const migrated = await MemoryFile.open(dir);
  const audit = () => migrated.listChanges({ revisionId: 1 }).map((row) => `${row.op}:${row.toText ?? row.fromText}`);
  assert.deepEqual(audit(), ['add:事实甲', 'add-node:域', 'add-node:节点'], '建节点那一版：初始叶子与 add-node 都在');
  const history = migrated.nodeHistory('域/节点').rows.map((row) => `#${row.revisionId} ${row.op} ${row.value ?? ''}`);
  assert.ok(history.includes('#1 add 事实甲'), `历史里有建节点时的初始叶子：${history.join(' | ')}`);
  assert.deepEqual(leavesAt(migrated.treeAt(1), '域/节点'), ['事实甲']);

  const db = rawDb(dir);
  const count = db.prepare('SELECT COUNT(*) AS n FROM leaf_changes').get().n;
  db.close();
  await MemoryFile.open(dir); // 再开一次：一行不多
  assert.deepEqual(audit(), ['add:事实甲', 'add-node:域', 'add-node:节点']);
  const db2 = rawDb(dir);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM leaf_changes').get().n, count, '重复打开不产生重复叶级行');
  db2.close();
});

test('audit view: rows of one revision come back in a stable order', async () => {
  const dir = await freshDir('mx-stable-order-');
  const file = await MemoryFile.open(dir);
  await file.upsertNode('域/节点', '锚');
  const rev = Number(
    (
      await file.applyOps([
        { op: 'add_leaf', path: '域/节点', leaf: '丙' },
        { op: 'add_leaf', path: '域/节点', leaf: '甲' },
        { op: 'add_leaf', path: '域/节点', leaf: '乙' },
      ])
    ).revision,
  );
  const texts = () => file.listChanges({ revisionId: rev }).filter((row) => row.op === 'add').map((row) => row.toText);
  assert.deepEqual(texts(), ['丙', '乙', '甲'], '叶子 uid 是随机的，行序按文本码点走，不跟它抖动');
  assert.deepEqual(texts(), ['丙', '乙', '甲']);
});

test('service: an update lands in the audit view as one from→to row', async () => {
  const service = new MemoryService({ dataDir: await freshDir('mx-service-update-'), anchor: 'off', recallMinScore: 1 });
  await service.upsert('s', '偏好', '编辑器用 Vim');
  const revision = (await service.update('s', '偏好', '编辑器用 Vim', '编辑器用 Neovim')).revision;
  const { rows, text } = await service.changes(10);
  const row = rows.find((change) => change.op === 'update');
  assert.ok(row, `有一条 update 行：${text}`);
  assert.equal(row.revisionId, Number(revision));
  assert.match(row.fromText, /^编辑器用 Vim/);
  assert.match(row.toText, /^编辑器用 Neovim/);
  assert.match(text, /update 偏好：编辑器用 Vim ← \d{4}-\d{2}-\d{2} → 编辑器用 Neovim/);
  assert.equal(rows.filter((change) => change.op === 'remove' || change.op === 'add').length, 1, '只有建节点那一版的 add，update 不再拆成 remove + add');
});

test('service: a revision too large for the budget says so, and can be listed whole', async () => {
  const service = new MemoryService({ dataDir: await freshDir('mx-service-budget-'), anchor: 'off', recallMinScore: 1 });
  await service.upsert('s', '待办', '锚');
  const revision = Number(
    (
      await service.tidy(
        's',
        Array.from({ length: 15 }, (_, i) => ({ op: 'add_leaf', path: '待办', leaf: `第${i}项` })),
        '批量补充',
      )
    ).revision,
  );
  const budgeted = await service.changes(10);
  assert.equal(budgeted.rows.length, 12, '最新版本最多给 max(limit, 12) 行');
  assert.equal(budgeted.heldBack, 15 - 12);
  assert.match(budgeted.text, new RegExp(`版本 #${revision} 行数较多，这里只列了前 12 行，还有 3 行；memory_changes 的 revision=${revision}`));
  const whole = await service.changes(10, revision);
  assert.equal(whole.rows.length, 15, '指定版本时不看预算');
  assert.equal(whole.heldBack, 0);
  assert.doesNotMatch(whole.text, /行数较多/);
  const missing = await service.changes(10, 999);
  assert.equal(missing.rows.length, 0);
});

test('service: a leaf rewritten in place keeps its history as one chain', async () => {
  const service = new MemoryService({ dataDir: await freshDir('mx-service-history-'), anchor: 'off', recallMinScore: 1 });
  await service.upsert('s', '偏好', withDate('编辑器用 Vim', '2026-01-01'));
  await service.update('s', '偏好', '编辑器用 Vim', withDate('编辑器用 Neovim', '2026-02-02'));
  const result = await service.history('偏好');
  assert.equal(result.ok, true);
  assert.match(result.text, /op="update"/);
  assert.match(result.text, /编辑器用 Neovim/);
  const read = await service.read('偏好', 's');
  assert.match(read.text, /> 历史：\d+ 次改写/);
});
