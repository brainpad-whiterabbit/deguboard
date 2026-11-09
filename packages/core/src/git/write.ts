// 書き込みの 1 単位（SY-2・SY-3・DT-4）：取り込み → 変更 → 検証 → コミット →（auto なら）push。
// push が拒否されたら取り込み直して再送する。CAS（作成・claim・Iteration の開始と再開）は自分のコミットを捨てて変更からやり直す

import { OperationError } from "../errors.js";
import type { Config } from "../model/config.js";
import type { Store } from "../storage/store.js";
import { withLock } from "./lock.js";
import { checkOutside, outsideError, recordBaseline } from "./outside.js";
import { requireIdentity, type GitRepo } from "./repo.js";
import {
  amendAll,
  commitAll,
  fetchData,
  headSha,
  integrate,
  isDirty,
  push,
  resetHard,
} from "./sync.js";

/**
 * 同期の競合の戻し方（SY-4・dg guide overview の「同期が止まったとき」）。
 * 競合のどちらの値を残すかは人が決める（--auto でも自動で選ばない）ので、書き込みの失敗・警告と sync の警告はどれもこの文言で、
 * 人に remote か local を選んでもらい dg sync --resolve を 1 回呼ぶ手順を案内する
 */
export const CONFLICT_REMEDY =
  "自分では選ばず、競合したファイルを示して人に remote（リモートの値を採る）か local（ローカルの値を採る）かを選択肢で聞き、選ばれた側で dg sync --resolve <remote|local> を 1 回呼ぶ（競合したフィールドだけその側の値を採り、採った値と捨てた値を data.resolved に返す。--auto でも自動で選ばない。dg guide overview の「同期が止まったとき」）";

/** dg sync --resolve でも解けない競合（マージドライバの対象でないファイル）の戻し方。行単位の競合なので人が解く */
export const UNRESOLVABLE_REMEDY =
  "自分では解かず人に伝える。人が deguboard worktree で git rebase <remote>/deguboard を始めてそのファイルを解き、git rebase --continue で続けてから dg adopt で今の状態を基準にし、dg sync を回す（dg guide overview の「同期が止まったとき」）";

export interface WriteContext {
  repo: GitRepo;
  store: Store;
  config: Config;
  /** テストが push の直前に割り込むためのフック */
  hooks?: { beforePush?: () => Promise<void> } | undefined;
}

export interface WriteOptions<T> {
  /** コミットメッセージ。1 行目に要約 */
  message: string | ((value: T) => string);
  /** commit.mode によらず即座にコミットして push する（作成・claim・Iteration の開始と再開） */
  immediate?: boolean;
  /** push の成功をもって取得とする。拒否されたらコミットを捨てて変更からやり直す */
  cas?: boolean;
  /** push 先に届かないとき、作成した対象に provisional を付ける（DT-5） */
  markProvisional?: (value: T) => Promise<void>;
  maxAttempts?: number;
}

export interface WriteOutcome {
  committed: boolean;
  pushed: boolean;
  provisional: boolean;
  attempts: number;
  warnings: string[];
}

/**
 * 書き込みを捨てて抜けるための例外の基底。mutate が投げると、writeLocked は何も書かずに取り込みの警告を載せて投げ直す
 * （ticket claim がもう一度の claim と分かったときなど。書くものがないが、取り込みの警告は呼び出し側が返す）
 */
export class AbortWrite extends Error {
  readonly warnings: string[] = [];
}

export interface WriteResult<T> {
  value: T;
  write: WriteOutcome;
}

const BATCH_MESSAGE = "変更をまとめてコミット";

/** 未コミットの変更を 1 コミットにする。`dg commit`・`dg sync`・即時の操作（作成・claim・Iteration の開始と再開）の直前に呼ばれる。コミットしたら true */
export async function flushPending(ctx: WriteContext, message = BATCH_MESSAGE): Promise<boolean> {
  if (!(await isDirty(ctx.repo))) return false;
  await requireIdentity(ctx.repo);
  return commitAll(ctx.repo, message);
}

export async function withWrite<T>(
  ctx: WriteContext,
  mutate: () => Promise<T>,
  opts: WriteOptions<T>,
): Promise<WriteResult<T>> {
  return withWriteLock(ctx.repo, () => writeLocked(ctx, mutate, opts));
}

/**
 * データのリポジトリに書く処理を、同じマシンの書き込みのロックの中で行う（SY-5・SY-7）。書く前にロックの中で dg の外の変更を確かめ、
 * あれば書かずに OUTSIDE_CHANGES を投げる（外の変更を dg のコミットに入れて隠さない。止めない dg hook も、この失敗を警告にする。
 * そのとき閉じ損ねた Run は、取り込むか捨てた後に dg guide run の「止まった Run」で閉じる）。
 * ロックを放す前に、書いた後の状態を基準に記録する。ロックを持つ間に dg の外で書いた変更はこの記録で基準に入り、見つからないことがある
 * （窓はロックを持つ間だけなので受け入れる）
 */
export async function withWriteLock<T>(repo: GitRepo, fn: () => Promise<T>): Promise<T> {
  return withLock(repo.localDir, "write", async () => {
    const before = await checkOutside(repo, { underLock: true });
    if (before.kind === "found") throw outsideError(before.changes);
    try {
      return await fn();
    } finally {
      await recordBaseline(repo).catch(() => undefined);
    }
  });
}

