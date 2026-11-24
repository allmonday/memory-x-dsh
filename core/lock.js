import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const LOCK_NAME = ".memory.lock";
/** 锁文件超过该年龄视为残留（写进程已崩溃），允许接管 */
const STALE_MS = 30_000;
/** 获取锁的总等待时长 */
const WAIT_MS = 2_000;
const RETRY_MS = 50;

/**
 * 目录级互斥锁（零依赖，O_EXCL 实现）：
 * 覆盖"pi 写入时用户恰好在编辑器保存"的窗口。崩溃残留锁按 STALE_MS 接管。
 */
export async function withDirLock   (dir        , fn                  )             {
  const lockPath = join(dir, LOCK_NAME);
  const deadline = Date.now() + WAIT_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await tryAcquire(lockPath)) break;
    // 残留检测：超龄则删除后重试一次
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > STALE_MS) {
        await unlink(lockPath);
        continue;
      }
    } catch {
      // 锁刚好被释放，直接重试
    }
    if (Date.now() > deadline) {
      throw new Error(`获取记忆文件锁超时（${LOCK_NAME} 被占用超过 ${WAIT_MS}ms）`);
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function tryAcquire(lockPath        )                   {
  try {
    const fh = await open(lockPath, "wx");
    try {
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } finally {
      await fh.close();
    }
    return true;
  } catch (e) {
    if ((e                         ).code === "EEXIST") return false;
    throw e;
  }
}
