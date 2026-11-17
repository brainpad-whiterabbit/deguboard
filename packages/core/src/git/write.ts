// 書き込みの 1 単位（SY-2・SY-3・DT-4）：取り込み → 変更 → 検証 → コミット →（auto なら）push。
// push が拒否されたら取り込み直して再送する（取り込み直しが例外で止まるときは、自分のコミットだけを捨てる）。CAS（作成・claim・Iteration の開始と再開）は自分のコミットを捨てて変更からやり直し、
// 届かなければ自分のコミットを捨てて失敗する（チケットの起票だけは仮番号でローカルに残す）

import { OperationError } from "../errors.js";
import { dataTargetOf, type Config, type DataTarget } from "../model/config.js";
import type { Store } from "../storage/store.js";
import { withLock } from "./lock.js";
import {
  inspectOutsideLocked,
  outsideError,
  recordBaseline,
  type WorktreeState,
} from "./outside.js";
import { settleRebase } from "./rebase.js";
import { retireProjects } from "./retire-projects.js";
import {
  dataRemoteMissingError,
  missingDataRemote,
  requireIdentity,
  type GitRepo,
} from "./repo.js";
import {
  amendAll,
  commitAll,
  describeAutoResolved,
  dropRebasedTip,
  fetchData,
  headSha,
  integrateLogged,
  isDirty,
  push,
  type ResolvedFile,
  resetHard,
} from "./sync.js";

/**
 * 同期の競合の戻し方（SY-4・dg guide overview の「When sync stops」）。
 * 競合のどちらの値を残すかは人が決める（--auto でも自動で選ばない）ので、競合したフィールドがあるときの書き込みの失敗・警告と
 * sync の警告はこの文言で、人に remote か local を選んでもらい dg sync --resolve を 1 回呼ぶ手順を案内する
 * （競合したフィールドのない sync の警告は UNRESOLVABLE_REMEDY を添える）
 */
export const CONFLICT_REMEDY =
  'Do not choose yourself. Show each conflicted field with its local and remote values (data.conflict_fields of dg sync) and ask the human, as a choice, whether to take remote (the remote values) or local (the local values), then call dg sync --resolve <remote|local> once with the chosen side (only the conflicted fields take that side\'s value, and the taken and discarded values are returned in data.resolved. It is not chosen automatically even with --auto. See "When sync stops" in dg guide overview)';

/** dg sync --resolve でも解けない競合（マージドライバの対象でないファイル）の戻し方。行単位の競合なので人が解く */
export const UNRESOLVABLE_REMEDY =
  'Do not resolve it yourself; tell the human. The human starts git rebase <remote>/deguboard in the deguboard worktree, resolves the file, continues with git rebase --continue, makes the current state the baseline with dg adopt, and runs dg sync (see "When sync stops" in dg guide overview)';

/**
 * 取り込みでドライバが自動で解いたフィールド（同じ status の時刻。SY-4）の警告。書き込みの取り込みも sync と同じに報告する。
 * 捨てた時刻が見えないまま消えないように、書き込みの結果の警告に載せる（data.resolved は書き込みの結果にはない）
 */
function autoResolvedWarnings(resolved: readonly ResolvedFile[]): string[] {
  const text = describeAutoResolved(resolved, false);
  return text ? [text] : [];
}

/**
 * push の要る操作の入口で呼ぶ。config が名指ししたデータのリモート（git.data_remote）がこのクローンになければ、
 * オフライン（SY-6）とみなして手元にだけ書かずに、エラーで足し方を案内する（データが別のリポジトリにあるのに、手元だけが進むのを防ぐ）
 */
export function requireDataRemote(ctx: Pick<WriteContext, "repo" | "config">): void {
  const missing = missingDataRemote(ctx.repo, ctx.config);
  if (missing) throw dataRemoteMissingError(missing);
}

