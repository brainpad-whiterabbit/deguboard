// 同一マシン内の書き込みの排他（server と CLI が同時に commit して index.lock で壊れないように）。
// チーム間の排他には使わない（それは claim の push。ADR-004）

import type { Stats } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OperationError } from "../errors.js";

const STALE_MS = 60_000;
const WAIT_MS = 10_000;

/** 待ち時間の上書き（テスト用） */
export interface LockOptions {
  waitMs?: number;
}

export async function withLock<T>(
  localDir: string,
  name: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = path.join(localDir, "locks", name);
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  let lastError: unknown;
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
      if (state.kind === "gone") continue;
      const broke = state.kind === "stale" && (await breakStale(lockPath, state.stats));
      if (state.kind === "error") lastError = state.error;
      // 古いロックを消せないときや stat が失敗し続けるときも、待ち時間の上限で止める
      if (Date.now() > deadline) {
        const detail = lastError instanceof Error ? `。${lastError.message}` : "";
        throw new OperationError(
          "GIT_ERROR",
          `別の dg が書き込み中（${lockPath}）。残っていれば消す${detail}`,
        );
      }
      if (!broke) await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

type LockState =
  | { kind: "held" }
  | { kind: "stale"; stats: Stats }
  | { kind: "gone" }
  | { kind: "error"; error: unknown };

/** ロックの状態。持ち主が使っていれば held、古ければ stale、解放されてもう無ければ gone、確かめられなければ error */
async function lockState(lockPath: string): Promise<LockState> {
  let stats: Stats;
  let content: string;
  try {
    stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs > STALE_MS) return { kind: "stale", stats };
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
    return { kind: "error", error };
  }
  const pid = Number(content.trim());
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch {
      return { kind: "stale", stats }; // そのプロセスはもういない
    }
  }
  return { kind: "held" };
}

/** 2 つの stat が同じロックのファイルを指すか。inode は使い回されるので mtime も比べる */
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/**
 * 古いと判定したロックを消す。判定の後に別の待ち手が古いロックを消して取り直していることがあるので、
 * 消す役を「<名前>.break」の印で 1 つに絞り、その中で判定したファイルのままかを確かめ直してから消す。
 * 印を取れなければ（別の待ち手が消している最中なら）false を返す
 */
async function breakStale(lockPath: string, judged: Stats): Promise<boolean> {
  const breakPath = `${lockPath}.break`;
  try {
    await (await open(breakPath, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    // 消す役が途中で落ちて残った印は、古ければ消す
    const s = await stat(breakPath).catch(() => undefined);
    if (s && Date.now() - s.mtimeMs > STALE_MS) await unlink(breakPath).catch(() => undefined);
    return false;
  }
  try {
    const current = await stat(lockPath).catch(() => undefined);
    if (current && sameFile(current, judged)) await unlink(lockPath).catch(() => undefined);
    return true;
  } finally {
    await unlink(breakPath).catch(() => undefined);
  }
}
