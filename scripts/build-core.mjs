#!/usr/bin/env node
/**
 * Generate runtime `core/*.js` from the TypeScript sources in `core/*.ts`.
 *
 * The plugin ships plain ESM: installing it needs no loader and no build. The
 * sources stay TypeScript (the originals come from memory-x `@memory-x/core`, MIT);
 * this script runs Node's own `module.stripTypeScriptTypes` over each one, so type
 * syntax is erased by the runtime's parser rather than by a hand-written regex.
 * `--experimental-transform-types` is used so `enum` / `namespace` would also work
 * if the sources ever gain one; the current sources need only erasure.
 *
 * Usage:
 *   node scripts/build-core.mjs          regenerate core/*.js and verify each imports
 *   node scripts/build-core.mjs --check  fail when a committed .js is stale
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'core');
const checkOnly = process.argv.includes('--check');

const files = (await readdir(CORE)).filter((f) => f.endsWith('.ts')).sort();
const failures = [];
let changed = 0;

for (const file of files) {
  const source = await readFile(join(CORE, file), 'utf8');
  const target = join(CORE, file.replace(/\.ts$/, '.js'));

  // memory-x sources import siblings with an explicit `.ts` extension
  // (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`). Rewrite
  // those specifiers to `.js`, which is what the generated modules live in.
  const retargeted = source.replace(/(from\s+["']\.\/[a-z-]+)\.ts(["'])/g, '$1.js$2');

  let js;
  try {
    js = stripTypeScriptTypes(retargeted, { mode: 'strip', sourceMap: false });
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    continue;
  }
  const output = `${js.trimEnd()}\n`;

  if (checkOnly) {
    const existing = await readFile(target, 'utf8').catch(() => '');
    if (existing !== output) failures.push(`${file}: ${target} is stale, run the build`);
    continue;
  }

  await writeFile(target, output, 'utf8');
  changed++;
  try {
    await import(pathToFileURL(target).href);
  } catch (error) {
    if (/Cannot find (module|package)/.test(error.message)) continue;
    failures.push(`${file} → ${target}: import failed — ${error.message}`);
  }
}

if (failures.length > 0) {
  for (const line of failures) console.error(`✗ ${line}`);
  process.exitCode = 1;
} else {
  console.log(
    checkOnly
      ? `checked ${files.length} core module(s)`
      : `generated ${changed} core module(s) from TypeScript sources`,
  );
}