/**
 * 取り込みの後（store を読み直した後）、push の前に呼ぶ。取り込んだ config でデータのリモートかデータのブランチ名が、このコマンドが
 * 使っているものから変わっていたら、push せずに止めてもう一度の実行を案内する（データを別のリポジトリ・別のブランチへ移す途中。
 * 元の置き場所へ push すると、移した先に届かず取りこぼす）。このコマンドの変更は書かない（push が拒否された後の取り込み直しで見つけたときは、呼び出し側が
 * 自分のコミットを捨てる）ので、もう一度の実行で二重にならない。前からある手元のコミットは残り、次の実行が新しいリモートから取り込んで送る。
 * before は取り込む前の config のデータの置き場所（dataTargetOf）。取り込みで変わったときだけ止めるので、
 * このコマンド自身が変えた値（dg config set git.data_remote・git.data_branch。元の置き場所へ push して知らせる）では止めない
 */
export function stopIfDataRemoteChanged(
  ctx: Pick<WriteContext, "repo" | "store">,
  before: DataTarget,
): void {
  const used = ctx.repo.dataRemote;
  if (used === null) return;
  const now = dataTargetOf(ctx.store.config);
  const remoteMoved = now.remote !== before.remote && now.remote !== used;
  const branchMoved = now.branch !== before.branch && now.branch !== ctx.repo.dataBranch;
  if (!remoteMoved && !branchMoved) return;
  const from = `${used}/${ctx.repo.dataBranch}`;
  const to = `${remoteMoved ? now.remote : used}/${branchMoved ? now.branch : ctx.repo.dataBranch}`;
  const moved = remoteMoved
    ? branchMoved
      ? "the data remote and the data branch"
      : "the data remote"
    : "the data branch";
  throw new OperationError(
    "DATA_REMOTE_CHANGED",
    `The config just fetched from ${from} changed ${moved} to ${to} (the data is moving), so nothing was pushed to ${from}. Run the command again: it fetches from and pushes to ${to}. Local commits are kept and are sent then`,
  );
}

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
  /** push の成功をもって取得とする。拒否されたらコミットを捨てて変更からやり直し、届かなければコミットを捨てて失敗する（markProvisional がなければ） */
  cas?: boolean;
  /** push 先に届かないとき、失敗にせず、作成した対象に provisional を付けてローカルに残す（DT-5。チケットの起票だけ） */
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

const BATCH_MESSAGE = "Commit batched changes";

/**
 * 未コミットの変更を 1 コミットにする。`dg commit`・`dg sync`・即時の操作（作成・claim・Iteration の開始と再開）の直前に呼ばれる。コミットしたら true。
 * known.dirty は、呼び出し側が同じ書き込みのロックの中で読み、その後に作業ツリーを変えていない「未コミットの変更があるか」
 * （渡されれば status を聞き直さない。t1075）
 */
export async function flushPending(
  ctx: WriteContext,
  message = BATCH_MESSAGE,
  known: { dirty?: boolean } = {},
): Promise<boolean> {
  if (!(known.dirty ?? (await isDirty(ctx.repo)))) return false;
  await requireIdentity(ctx.repo);
  return commitAll(ctx.repo, message);
}

export async function withWrite<T>(
  ctx: WriteContext,
  mutate: () => Promise<T>,
  opts: WriteOptions<T>,
): Promise<WriteResult<T>> {
  return withWriteLock(ctx.repo, (entry) => writeLocked(ctx, mutate, opts, entry));
}

/**
 * データのリポジトリに書く処理を、同じマシンの書き込みのロックの中で行う（SY-5・SY-7）。書く前にロックの中で dg の外の変更を確かめ、
 * あれば書かずに OUTSIDE_CHANGES を投げる（外の変更を dg のコミットに入れて隠さない。止めない dg hook も、この失敗を警告にする。
 * そのとき閉じ損ねた Run は、取り込むか捨てた後に the "Stopped Run" section of `dg guide run` で閉じる）。
 * ロックを放す前に、書いた後の状態を基準に記録する。ロックを持つ間に dg の外で書いた変更は、記録し直す経路ではこの記録で基準に入り、
 * 見つからないことがある（窓はロックを持つ間だけなので受け入れる）。fn が何も変えなかったとき（何もしない取り込み）は記録し直さないので、
 * その間の外の変更は基準に入らず、次のコマンドが見つける。
 * fn には、外の変更を確かめたときに読んだ状態（LockEntry）を渡す。同じ git の問い合わせを繰り返さないために使う（t1046）
 */
