/**
 * Port regression: the vendored core must keep behaving like memory-x's own test
 * suite expects after the TypeScript strip, and the service layer must honour the
 * two DSH-specific rules that pi did not have — per-session write state and the
 * read-before-write anchor gate.
 *
 * Run with: node --test tests/*.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryFile } from '../core/index.js';
import { MemoryService, withDate, formatChanges } from '../service.js';

const freshDir = () => mkdtemp(join(tmpdir(), 'memory-x-dsh-'));

test('core: parse, address, and round-trip a node', async () => {
  const dir = await freshDir();
  const file = await MemoryFile.open(dir);
  await file.upsertNode('工作/pi生态', 'RPC 与 SDK 共享 core 层');
  const read = file.readSection('工作/pi生态');
  assert.ok(read);
  assert.deepEqual(read.node.leaves, ['RPC 与 SDK 共享 core 层']);
});

test('core: update replaces in place and ignores the date mark', async () => {
  const dir = await freshDir();
  const file = await MemoryFile.open(dir);
  await file.upsertNode('偏好', withDate('编辑器用 Vim', '2026-01-01'));
  const result = await file.updateNode('偏好', '编辑器用 Vim', withDate('编辑器用 Neovim', '2026-02-02'));
  assert.equal(result.ok, true);
  const read = file.readSection('偏好');
  assert.equal(read.node.leaves.length, 1);
  assert.match(read.node.leaves[0], /Neovim/);
});

test('core: update refuses an ambiguous match', async () => {
  const dir = await freshDir();
  const file = await MemoryFile.open(dir);
  await file.upsertNode('偏好', withDate('编辑器用 Vim', '2026-01-01'));
  await file.upsertNode('偏好', '编辑器用 Vim');
  const result = await file.updateNode('偏好', '编辑器用 Vim', '编辑器用 Neovim');
  assert.equal(result.ok, false);
});

test('core: a revision can be materialized and rolled back', async () => {
  const dir = await freshDir();
  const file = await MemoryFile.open(dir);
  await file.upsertNode('甲', '第一条');
  const first = (await file.listRevisions(1))[0].id;
  await file.upsertNode('甲', '第二条');
  const tree = file.treeAt(first);
  assert.ok(tree);
  assert.equal(tree.children.find((child) => child.title === '甲').leaves.length, 1);
  const restored = await file.restoreRevision(first);
  assert.equal(restored.ok, true);
  assert.equal(file.readSection('甲').node.leaves.length, 1);
});

test('service: tidy mode is per session, not per process', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'hint', recallMinScore: 1 });
  service.beginTidy('session-a', null);
  assert.equal(service.isTidying('session-a'), true);
  assert.equal(service.isTidying('session-b'), false);
  service.endTidy('session-a');
  assert.equal(service.isTidying('session-a'), false);
});

test('service: strict anchoring refuses a write to an unread node', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'strict', recallMinScore: 1 });
  assert.equal((await service.upsert('s', '甲', '第一条')).ok, true);
  // Same session, node never read: refused.
  const refused = await service.upsert('s', '甲', '第二条');
  assert.equal(refused.ok, false);
  assert.match(refused.text, /strict/);
  // After reading it, the write is admitted.
  await service.read('甲', 's');
  assert.equal((await service.upsert('s', '甲', '第二条')).ok, true);
});

test('service: hint anchoring warns but writes', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'hint', recallMinScore: 1 });
  await service.upsert('s', '甲', '第一条');
  const second = await service.upsert('s', '甲', '第二条');
  assert.equal(second.ok, true);
  assert.match(second.text, /未 memory_read/);
});

test('service: anchor state does not leak between sessions', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'strict', recallMinScore: 1 });
  await service.upsert('s1', '甲', '第一条');
  await service.read('甲', 's1');
  const other = await service.upsert('s2', '甲', '第二条');
  assert.equal(other.ok, false);
});

test('service: a scoped tidy plan cannot touch nodes outside its scope', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'hint', recallMinScore: 1 });
  await service.upsert('s', '甲', '第一条');
  await service.upsert('s', '乙', '另一条');
  service.beginTidy('s', '甲');
  const result = await service.tidy('s', [{ op: 'add_leaf', path: '乙', leaf: '越界' }], '越界测试');
  assert.equal(result.ok, false);
  assert.match(result.text, /超出整理范围/);
});

test('service: tidy applies one revision and leaves other nodes alone', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'hint', recallMinScore: 1 });
  await service.upsert('s', '甲', '第一条');
  await service.upsert('s', '乙', '原样保留');
  service.beginTidy('s', '甲');
  const result = await service.tidy('s', [{ op: 'add_leaf', path: '甲', leaf: '第二条' }], '补一条');
  assert.equal(result.ok, true);
  const outline = await service.outline();
  assert.deepEqual(outline.find((node) => node.path === '乙').leaves, ['原样保留 ← ' + withDate('x').slice(-10)]);
});

test('service: formatChanges groups rows by revision', async () => {
  const rendered = formatChanges([
    { revisionId: 2, revOp: 'tidy', revDetail: '合并', op: 'add_leaf', path: '甲', fromText: null, toText: '新', createdAt: '2026-01-02 00:00:00' },
    { revisionId: 1, revOp: 'upsert', revDetail: null, op: 'add_leaf', path: '乙', fromText: '旧', toText: '新', createdAt: '2026-01-01 00:00:00' },
  ]);
  assert.match(rendered, /^#2 /);
  assert.match(rendered, /#1 /);
  assert.match(rendered, /旧 → 新/);
});

test('service: stats and outline agree on the tree', async () => {
  const service = new MemoryService({ dataDir: await freshDir(), anchor: 'off', recallMinScore: 1 });
  await service.upsert('s', '工作/项目', '一条事实');
  const stats = await service.stats();
  const outline = await service.outline();
  assert.equal(stats.leaves, 1);
  assert.equal(outline.length, stats.nodes);
  assert.ok(outline.some((node) => node.path === '工作/项目' && node.leafTotal === 1));
});
