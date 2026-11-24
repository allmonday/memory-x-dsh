/**
 * Ported from memory-x packages/core/tests/lock.test.ts (7fbd36c) by
 * `node scripts/port-upstream-tests.mjs`. Change it upstream, then re-run the port.
 * It runs against the vendored `core/` build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { withDirLock } from "../../core/lock.js";

test("withDirLock：互斥与释放", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-lock-"));
  let inside = 0;
  let maxConcurrent = 0;

  const job = () =>
    withDirLock(dir, async () => {
      inside++;
      maxConcurrent = Math.max(maxConcurrent, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    });

  await Promise.all([job(), job(), job()]);
  assert.equal(maxConcurrent, 1, "并发任务应被串行化");
  // 锁已释放
  await withDirLock(dir, async () => undefined);
});

test("withDirLock：残留锁按超龄接管", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-lock-"));
  // 手工放置一个"30 秒前"的残留锁
  await writeFile(join(dir, ".memory.lock"), "dead 0\n");
  const past = new Date(Date.now() - 60_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(join(dir, ".memory.lock"), past, past);

  const result = await withDirLock(dir, async () => "ok");
  assert.equal(result, "ok");
});
