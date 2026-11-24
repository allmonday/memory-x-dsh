#!/usr/bin/env node
/**
 * Consistent online backup of the memory database.
 *
 * The Host keeps `.memory/memory.db` open in WAL mode, so copying the file would
 * capture a torn state: pages that are still in `memory.db-wal` would be missing.
 * This goes through SQLite's own backup API instead, which reads through the WAL
 * and yields one self-contained file even while another process is writing. Run
 * it before a schema migration or before syncing the vendored core.
 *
 * Usage:
 *   node scripts/backup.mjs                            # ~/.dsh/memory-x/backups/memory.db.<label>-<time>
 *   node scripts/backup.mjs --label pre-leaf-changes   # name the reason in the file name
 *   node scripts/backup.mjs --data-dir <dir> --out <file>
 *   node scripts/backup.mjs --list                     # backups already taken
 *
 * Restore: stop the Host, move `.memory/memory.db*` aside, copy the backup to
 * `.memory/memory.db`, start the Host. The store re-applies WAL mode on open.
 */
import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const DEFAULT_DATA_DIR = join(homedir(), '.dsh', 'memory-x', 'memory');
const DEFAULT_BACKUP_DIR = join(homedir(), '.dsh', 'memory-x', 'backups');
const DEFAULT_LABEL = 'backup';

/** Parse `--flag` / `--flag value` arguments into a map. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const stamp = (clock = new Date()) =>
  `${clock.getFullYear()}${String(clock.getMonth() + 1).padStart(2, '0')}${String(clock.getDate()).padStart(2, '0')}` +
  `-${String(clock.getHours()).padStart(2, '0')}${String(clock.getMinutes()).padStart(2, '0')}${String(clock.getSeconds()).padStart(2, '0')}`;

/** Open the source read-only where WAL allows it; fall back to a plain open. */
function openSource(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return new DatabaseSync(path);
  }
}

/** Row counts and schema facts that a migration is expected to preserve or change. */
function fingerprint(db) {
  const one = (sql) => Object.values(db.prepare(sql).get() ?? {})[0];
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  return {
    revisions: one('SELECT COUNT(*) FROM revisions'),
    maxRevision: one('SELECT MAX(id) FROM revisions') ?? 0,
    nodes: one('SELECT COUNT(*) FROM nodes'),
    leaves: one('SELECT COUNT(*) FROM leaves'),
    changeRows: one('SELECT COUNT(*) FROM changes'),
    leafChangeRows: columns('leaf_changes').size > 0 ? one('SELECT COUNT(*) FROM leaf_changes') : null,
    legacyUndoRows: one(`SELECT COUNT(*) FROM changes WHERE before LIKE '%"leaves"%'`),
    leavesWithoutUid: columns('leaves').has('uid') ? one('SELECT COUNT(*) FROM leaves WHERE uid IS NULL') : null,
  };
}

async function list(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    console.log(`no backups yet in ${dir}`);
    return;
  }
  const files = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) files.push({ name, size: info.size, mtime: info.mtime.toISOString() });
  }
  files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  if (files.length === 0) return console.log(`no backups yet in ${dir}`);
  for (const f of files) console.log(`${f.mtime}  ${String(f.size).padStart(10)}  ${join(dir, f.name)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backupDir = resolve(args['backup-dir'] ?? DEFAULT_BACKUP_DIR);
  if (args.list) return list(backupDir);

  const dataDir = resolve(args['data-dir'] ?? DEFAULT_DATA_DIR);
  const source = join(dataDir, '.memory', 'memory.db');
  if (!(await stat(source).catch(() => null))) {
    console.error(`✗ no database at ${source}`);
    process.exitCode = 1;
    return;
  }
  const label = String(args.label ?? DEFAULT_LABEL).replace(/[^A-Za-z0-9._-]+/g, '-');
  const out = resolve(args.out ?? join(backupDir, `memory.db.${label}-${stamp()}`));

  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await chmod(dirname(out), 0o700).catch(() => {});

  const src = openSource(source);
  try {
    await backup(src, out);
  } finally {
    src.close();
  }

  // A copy of a WAL database still carries the WAL flag: make it one standalone
  // file (no -wal/-shm sidecars), then prove it reads back cleanly.
  const dest = new DatabaseSync(out);
  let facts;
  try {
    dest.exec('PRAGMA journal_mode=DELETE');
    const check = dest.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    if (check.join('\n') !== 'ok') throw new Error(`integrity_check failed: ${check.join('; ')}`);
    facts = fingerprint(dest);
  } finally {
    dest.close();
  }
  await chmod(out, 0o600);

  const size = (await stat(out)).size;
  console.log(`✓ ${out}`);
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB · integrity ok`);
  for (const [key, value] of Object.entries(facts)) console.log(`  ${key}: ${value}`);
}

main().catch((error) => {
  console.error(`✗ backup failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