async function writeLocked<T>(
  ctx: WriteContext,
  mutate: () => Promise<T>,
  opts: WriteOptions<T>,
): Promise<WriteResult<T>> {
  const { repo, config } = ctx;
  const warnings: string[] = [];
  const shouldCommit = opts.immediate === true || config.commit.mode === "each";
  const shouldPush =
    shouldCommit &&
    repo.remote !== null &&
    (opts.immediate === true || config.push.mode === "auto");
  const maxAttempts = opts.maxAttempts ?? 3;

  if (!shouldCommit) {
    // batch / manual：作業ツリーに残す。コミットは dg commit・dg sync・即時の操作が行う
    const value = await mutate();
    return {
      value,
      write: { committed: false, pushed: false, provisional: false, attempts: 1, warnings },
    };
  }

  await requireIdentity(repo);
  // 即時の操作は、まとめ待ちの変更を先にコミットして作業ツリーを空にする
  if (await flushPending(ctx)) warnings.push("まとめ待ちの変更を先にコミットした");

  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (repo.remote) {
      const fetched = await fetchData(repo);
      if (!fetched.ok) {
        warnings.push(`リモートから取り込めない: ${fetched.detail}`);
      } else if (fetched.remoteBranch) {
        const integrated = await integrate(repo);
        if (!integrated.ok) {
          const detail = `競合: ${integrated.conflicts.join(", ")}`;
          if (opts.cas)
            throw new OperationError(
              "SYNC_CONFLICT",
              `リモートの変更と競合しているので取得できない。${CONFLICT_REMEDY}`,
              detail,
            );
          warnings.push(
            `リモートの変更と競合している。ローカルのコミットを残す（${detail}）。${CONFLICT_REMEDY}`,
          );
        }
        if (integrated.ok && integrated.changed) await ctx.store.rescan();
      }
    }

    const before = await headSha(repo);
    const value = await mutate().catch((e: unknown) => {
      if (e instanceof AbortWrite) e.warnings.push(...warnings);
      throw e;
    });
    const message = typeof opts.message === "function" ? opts.message(value) : opts.message;
    const committed = await commitAll(repo, message);
    if (!committed)
      return {
        value,
        write: { committed: false, pushed: false, provisional: false, attempts, warnings },
      };
    if (!shouldPush) {
      return {
        value,
        write: { committed: true, pushed: false, provisional: false, attempts, warnings },
      };
    }

    await ctx.hooks?.beforePush?.();
    const pushed = await push(repo);
    if (pushed.ok)
      return {
        value,
        write: { committed: true, pushed: true, provisional: false, attempts, warnings },
      };

    if (pushed.reason === "unreachable") {
      let provisional = false;
      if (opts.markProvisional) {
        await opts.markProvisional(value);
        await amendAll(repo);
        provisional = true;
      }
      warnings.push(
        `push できないのでコミットをローカルに残す。次の dg sync で再送する（${pushed.detail}）`,
      );
      return { value, write: { committed: true, pushed: false, provisional, attempts, warnings } };
    }

    // rejected：取り込み直して再送
    if (opts.cas) {
      // 自分のコミットを捨て、最新の状態で変更からやり直す（採番し直し・claim と Iteration の開始の判定し直し）
      await resetHard(repo, before);
      await ctx.store.rescan();
      if (attempts >= maxAttempts) {
        throw new OperationError(
          "PUSH_FAILED",
          `push が ${attempts} 回拒否されたので取得できなかった`,
          pushed.detail,
        );
      }
      continue;
    }
    if (attempts >= maxAttempts) {
      warnings.push(
        `push が ${attempts} 回拒否された。コミットをローカルに残し、次の dg sync で再送する`,
      );
      return {
        value,
        write: { committed: true, pushed: false, provisional: false, attempts, warnings },
      };
    }
    // 自分のコミットは残したまま次の周回で rebase して再 push する
    const integrated = await fetchData(repo).then((f) =>
      f.ok && f.remoteBranch ? integrate(repo) : { ok: true as const, changed: false },
    );
    if (!integrated.ok) {
      // 取り込みの警告が既に戻し方を案内していれば繰り返さない
      const remedy = warnings.some((w) => w.includes(CONFLICT_REMEDY))
        ? ""
        : `。${CONFLICT_REMEDY}`;
      warnings.push(
        `リモートの変更と競合しているので push できない（${integrated.conflicts.join(", ")}）${remedy}`,
      );
      return {
        value,
        write: { committed: true, pushed: false, provisional: false, attempts, warnings },
      };
    }
    await ctx.store.rescan();
    await ctx.hooks?.beforePush?.();
    const again = await push(repo);
    if (again.ok)
      return {
        value,
        write: {
          committed: true,
          pushed: true,
          provisional: false,
          attempts: attempts + 1,
          warnings,
        },
      };
    warnings.push(
      `push できなかった。コミットをローカルに残し、次の dg sync で再送する（${again.detail}）`,
    );
    return {
      value,
      write: {
        committed: true,
        pushed: false,
        provisional: false,
        attempts: attempts + 1,
        warnings,
      },
    };
  }
}