export async function withWriteLock<T>(
  repo: GitRepo,
  fn: (entry: LockEntry) => Promise<T>,
): Promise<T> {
  return withLock(repo.localDir, "write", async () => {
    // 途中の rebase は外の変更と比べる前に片付ける（dg の残りは取り消し、人が始めたものは止める。t753）
    await settleRebase(repo);
    // 入口（runCommand）もロックの外で同じことを確かめているが、ロックを待つ間にほかの dg が書きうるので、ここで読み直す
    const before = await inspectOutsideLocked(repo);
    if (before.check.kind === "found") throw outsideError(before.check.changes);
    const entry: LockEntry = { state: before.state, untouched: false, headKept: false };
    try {
      return await fn(entry);
    } finally {
      // fn が何も変えず、基準が入口の状態と同じ中身なら、記録し直しても同じ中身なので読み直さない。
      // ほかは、fn の書き込みで HEAD と作業ツリーが変わりうるので、放す前に読み直して記録する。
      // fn が HEAD を動かさなかった（まとめ待ちに残す書き込み）なら、HEAD は入口で読んだものを使い、作業ツリーの変更だけを読み直す
      if (!(entry.untouched && before.recorded)) {
        const head = entry.headKept ? before.state?.head : undefined;
        await recordBaseline(repo, head === undefined ? {} : { head }).catch(() => undefined);
      }
    }
  });
}

/** 書き込みのロックの中の処理（withWriteLock の fn）に渡す、ロックを取った直後の状態 */
export interface LockEntry {
  /**
   * 外の変更を確かめたときに読んだ HEAD と作業ツリーの変更。ロックを持つ間はほかの dg が書かないので、fn が HEAD か作業ツリーを
   * 変える（ファイルを書く・コミットする・rebase や reset をする）まで正しい。変えた後は使わずに読み直す。読まなかったときは undefined
   */
  readonly state: WorktreeState | undefined;
  /**
   * fn が HEAD も作業ツリーも変えなかったと言い切れるときだけ、fn が true にする（変えたかもしれないときは false のままにする。
   * 変えたのに true にすると、dg 自身の書き込みが基準に入らず、次のコマンドが dg の外の変更として止まる）
   */
  untouched: boolean;
  /**
   * fn が HEAD を動かさなかった（コミット・rebase・reset をしなかった）と言い切れるときだけ、fn が true にする。作業ツリーは変えていてよい
   * （まとめ待ちに残す書き込み）。true なら、放す前の基準の記録は rev-parse を聞き直さずに state の HEAD を使う（t1075）
   */
  headKept: boolean;
}

/**
 * push が拒否された後の取り込み直しが例外で止まったときに、このコマンドのコミット（mine）だけを手元から捨てる。
 * 取り込んだリモートのコミットと、前からある手元のコミット（before 以前）は残す。
 * 先頭が mine のまま（rebase が始まらなかったか、中止して戻ったか、積み直すものがなかった）なら、変更の前（before）へ戻す。
 * rebase で積み直した後なら SHA が変わっているので、dropRebasedTip が積み直した自分のコミットを見分けて捨てる
 */
async function dropOwnCommit(
  ctx: Pick<WriteContext, "repo" | "store">,
  before: string,
  mine: string,
): Promise<void> {
  // 先頭は読み直す：mine を読んだ後に、取り込み直しの rebase（成功・中止・途中で止まる）が先頭を動かしうる
  if ((await headSha(ctx.repo)) === mine) await resetHard(ctx.repo, before);
  else if (!(await dropRebasedTip(ctx.repo, mine))) return;
  await ctx.store.rescan();
}

