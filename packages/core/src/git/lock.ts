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
      const state = await lockState(lockPath);
      // 持ち主が解放した後なら消さずに取り直す。消すと、その間に別の待ち手が取り直したロックを消してしまう
      if (state === "gone") continue;
      if (state === "stale") {
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

/** ロックの状態。持ち主が使っていれば held、古ければ stale、解放されてもう無ければ gone */
async function lockState(lockPath: string): Promise<"held" | "stale" | "gone"> {
  try {
    const s = await stat(lockPath);
    if (Date.now() - s.mtimeMs > STALE_MS) return "stale";
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return "held";
      } catch {
        return "stale"; // そのプロセスはもういない
      }
    }
    return "held";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    return "stale";
  }
}
