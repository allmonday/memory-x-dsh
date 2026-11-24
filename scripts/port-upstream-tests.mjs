#!/usr/bin/env node
/**
 * Port memory-x's core test-suite onto the vendored core.
 *
 * The engine under `core/` is a vendored copy of memory-x's `@memory-x/core`,
 * so its own tests are the regression net for every upstream sync: a sync that
 * changes what the engine does fails here before it reaches a session. Each
 * upstream test file is type-stripped (the same erasure `build-core.mjs` uses)
 * and its `../src/*.ts` imports are pointed at `../../core/*.js`, then written
 * to `tests/upstream/*.test.mjs`.
 *
 * Tests that exercise the pi extension are not core tests and are skipped.
 *
 * Usage:
 *   node scripts/port-upstream-tests.mjs                    # from ~/Documents/memory-x
 *   node scripts/port-upstream-tests.mjs <memory-x checkout>
 *   node scripts/port-upstream-tests.mjs <checkout> --check # fail when a port is stale
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests', 'upstream');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const checkout = args.find((a) => !a.startsWith('--')) ?? join(homedir(), 'Documents', 'memory-x');
const testsDir = join(checkout, 'packages', 'core', 'tests');

const commit = (() => {
  try {
    return execFileSync('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown commit';
  }
})();

const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.ts')).sort();
let stale = 0;
let written = 0;
for (const file of files) {
  const source = await readFile(join(testsDir, file), 'utf8');
  if (/["']\.\.\/\.\.\//.test(source)) continue; // reaches outside packages/core: pi extension or UI, not a core test
  const js = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false }).replace(
    /from\s+(["'])\.\.\/src\/([a-z-]+)\.ts\1/g,
    'from $1../../core/$2.js$1',
  );
  const target = join(OUT, file.replace(/\.test\.ts$/, '.test.mjs'));
  const output =
    `/**\n` +
    ` * Ported from memory-x packages/core/tests/${file} (${commit}) by\n` +
    ` * \`node scripts/port-upstream-tests.mjs\`. Change it upstream, then re-run the port.\n` +
    ` * It runs against the vendored \`core/\` build.\n` +
    ` */\n` +
    `${js.trimEnd()}\n`;
  if (checkOnly) {
    const existing = await readFile(target, 'utf8').catch(() => '');
    if (existing !== output) {
      stale++;
      console.error(`✗ ${file}: ${target} is stale, re-run the port`);
    }
    continue;
  }
  await writeFile(target, output, 'utf8');
  written++;
}

if (stale > 0) process.exitCode = 1;
else {
  console.log(
    checkOnly
      ? `checked ${files.length} upstream test file(s): ports are current (${commit})`
      : `ported ${written} core test file(s) from ${testsDir} (${commit}) into tests/upstream`,
  );
}
