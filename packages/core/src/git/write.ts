// 書き込みの 1 単位（SY-2・SY-3・DT-4）：取り込み → 変更 → 検証 → コミット →（auto なら）push。
// push が拒否されたら取り込み直して再送する。CAS（作成・claim）は自分のコミットを捨てて変更からやり直す

import { OperationError } from "../errors.js";
import type { Config } from "../model/config.js";
import type { Store } from "../storage/store.js";
import { withLock } from "./lock.js";
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
  /** commit.mode によらず即座にコミットして push する（作成・claim） */
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

export interface WriteResult<T> {
  value: T;
  write: WriteOutcome;
}

const BATCH_MESSAGE = "変更をまとめてコミット";

/** 未コミットの変更を 1 コミットにする（commit.mode batch / manual の `dg commit`）。コミットしたら true */
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
  return withLock(ctx.repo.localDir, "write", () => writeLocked(ctx, mutate, opts));
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
    // batch / manual：作業ツリーに残す。取り込みは次の sync か即時の操作が行う
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
              "リモートの変更と競合しているので取得できない。dg sync で解消する",
              detail,
            );
          warnings.push(`リモートの変更と競合している。ローカルのコミットを残す（${detail}）`);
        }
        if (integrated.ok && integrated.changed) await ctx.store.rescan();
      }
    }

    const before = await headSha(repo);
    const value = await mutate();
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
      // 自分のコミットを捨て、最新の状態で変更からやり直す（採番し直し・claim の判定し直し）
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
      warnings.push(
        `リモートの変更と競合しているので push できない。dg sync で解消する（${integrated.conflicts.join(", ")}）`,
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