async function writeLocked<T>(
  ctx: WriteContext,
  mutate: () => Promise<T>,
  opts: WriteOptions<T>,
  entry: LockEntry,
): Promise<WriteResult<T>> {
  const { repo, config } = ctx;
  const warnings: string[] = [];
  const shouldCommit = opts.immediate === true || config.commit.mode === "each";
  // push する操作は、名指ししたデータのリモートがなければ書く前に止める（リモートを名指ししていなければ、今までどおり手元に書く）
  if (shouldCommit && (opts.immediate === true || config.push.mode === "auto"))
    requireDataRemote(ctx);
  const shouldPush =
    shouldCommit &&
    repo.dataRemote !== null &&
    (opts.immediate === true || config.push.mode === "auto");
  const maxAttempts = opts.maxAttempts ?? 3;

  // やめた Project の残り（projects/）は、書く前に印付きのコミットで一度だけ消す（retire-projects.ts）
  const retired = await retireProjects(repo, ctx.store);
  // ロックの入口で読んだ HEAD と作業ツリーの変更（LockEntry の state）。消したとき（コミットした）は使わない。
  // 下で HEAD か作業ツリーを変えるたびに、変わった方を捨てて、その後は git に聞き直す（t1075）
  const known = retired ? undefined : entry.state;

  if (!shouldCommit) {
    // batch / manual：作業ツリーに残す。コミットは dg commit・dg sync・即時の操作が行う。
    // mutate はファイルを書くだけで HEAD を動かさない（途中で例外になっても同じ）ので、放す前の基準の記録は入口で読んだ HEAD を使う
    entry.headKept = known !== undefined;
    const value = await mutate();
    return {
      value,
      write: { committed: false, pushed: false, provisional: false, attempts: 1, warnings },
    };
  }

  await requireIdentity(repo);
  // 即時の操作は、まとめ待ちの変更を先にコミットして作業ツリーを空にする。
  // 入口で読んだ dirtyFiles の件数は、isDirty と同じ答えになる（どちらも追跡しないファイルを git の設定によらず数える。sync.ts の isDirty）
  const flushed = await flushPending(
    ctx,
    undefined,
    known ? { dirty: Object.keys(known.dirty).length > 0 } : {},
  );
  if (flushed) warnings.push("Committed the pending changes first");

  // 分かっている今の HEAD。HEAD を動かしたら（まとめ待ちのコミット・取り込み・自分のコミット・reset）undefined にし、
  // 要るときに rev-parse HEAD で読み直す。push が拒否された後のやり直しと取り込み直しは、自分のコミットの後なのでいつも読み直す
  let head = flushed ? undefined : known?.head;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    // この回の fetch の後に、取り込み（rebase）が読んだ HEAD。rebase を始めなかったとき・fetch に失敗したときは undefined
    let rebased: string | undefined;
    if (repo.dataRemote) {
      const fetched = await fetchData(repo);
      if (!fetched.ok) {
        warnings.push(`Cannot fetch from the remote: ${fetched.detail}`);
      } else if (fetched.remoteBranch) {
        const nameBefore = dataTargetOf(ctx.store.config);
        const { result: integrated, resolved } = await integrateLogged(
          repo,
          head === undefined ? {} : { known: { head } },
        );
        // 取り込みが rebase の後に読んだ HEAD を使う。rebase を始めなかったとき（head がない）は動いていないので、そのまま。
        // 競合で中止したときは、中止できずに途中の状態が残ることがあるので、読み直す
        head = integrated.ok ? (integrated.head ?? head) : undefined;
        rebased = integrated.ok ? integrated.head : undefined;
        warnings.push(...autoResolvedWarnings(resolved));
        if (!integrated.ok) {
          const detail = `Conflicts: ${integrated.conflicts.join(", ")}`;
          if (opts.cas)
            throw new OperationError(
              "SYNC_CONFLICT",
              `Conflicts with remote changes, so the change cannot be applied. ${CONFLICT_REMEDY}`,
              detail,
            );
          warnings.push(
            `Conflicts with remote changes. The local commit is kept (${detail}). ${CONFLICT_REMEDY}`,
          );
        }
        if (integrated.ok && integrated.changed) {
          await ctx.store.rescan();
          stopIfDataRemoteChanged(ctx, nameBefore);
        }
      }
    }

    // 変更の前の先頭。上の取り込み（rebase）とまとめ待ちのコミット、やり直しの前の reset が先頭を動かしうるので、
    // 動かした後に読んだ値（取り込みが返した HEAD）か、どれも動かさなかったときの入口の値だけを使い、なければここで読み直す。
    // push する操作は、失敗したときに before へ reset しうる（下の resetHard と dropOwnCommit）。入口の値は fetch の前に読んだもので、
    // fetch の間に dg の外で積まれたコミットを reset が消すので、使わない：fetch の後に読んだ値（rebased）がなければ読み直す。
    // push しない操作は before へ戻さないので、入口の値でよい
    const before = (shouldPush ? rebased : head) ?? (await headSha(repo));
    // この後の mutate とコミットが先頭を動かす
    head = undefined;
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
      if (opts.cas && !opts.markProvisional) {
        // CAS は push の成功で取得とする。届かなければ取れたか分からないので、自分のコミットを捨てて失敗にする（SY-3）。
        // ローカルに残すと、オフラインの 2 台が同じチケットを claim でき、別々に start すると active が 2 つになる（IT-1）。
        // Epic・Iteration・Plan の作成は仮番号を付けないので、残すと番号の衝突を dg sync で振り直せない（DT-5）
        // 先にコミットしたまとめ待ちの変更は before より前にあるので残る。throw で警告が落ちるので、その旨をメッセージに含める
        await resetHard(repo, before);
        await ctx.store.rescan();
        const kept = flushed
          ? " The pending changes committed before it stay locally, and the next dg sync sends them."
          : "";
        throw new OperationError(
          "PUSH_FAILED",
          `Cannot reach the remote, so your change was not applied and its commit was discarded.${kept} Retry the same operation when the remote is reachable`,
          pushed.detail,
        );
      }
      let provisional = false;
      if (opts.markProvisional) {
        await opts.markProvisional(value);
        await amendAll(repo);
        provisional = true;
      }
      warnings.push(
        `Cannot push, so the commit is kept locally. The next dg sync sends it again (${pushed.detail})`,
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
          `The push was rejected ${attempts} times, so the change could not be applied`,
          pushed.detail,
        );
      }
      continue;
    }
    if (attempts >= maxAttempts) {
      warnings.push(
        `The push was rejected ${attempts} times. The commit is kept locally and the next dg sync sends it again`,
      );
      return {
        value,
        write: { committed: true, pushed: false, provisional: false, attempts, warnings },
      };
    }
    // 自分のコミットは残したまま rebase して再 push する。
    // ここから push の前までに例外で止まるときは、エラーの種類によらず、自分のコミットだけを捨ててから投げ直す（dropOwnCommit）。
    // 残すと、エラーを直した後のもう一度の実行が同じ変更（コメントの追記など）を二重に入れる。エラーを足すときに、
    // 種類ごとの戻しを書かなくて済むよう、この 1 か所で受ける。競合は例外ではなく、警告を付けてコミットを残す（SY-4）
    const nameBefore = dataTargetOf(ctx.store.config);
    // before を読んだ後に自分のコミットを積んだので、先頭を読み直す
    const mine = await headSha(repo);
    try {
      const fetchedAgain = await fetchData(repo);
      const { result: integrated, resolved } =
        fetchedAgain.ok && fetchedAgain.remoteBranch
          ? await integrateLogged(repo)
          : { result: { ok: true as const, changed: false }, resolved: [] as ResolvedFile[] };
      warnings.push(...autoResolvedWarnings(resolved));
      if (!integrated.ok) {
        // 取り込みの警告が既に戻し方を案内していれば繰り返さない
        const remedy = warnings.some((w) => w.includes(CONFLICT_REMEDY))
          ? ""
          : `. ${CONFLICT_REMEDY}`;
        warnings.push(
          `Conflicts with remote changes, so it cannot push (${integrated.conflicts.join(", ")})${remedy}`,
        );
        return {
          value,
          write: { committed: true, pushed: false, provisional: false, attempts, warnings },
        };
      }
      await ctx.store.rescan();
      stopIfDataRemoteChanged(ctx, nameBefore);
      await ctx.hooks?.beforePush?.();
    } catch (e) {
      // 戻しが失敗しても、止まった理由（元のエラー）を投げる
      await dropOwnCommit(ctx, before, mine).catch(() => undefined);
      throw e;
    }
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
      `Could not push. The commit is kept locally and the next dg sync sends it again (${again.detail})`,
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
