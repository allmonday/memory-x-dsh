/**
 * Timestamps on the model-facing side.
 *
 * The engine stamps revisions with SQLite's `datetime('now')`, which is UTC
 * without a zone marker. Every place that prints a time — `memory_changes`,
 * `memory_history`, `/memory log`, the panel's version tab — goes through the
 * service, so it renders the stored value in the Host's local time.
 *
 * Run with: node --test tests/*.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryService, formatChanges, localTime, withDate } from '../service.js';

/** What `localTime` must print for one stored UTC stamp, derived from this process's zone offset alone. */
function expected(utc) {
  const shifted = new Date(utc.getTime() - new Date(utc).getTimezoneOffset() * 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

const STORED = '2026-11-23 19:04:06'; // 03:04 on 11-24 for a reader in Shanghai
const STAMP = Date.UTC(2026, 10, 23, 19, 4, 6);

test('localTime: a stored UTC stamp becomes local time, to the minute', () => {
  assert.equal(localTime(STORED), expected(new Date(STAMP)));
  assert.match(localTime(STORED), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'no seconds, no zone marker');
  // a stamp near midnight changes day in the reader's zone, not in UTC
  assert.equal(localTime('2026-12-31 16:30:00'), expected(new Date(Date.UTC(2026, 11, 31, 16, 30))));
});

test('localTime: follows the Host zone (child processes with a forced TZ)', () => {
  const serviceUrl = JSON.stringify(new URL('../service.js', import.meta.url).href);
  const run = (zone) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { localTime } from ${serviceUrl}; console.log(localTime(${JSON.stringify(STORED)}));`], {
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
    }).trim();
  assert.equal(run('Asia/Shanghai'), '2026-11-24 03:04');
  assert.equal(run('UTC'), '2026-11-23 19:04');
  assert.equal(run('America/New_York'), '2026-11-23 14:04');
});

test('localTime: the ISO form with T and Z reads the same, anything else passes through', () => {
  assert.equal(localTime('2026-11-23T19:04:06Z'), localTime(STORED));
  assert.equal(localTime(''), '');
  assert.equal(localTime(null), '');
  assert.equal(localTime(undefined), '');
  assert.equal(localTime('not a time'), 'not a time');
});

test('formatChanges: the revision header carries local time', () => {
  const rendered = formatChanges([
    { revisionId: 7, revOp: 'upsert', revDetail: null, op: 'add', path: '甲', fromText: null, toText: '新', createdAt: STORED },
  ]);
  assert.ok(rendered.startsWith(`#7 ${expected(new Date(STAMP))} upsert`), rendered);
});

test('service: the revision log keeps the stored stamp and adds the local one', async () => {
  const service = new MemoryService({ dataDir: await mkdtemp(join(tmpdir(), 'mx-local-time-')), anchor: 'off', recallMinScore: 1 });
  await service.upsert('s', '甲', withDate('第一条', '2026-01-01'));
  const [revision] = await service.revisions();
  assert.match(revision.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'createdAt stays as stored, seconds and all');
  assert.match(revision.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'at is the printable minute');
  assert.equal(revision.at, localTime(revision.createdAt));
  const { text } = await service.changes(10);
  assert.ok(text.startsWith(`#${revision.id} ${revision.at} upsert`), text);
  await service.update('s', '甲', '第一条', withDate('第二条', '2026-01-02'));
  const history = await service.history('甲');
  const newest = (await service.revisions())[0];
  assert.ok(history.text.includes(`rev="#${newest.id}" at="${newest.at}" op="update"`), history.text);
});
