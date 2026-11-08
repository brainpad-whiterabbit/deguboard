// 同一マシン内の書き込みの排他（server と CLI が同時に commit して index.lock で壊れないように）。
// チーム間の排他には使わない（それは claim の push。ADR-004）
//
// 持ち主はロックを持つ間、mtime を STALE_MS の 1/4 ごとに更新し続ける（ハートビート）。
// mtime が STALE_MS より古いロックは、持ち主が落ちたか止まったものとして奪う。
// 中身は「pid ホスト名」。同じホストの持ち主は pid でも生死を確かめ、死んでいれば mtime を待たずに奪う。
// 別のホストの pid はこのホストでは意味を持たないので、mtime だけで判定する

import type { Stats } from "node:fs";
import { type FileHandle, open, readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OperationError } from "../errors.js";

const STALE_MS = 60_000;
const WAIT_MS = 10_000;

/** 待ち時間と古いと判定するまでの時間の上書き（テスト用） */
export interface LockOptions {
  waitMs?: number;
  staleMs?: number;
}

export async function withLock<T>(
  localDir: string,
  name: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = path.join(localDir, "locks", name);
  const staleMs = options.staleMs ?? STALE_MS;
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  let lastError: unknown;
  let handle: FileHandle;
  let mine: Stats;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid} ${os.hostname()}`);
        mine = await handle.stat();
      } catch (error) {
        await handle.close();
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const state = await lockState(lockPath, staleMs);
      // 持ち主が解放した後なら消さずに取り直す。消すと、その間に別の待ち手が取り直したロックを消してしまう
      if (state.kind === "gone") continue;
      const broke = state.kind === "stale" && (await breakStale(lockPath, state.stats, staleMs));
      if (state.kind === "error") lastError = state.error;
      // 古いロックを消せないときや stat が失敗し続けるときも、待ち時間の上限で止める
      if (Date.now() > deadline) {
        const detail = lastError instanceof Error ? `。${lastError.message}` : "";
        throw new OperationError(
          "GIT_ERROR",
          `別の dg が書き込み中（${lockPath}）。残っていれば消す（${lockPath}.break も）${detail}`,
        );
      }
      if (!broke) await sleep(50);
    }
  }
  // ハートビート。開いたままのハンドルで更新するので、消されて別の待ち手が取り直したロックには触れない
  let beat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    beat = beat
      .then(async () => {
        const now = new Date();
        await handle.utimes(now, now);
        mine = await handle.stat();
      })
      .catch(() => undefined);
  }, staleMs / 4);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await beat;
    await handle.close().catch(() => undefined);
    // 自分のロックが古いと判定されて消され、別の待ち手が取り直していれば、そのロックは消さない
    const current = await stat(lockPath).catch(() => undefined);
    if (current && sameFile(current, mine)) await unlink(lockPath).catch(() => undefined);
  }
}

type LockState =
  | { kind: "held" }
  | { kind: "stale"; stats: Stats }
  | { kind: "gone" }
  | { kind: "error"; error: unknown };

/**
 * 生きた持ち主がロックを持っているか（取らずに見る。dg の外の変更の検査が、ほかの dg の書きかけを避けるのに使う）。
 * 古いロック（mtime が古い・同じホストの持ち主の pid が死んだ）は持たないとみなす。確かめられなければ持っているとみなす
 */
export async function lockHeld(localDir: string, name: string): Promise<boolean> {
  const state = await lockState(path.join(localDir, "locks", name), STALE_MS);
  return state.kind === "held" || state.kind === "error";
}

/**
 * ロックの状態。持ち主が使っていれば held、古ければ stale、解放されてもう無ければ gone、確かめられなければ error。
 * mtime が staleMs より古ければ stale（持ち主はハートビートで更新し続けるので、生きていれば古くならない）。
 * 同じホストの持ち主は pid の生死も見る。ホスト名の無い中身は以前の dg が書いたもので、同じホストとみなす
 */
async function lockState(lockPath: string, staleMs: number): Promise<LockState> {
  let stats: Stats;
  let content: string;
  try {
    stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs > staleMs) return { kind: "stale", stats };
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
    return { kind: "error", error };
  }
  const [pidText = "", host] = content.trim().split(/\s+/, 2);
  const pid = Number(pidText);
  if (host !== undefined && host !== os.hostname()) return { kind: "held" };
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      // ESRCH だけがプロセスのいない印。EPERM は他ユーザの生きたプロセス
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { kind: "stale", stats };
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
 * 実際に消せたときだけ true を返す（印を取れない・ファイルが替わった・消せないときは false）
 */
async function breakStale(lockPath: string, judged: Stats, staleMs: number): Promise<boolean> {
  const breakPath = `${lockPath}.break`;
  try {
    await (await open(breakPath, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    // 消す役が途中で落ちて残った印は、古ければ消す
    const s = await stat(breakPath).catch(() => undefined);
    if (s && Date.now() - s.mtimeMs > staleMs) await unlink(breakPath).catch(() => undefined);
    return false;
  }
  try {
    const current = await stat(lockPath).catch(() => undefined);
    if (!current || !sameFile(current, judged)) return false;
    return await unlink(lockPath).then(
      () => true,
      () => false,
    );
  } finally {
    await unlink(breakPath).catch(() => undefined);
  }
}
