// 同一マシン内の書き込みの排他（server と CLI が同時に commit して index.lock で壊れないように）。
// チーム間の排他には使わない（それは claim の push。ADR-004）

import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OperationError } from "../errors.js";

const STALE_MS = 60_000;
const WAIT_MS = 10_000;

export async function withLock<T>(
  localDir: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(localDir, "locks", name);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new OperationError(
          "GIT_ERROR",
          `別の dg が書き込み中（${lockPath}）。残っていれば消す`,
        );
      }
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const s = await stat(lockPath);
    if (Date.now() - s.mtimeMs > STALE_MS) return true;
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true; // そのプロセスはもういない
      }
    }
    return false;
  } catch {
    return true;
  }
}
