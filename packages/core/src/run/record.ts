// Run の記録（requirements.md 5.9・RN-3・RN-6・SY-5・EX-2、ADR-029）。
//   - 実行中の Run は deguboard-local/runs/<id>.json に、runs/ と同じスキーマ（finished_at・result は null）で置く。Git には入れない
//   - finish で runs/<id>.json（完了時の集計）を書き、実行中の記録を消す。チケットの操作に付随して閉じるとき（RN-6）は
//     closeRun をその操作の書き込みの中で呼び、同じコミットに入れる
//   - 同じチケットと step の二重の start は、deguboard-local/locks/ のロックの中で実行中の記録を見て拒否する
//   - チケットの frontmatter には書き足さない。チケットの Run は Run の ticket から引く（書き足すと Run のたびにチケットが衝突する）
//   - 会話記録のパスは Run に書かず、deguboard-local/transcripts/<id>.json に置く（RN-3）。ホームのパスとユーザ名を含み、
//     別のマシンでは読めないので Git に入れない。閉じた後の run refresh も同じファイルから数えるので、Run を閉じても消さず、
//     終了の時刻（finished_at）から TRANSCRIPT_RETENTION_DAYS を過ぎたものと Run のない ID のものを run prune-transcripts が消す

import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { OperationError } from "../errors.js";
import { withLock } from "../git/lock.js";
import type { GitRepo } from "../git/repo.js";
import { withWrite, type WriteContext, type WriteOutcome } from "../git/write.js";
import { toIsoDateTime } from "../model/common.js";
import type { TicketId } from "../model/id.js";
import {
  emptyUsage,
  isRunId,
  newRunId,
  runSchema,
  type Run,
  type RunId,
  type RunResult,
  type ReviewFinding,
  type RunReview,
  type RunTools,
  type RunUsage,
} from "../model/run.js";
import { createDoc, readDoc, type Doc } from "../storage/documents.js";
import { writeFileAtomic } from "../storage/atomic.js";
import { pathExists } from "../storage/exists.js";
import type { Issue } from "../storage/issue.js";
import { DIRS, runPath, TRANSCRIPTS_DIR, transcriptPath } from "../storage/paths.js";
import type { Store } from "../storage/store.js";
import { latestRoundSince } from "./findings.js";

/**
 * 書く先の見直しの Run がまだないときに置く、保留の見直しの結果（deguboard-local/reviews/<ticket>.json。RN-9）。
 * 前景で起動した見直し役は、動いている間に Run がない（フックが終わった後に開いて閉じる）。フックが見直しの Run を閉じるとき、
 * その Run の開始より後に置いた結果を結び付けて消す。Git には入れない
 */
const REVIEWS_DIR = "reviews";

export interface PendingReview {
  review: RunReview;
  /** 置いた時刻（ISO） */
  at: string;
}

const pendingReviewPath = (repo: Pick<GitRepo, "localDir">, ticket: TicketId) =>
  path.join(repo.localDir, REVIEWS_DIR, `${ticket}.json`);

/** 保留の見直しの結果を置く（同じチケットの前の保留は置き換える） */
export async function putPendingReview(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  pending: PendingReview,
): Promise<void> {
  const file = pendingReviewPath(repo, ticket);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(pending)}\n`);
}

/**
 * 保留の見直しの結果を取り出して消す。since（Run の開始）より前に置いたものは前の回のものなので、使わずに消す。
 * 保留はチケットごとに 1 つで、同じチケットの前景の見直し役を並べて動かすことは扱わない
 */
export async function takePendingReview(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  since: string,
): Promise<RunReview | undefined> {
  const file = pendingReviewPath(repo, ticket);
  let pending: PendingReview;
  try {
    pending = JSON.parse(await readFile(file, "utf8")) as PendingReview;
  } catch {
    return undefined;
  }
  // 前の回の保留（Run の開始より前に置いたもの）は使わないので消す
  await unlink(file).catch(() => undefined);
  if (typeof pending?.at !== "string" || pending.at < since || !pending.review) return undefined;
  return pending.review;
}

/**
 * 見直しの指摘の一覧（run review-result）の置き場所：deguboard-local/review-findings/<ticket>.json。見直しの回ごとに 1 つ置き、回の順に並べる。
 * Git の Run には数と通ったか（review）だけを書き、一覧は書かない。理由：
 *   - 作業の記録として Git に写すのは数だけにする（MT-4）。品質ゲートと修正ループの回数（dg gate）も数だけで決まる（RN-9）
 *   - 一覧は指摘の文・パス・直し方の長い文で、回ごとに変わる。使うのは同じマシンの親が組む手直しの文と PR の本文だけ（t600）
 *   - 閉じた Run は書き換えない（RN-4）ので、前景の見直し役のように Run より先に結果が来る形では、Run に一覧を後から足せない
 *   - 回ごとに残すのは、PR の本文に 1 回目の軽い指摘も載せるため（手直しに渡さなかった軽い指摘は、次の回の一覧には出ない）
 */
const REVIEW_FINDINGS_DIR = "review-findings";

/** 見直しの 1 回分の記録。一覧なしの呼び方（数だけ）は findings を null にする */
export interface ReviewRound {
  /** 書いた見直しの Run。Run がまだなく保留にしたときは null */
  run: RunId | null;
  /** 置いた時刻（ISO） */
  at: string;
  review: RunReview;
  findings: ReviewFinding[] | null;
  /**
   * 親が手直しに渡した指摘（run handoff）。直さなかった軽い指摘の節から外し、手直しの文の直す指摘に入れる。
   * 呼び直すと置き換える。渡さなかった回は省く（読む側は空として扱う）
   */
  handed?: ReviewFinding[];
}

export interface StoredReviewFindings {
  ticket: TicketId;
  /** 見直しの回。置いた順（末尾が最新）。同じ Run の回は呼び直したとき置き換える */
  rounds: ReviewRound[];
}

const reviewFindingsPath = (repo: Pick<GitRepo, "localDir">, ticket: TicketId) =>
  path.join(repo.localDir, REVIEW_FINDINGS_DIR, `${ticket}.json`);

/** 見直しの 1 回分を置く。同じ Run の回があれば置き換え、なければ末尾に足す */
export async function putReviewRound(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  round: ReviewRound,
): Promise<void> {
  const rounds = (await readReviewFindings(repo, ticket))?.rounds ?? [];
  const same = round.run === null ? -1 : rounds.findIndex((r) => r.run === round.run);
  if (same >= 0) rounds[same] = round;
  else rounds.push(round);
  const file = reviewFindingsPath(repo, ticket);
  await mkdir(path.dirname(file), { recursive: true });
  const stored: StoredReviewFindings = { ticket, rounds };
  await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
}

/**
 * 作業ブランチ（since 以降）の最新の見直しの回（一覧のある回）に、親が手直しに渡した指摘を置く（t639）。呼び直すと置き換える。
 * 手直しに渡すのは見直しの一覧の指摘なので、その回がなければ false を返す（呼び出し側が使い方の誤りにする）。
 * 手直しの文と PR の本文は同じマシンの記録から読むので、ここに置けば dg が両方を決められる
 */
export async function setHandedFindings(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  since: string | undefined,
  handed: ReviewFinding[],
): Promise<boolean> {
  const stored = await readReviewFindings(repo, ticket);
  const round = stored && latestRoundSince(stored.rounds, since);
  if (!stored || !round) return false;
  round.handed = handed;
  const file = reviewFindingsPath(repo, ticket);
  await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
  return true;
}

/**
 * 見直しの Run に結果を書いた・保留の結果を結び付けたとき、その Run の開始（since）より後に置いた保留の回（run が null）を
 * その Run の回にまとめる（t638）。Run の回がまだなければ最新の保留の回をその Run の回にし、Run の回があればそれを残す
 * （Git の Run の数と同じ回）。ほかの保留の回は外す。保留の回を残すと同じ見直しが 2 回になり、dg pr ready が同じ指摘を 2 行書く（t637）
 */
export async function adoptPendingRounds(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  run: RunId,
  since: string,
): Promise<void> {
  const stored = await readReviewFindings(repo, ticket);
  if (!stored) return;
  const held = (r: ReviewRound) => r.run === null && r.at >= since;
  const latestHeld = stored.rounds.filter(held).at(-1);
  if (!latestHeld) return;
  const owned = stored.rounds.some((r) => r.run === run);
  const rounds = stored.rounds
    .filter((r) => !held(r) || (!owned && r === latestHeld))
    .map((r) => (r === latestHeld ? { ...r, run } : r));
  const next: StoredReviewFindings = { ticket, rounds };
  await writeFileAtomic(reviewFindingsPath(repo, ticket), `${JSON.stringify(next, null, 2)}\n`);
}

/** チケットの見直しの回。なければ（記録なし・別のマシン・読めない）undefined */
export async function readReviewFindings(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
): Promise<StoredReviewFindings | undefined> {
  try {
    const stored = JSON.parse(
      await readFile(reviewFindingsPath(repo, ticket), "utf8"),
    ) as StoredReviewFindings;
    return Array.isArray(stored?.rounds) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** start と finish の確かめと書き込みを直列にするロックの名前（deguboard-local/locks/runs） */
const RUN_LOCK = "runs";

type RunDirs = Pick<GitRepo, "localDir" | "dataDir">;

/**
 * 書き足す先の手直しの Run がまだないときに置く、保留のやり直しの理由（deguboard-local/retry-reasons/<ticket>.json。RN-8）。
 * 前景で起動した手直しのサブエージェントは、動いている間に Run がない（フックが終わった後に開いて閉じる）。フックが手直しの Run を
 * 閉じるとき、その Run の開始より後に置いた理由を結び付けて消す。呼ぶたびに書き足す。Git には入れない
 */
const RETRY_REASONS_DIR = "retry-reasons";
/** 保留のやり直しの理由の読み書きを直列にするロックの名前（Run のロックの中からも呼ぶので分ける） */
const RETRY_REASONS_LOCK = "retry-reasons";

async function withRetryReasonsLock<T>(repo: Pick<GitRepo, "localDir">, fn: () => Promise<T>) {
  await mkdir(path.join(repo.localDir, "locks"), { recursive: true });
  return withLock(repo.localDir, RETRY_REASONS_LOCK, fn);
}

interface PendingRetryReason {
  reason: string;
  /** 置いた時刻（ISO） */
  at: string;
}

const pendingRetryReasonsPath = (repo: Pick<GitRepo, "localDir">, ticket: TicketId) =>
  path.join(repo.localDir, RETRY_REASONS_DIR, `${ticket}.json`);

async function readPendingRetryReasons(file: string): Promise<PendingRetryReason[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PendingRetryReason =>
        typeof (p as PendingRetryReason | null)?.reason === "string" &&
        typeof (p as PendingRetryReason | null)?.at === "string",
    );
  } catch {
    return [];
  }
}

/** 保留のやり直しの理由を書き足す */
export async function putPendingRetryReasons(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  reasons: readonly string[],
  at: string,
): Promise<void> {
  await withRetryReasonsLock(repo, async () => {
    const file = pendingRetryReasonsPath(repo, ticket);
    const held = await readPendingRetryReasons(file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(
      file,
      `${JSON.stringify([...held, ...reasons.map((reason) => ({ reason, at }))])}\n`,
    );
  });
}

/**
 * 保留のやり直しの理由を取り出して消す。since（Run の開始）より前に置いたものは前の回のものなので、使わずに消す。
 * 保留はチケットごとで、同じチケットの前景の手直しを並べて動かすことは扱わない
 */
export async function takePendingRetryReasons(
  repo: Pick<GitRepo, "localDir">,
  ticket: TicketId,
  since: string,
): Promise<string[]> {
  return withRetryReasonsLock(repo, async () => {
    const file = pendingRetryReasonsPath(repo, ticket);
    const held = await readPendingRetryReasons(file);
    await unlink(file).catch(() => undefined);
    return held.filter((p) => p.at >= since).map((p) => p.reason);
  });
}

/**
 * 実行中の Run のやり直しの理由に書き足し、回数を理由の数にする（RN-8。run retry-reason と、フックの保留の結び付け）。
 * 実行中の記録がなければ NOT_FOUND、集計を書いた後なら REJECTED
 */
export async function appendRetryReasons(
  repo: RunDirs,
  id: RunId,
  reasons: readonly string[],
): Promise<Run> {
  return withRunLock(repo, async () => {
    if (await hasSummary(repo, id))
      throw new OperationError("REJECTED", `Run ${id} is already finished`);
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
    if (!result.ok) throw new OperationError("NOT_FOUND", `Running Run ${id} not found`);
    const retryReasons = [...result.doc.data.retry_reasons, ...reasons];
    const next = {
      ...result.doc.raw,
      retry_reasons: retryReasons,
      retries: retryReasons.length,
    };
    await writeFileAtomic(
      path.join(repo.localDir, runPath(id)),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return runSchema.parse(next);
  });
}

/** runs/ に集計があるか。索引は古いことがあるのでファイルで確かめる（batch でまだコミットしていない集計も含む） */
async function hasSummary(repo: RunDirs, id: string): Promise<boolean> {
  return pathExists(path.join(repo.dataDir, runPath(id)));
}

async function removeRunning(repo: RunDirs, id: string): Promise<void> {
  await unlink(path.join(repo.localDir, runPath(id))).catch(() => undefined);
}

/** deguboard-local/runs/ を読む。読めないファイルは issues に入れて飛ばす */
async function readLocalRuns(repo: RunDirs): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
  let files: string[] = [];
  try {
    files = (await readdir(path.join(repo.localDir, DIRS.runs))).sort();
  } catch {
    // まだ 1 つも start していない
  }
  const runs: Doc<Run>[] = [];
  const issues: Issue[] = [];
  for (const file of files) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!isRunId(id)) continue;
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
    if (result.ok) runs.push(result.doc);
    else issues.push(result.issue);
  }
  return { runs, issues };
}

/**
 * 終わっていない Run を読む。集計のコミットの後、実行中の記録を消す前に止まった finish の残り
 * （runs/ に同じ ID の集計があるもの）はここで消す。呼び出し側がロックを持つ
 */
async function pruneRunning(repo: RunDirs): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
  const { runs, issues } = await readLocalRuns(repo);
  const running: Doc<Run>[] = [];
  for (const run of runs) {
    if (await hasSummary(repo, run.id)) await removeRunning(repo, run.id);
    else running.push(run);
  }
  return { runs: running, issues };
}

async function withRunLock<T>(repo: RunDirs, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.join(repo.localDir, DIRS.runs), { recursive: true });
  await mkdir(path.join(repo.localDir, "locks"), { recursive: true });
  return withLock(repo.localDir, RUN_LOCK, fn);
}

/** deguboard-local/runs/ の終わっていない Run。読めないファイルは issues に入れて飛ばす */
export async function readRunningRuns(
  repo: RunDirs,
): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
  return withRunLock(repo, () => pruneRunning(repo));
}

/**
 * チケットごとの Run の agent（RN-1）：実行中の Run があればその agent（2 つ以上なら後に始めた方）、なければ最後に始めた終わった Run の agent。
 * running は実行中の Run、finished は runs/ の集計。どちらも Run の ID（開始の時刻で始まる）の順で後のものを取る。
 * 同じ秒に始めた Run の順は ID の末尾の乱数で決まるので、どちらを取るかは決まらない
 */
export function runAgentByTicket(
  running: Iterable<Run>,
  finished: Iterable<Run>,
): Map<TicketId, string> {
  const latest = (runs: Iterable<Run>) => {
    const byTicket = new Map<TicketId, Run>();
    for (const run of runs) {
      const prev = byTicket.get(run.ticket);
      if (!prev || prev.id.localeCompare(run.id) < 0) byTicket.set(run.ticket, run);
    }
    return byTicket;
  };
  const agents = new Map<TicketId, string>();
  for (const [ticket, run] of latest(finished)) agents.set(ticket, run.agent);
  // 実行中の Run が終わった Run より優先する
  for (const [ticket, run] of latest(running)) agents.set(ticket, run.agent);
  return agents;
}

/**
 * 終わっていない Run を、ロックを取らず何も消さずに読む（一覧の表示のため）。
 * runs/ に同じ ID の集計がある記録（finish の残り）は、readRunningRuns と同じくファイルで確かめて除く。読めないファイルは飛ばす
 */
export async function peekRunningRuns(repo: RunDirs): Promise<Run[]> {
  const { runs } = await readLocalRuns(repo);
  const consumed = await Promise.all(runs.map((r) => hasSummary(repo, r.id)));
  return runs.filter((_, n) => !consumed[n]).map((r) => r.data);
}

export interface StartRunInput {
  ticket: TicketId;
  step: string;
  agent: string;
  model?: string | null | undefined;
  /** やり直しの理由（もう一度の claim が開く手直しの Run。RN-5）。回数は理由の数にする */
  retryReasons?: readonly string[] | undefined;
  /** 会話記録のセッション ID。Run に書く */
  session?: string | undefined;
  /** 会話記録のファイルのパス。Run に書かず deguboard-local/transcripts/ に置く */
  transcript?: string | undefined;
  now: Date;
}

/**
 * このマシンに置いた、Run ごとの会話記録のパス（ID → パス）。読めないファイルは飛ばす
 * （Adapter は場所がないものとして、セッション ID か今の推測で数える）
 */
export async function readTranscriptPaths(
  repo: Pick<GitRepo, "localDir">,
): Promise<Map<string, string>> {
  const dir = path.join(repo.localDir, TRANSCRIPTS_DIR);
  const files = await readdir(dir).catch(() => [] as string[]);
  const paths = new Map<string, string>();
  for (const file of files) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!isRunId(id)) continue;
    try {
      const value: unknown = JSON.parse(await readFile(path.join(dir, file), "utf8"));
      const p = (value as { path?: unknown } | null)?.path;
      if (typeof p === "string" && p) paths.set(id, p);
    } catch {
      // 書きかけか壊れたファイル
    }
  }
  return paths;
}

/**
 * Run の会話記録のパスを置き換える（フックがサブエージェントの記録を結び付けるとき。RN-7）。パスは絶対パスにする。
 * live は、サブエージェントが動いている（バックグラウンドで起動したか再開して、まだ止まっていない）印。
 * 止まったときのフックが live なしで結び付け直すので、印はそこで消える
 */
export async function bindTranscript(
  repo: Pick<GitRepo, "localDir">,
  id: RunId,
  transcript: string,
  live = false,
): Promise<void> {
  await writeFileAtomic(
    path.join(repo.localDir, transcriptPath(id)),
    `${JSON.stringify({ path: path.resolve(transcript), ...(live ? { live: true } : {}) })}\n`,
  );
}

/** Run のサブエージェントが動いている印（bindTranscript の live）があるか。読めなければ false */
export async function isLiveSubagent(repo: Pick<GitRepo, "localDir">, id: RunId): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(repo.localDir, transcriptPath(id)), "utf8"),
    );
    return (value as { live?: unknown } | null)?.live === true;
  } catch {
    return false;
  }
}

/**
 * 終了の時刻（finished_at）から会話記録のパスを残す日数（RN-3・MT-5）。RN-6 の閉じ方では閉じた時刻でなく最後の push などの時刻になる。run refresh はこの期間の中の Run だけを取り直す。
 * エージェントが古い会話記録を消す既定の期間（30 日）に合わせる。過ぎた記録は読めないことが多い
 */
export const TRANSCRIPT_RETENTION_DAYS = 30;

/** 閉じた Run が、会話記録のパスを残す期間を過ぎたか。実行中の Run（finished_at が null）は過ぎない */
export function transcriptExpired(run: Pick<Run, "finished_at">, now: Date): boolean {
  if (run.finished_at === null) return false;
  const finished = Date.parse(run.finished_at);
  return (
    !Number.isNaN(finished) && now.getTime() - finished >= TRANSCRIPT_RETENTION_DAYS * 86400_000
  );
}

/** 片付けた会話記録のパス。expired は終了の時刻から期間を過ぎた Run、orphan は実行中の記録も runs/ の集計もない ID */
export interface PrunedTranscript {
  id: string;
  reason: "expired" | "orphan";
}

/**
 * deguboard-local/transcripts/ から、要らなくなった会話記録のパスを消す（RN-3）。消すのは、終了の時刻から期間を過ぎた Run と、
 * 実行中の記録も runs/ の集計もない ID のもの。期間の中の Run・実行中の Run と同じファイルを指すものは、その Run の数え始め
 * （同じファイルを先に使った Run の終わり。Adapter が others で見る）に要るので残す。start・finish と同じロックの中で、実行中の記録を見てから集計のファイルを見る
 * （finish は集計を書いてから実行中の記録を消すので、間に閉じた Run を集計のないものと取り違えない）。
 * closed は索引の閉じた Run。集計のファイルがあって索引にない Run（読んだ後に閉じたもの）は期間の中として残す
 */
export async function pruneTranscripts(
  repo: RunDirs,
  closed: (id: string) => Pick<Run, "finished_at"> | undefined,
  now: Date,
  dryRun = false,
): Promise<{ removed: PrunedTranscript[]; kept: number }> {
  const dir = path.join(repo.localDir, TRANSCRIPTS_DIR);
  return withRunLock(repo, async () => {
    const ids = (await readdir(dir).catch(() => [] as string[]))
      .map((file) => (file.endsWith(".json") ? file.slice(0, -5) : ""))
      .filter(isRunId)
      .sort();
    // 壊れて読めない実行中の記録（issues）も実行中とみなす。直せば閉じられる Run の数え始めのパスを消さない
    const local = await readLocalRuns(repo);
    const running = new Set([
      ...local.runs.map((r) => r.id),
      ...local.issues.map((issue) => path.basename(issue.path, ".json")),
    ]);
    const paths = await readTranscriptPaths(repo);
    const candidates: PrunedTranscript[] = [];
    const keptPaths = new Set<string>();
    for (const id of ids) {
      let reason: PrunedTranscript["reason"] | undefined;
      if (running.has(id)) reason = undefined;
      else if (!(await hasSummary(repo, id))) reason = "orphan";
      else {
        const run = closed(id);
        if (run && transcriptExpired(run, now)) reason = "expired";
      }
      if (reason) candidates.push({ id, reason });
      else if (paths.has(id)) keptPaths.add(paths.get(id)!);
    }
    const removed = candidates.filter(
      (c) => c.reason === "orphan" || !keptPaths.has(paths.get(c.id) ?? ""),
    );
    if (!dryRun) {
      for (const { id } of removed) {
        await unlink(path.join(repo.localDir, transcriptPath(id))).catch(() => undefined);
      }
    }
    return { removed, kept: ids.length - removed.length };
  });
}

/**
 * 実行中の Run を直す。チケットと step はフックが開いた Run をサブエージェントの記録の印で照らして直すとき（RN-7）、
 * review は見直し役が見直しの結果を書くとき（RN-9）、waiting_since は止まって待っている印を付け外しするとき（RN-7）。実行中の記録がなければ NOT_FOUND、集計を書いた後なら REJECTED
 */
export async function amendRunning(
  repo: RunDirs,
  id: RunId,
  patch:
    | { ticket: TicketId; step: string }
    | { review: RunReview }
    | { waiting_since: string | null }
    | { settling_since: string | null },
): Promise<Run> {
  return withRunLock(repo, async () => {
    // 集計を書いた後（閉じた後）の実行中の記録には書かない。書いても集計に入らない
    if (await hasSummary(repo, id))
      throw new OperationError("REJECTED", `Run ${id} is already finished`);
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
    if (!result.ok) throw new OperationError("NOT_FOUND", `Running Run ${id} not found`);
    const next = { ...result.doc.raw, ...patch };
    await writeFileAtomic(
      path.join(repo.localDir, runPath(id)),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return runSchema.parse(next);
  });
}

/**
 * 実行中の Run に since より後に書かれた見直しの結果を、その Run から外して保留に移す（RN-9）。
 * 別のセッションの見直しの Run を閉じる前に、前景の見直し役がその Run に書いてしまった今回の結果を、新しい Run に回すため。
 * 書かれた時刻は実行中の記録のファイルの更新時刻で見る（別のセッションの見直しの Run は、結果を書く操作とそのセッションのフック・
 * 次の見直しの起動のほかに更新されない。dg sync も閉じない）。
 * 移したら保留の結果を、移さなければ undefined を返す
 */
export async function moveReviewToPending(
  repo: RunDirs,
  id: RunId,
  since: Date,
): Promise<RunReview | undefined> {
  return withRunLock(repo, async () => {
    if (await hasSummary(repo, id)) return undefined;
    const file = path.join(repo.localDir, runPath(id));
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
    if (!result.ok || result.doc.data.review === null) return undefined;
    const written = (await stat(file).catch(() => undefined))?.mtime;
    if (written === undefined || written < since) return undefined;
    const review = result.doc.data.review;
    await putPendingReview(repo, result.doc.data.ticket, {
      review,
      at: toIsoDateTime(written),
    });
    const next = { ...result.doc.raw, review: null };
    await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return review;
  });
}

/** 実行中の Run を deguboard-local/runs/ に置く。同じチケットと step の Run が実行中なら拒否する */
export async function startRun(repo: RunDirs, input: StartRunInput): Promise<Run> {
  return withRunLock(repo, async () => {
    const { runs } = await pruneRunning(repo);
    const dup = runs.find((r) => r.data.ticket === input.ticket && r.data.step === input.step);
    if (dup) {
      throw new OperationError(
        "ALREADY_EXISTS",
        `Run ${dup.id} of ${input.ticket} ${input.step} is running. If it has not finished, close it with dg run finish ${dup.id} --result interrupted`,
      );
    }
    let id = newRunId(input.now);
    // 実行中の Run とも、終わった Run（runs/）とも重ならない ID にする
    while (runs.some((r) => r.id === id) || (await hasSummary(repo, id))) id = newRunId(input.now);
    const run: Run = {
      id,
      ticket: input.ticket,
      step: input.step,
      agent: input.agent,
      model: input.model ?? null,
      started_at: toIsoDateTime(input.now),
      finished_at: null,
      result: null,
      error: null,
      retries: input.retryReasons?.length ?? 0,
      retry_reasons: [...(input.retryReasons ?? [])],
      usage: emptyUsage(),
      tools: null,
      session: input.session ?? null,
      review: null,
      waiting_since: null,
      settling_since: null,
    };
    // 場所を先に置く。実行中の記録より後に置くと、その間に閉じた Run が場所なしで数えられうる。
    // 相対パスは呼んだ作業ディレクトリで絶対パスにする（finish・refresh・serve は別の場所から呼ばれうる）
    const located = input.transcript ? path.join(repo.localDir, transcriptPath(id)) : undefined;
    if (located) {
      await mkdir(path.dirname(located), { recursive: true });
      await writeFileAtomic(
        located,
        `${JSON.stringify({ path: path.resolve(input.transcript!) })}\n`,
      );
    }
    try {
      const doc = await createDoc(repo.localDir, runPath(id), "json", runSchema, run);
      return doc.data;
    } catch (e) {
      // 開けなかった Run の場所を残すと、後の同じ ID の Run が引き継ぎうる
      if (located) await unlink(located).catch(() => undefined);
      throw e;
    }
  });
}

export interface FinishRunInput {
  result: RunResult;
  error?: string | null | undefined;
  /**
   * ロックの中で読み直した実行中の記録から結果を決め直す（result・error より先）。フックが見直しの成否を結果の記録で決めるとき、
   * 読んでから閉じるまでの間に書かれた結果を取りこぼさないため
   */
  decide?: ((local: Run) => { result: RunResult; error?: string | null | undefined }) | undefined;
  retries?: number | undefined;
  /** 渡さなければ実行中の記録の値（古い記録はスキーマが空の配列にそろえる）。回数との突き合わせは run.finish がする */
  retryReasons?: readonly string[] | undefined;
  model?: string | null | undefined;
  /**
   * 公式の使用量（Adapter・会話記録）から取った値。渡さなければ null のまま（RN-2）。
   * エージェントの自己申告の数字は入れない（MT-1）ので、CLI・MCP の入力には出さない
   */
  usage?: { [K in keyof RunUsage]?: RunUsage[K] | undefined } | undefined;
  /** 会話記録から数えたツールの回数。渡さなければ実行中の記録の値（start は null を書く） */
  tools?: RunTools | null | undefined;
  /**
   * 終了時刻（ISO）。渡さなければ now。チケットの操作に付随して閉じるとき、PR の作成時刻など実際に終わった時刻にする（RN-6）。
   * 開始より前なら開始の時刻に揃える
   */
  finishedAt?: string | undefined;
  now: Date;
}

/**
 * 実行中の記録を読む。前の finish が集計を書いた後、実行中の記録を消す前に止まっていたら、記録を消してから拒否する。
 * 呼び出し側がロックを持つ
 */
async function readRunningLocked(repo: RunDirs, id: RunId): Promise<Doc<Run>> {
  if (await hasSummary(repo, id)) {
    await removeRunning(repo, id);
    throw new OperationError("REJECTED", `Run ${id} is already finished`);
  }
  const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
  if (result.ok) return result.doc;
  if (result.issue.code !== "read_error") {
    throw new OperationError(
      "VALIDATION_FAILED",
      `Cannot read the record of running Run ${id} (${result.issue.message})`,
      result.issue.detail,
    );
  }
  throw new OperationError("NOT_FOUND", `Running Run ${id} not found`);
}

/**
 * 実行中の Run を閉じ、完了時の集計を runs/ に書く。呼び出し側の書き込み（withWrite の変更か sync の照合）の中で呼び、
 * コミットの後に dropRunning で実行中の記録を消す。finishRun と、チケットの操作と照合に付随して閉じる closeOpenedRun が使う
 */
export async function closeRun(
  store: Pick<Store, "runs" | "create">,
  repo: RunDirs,
  id: RunId,
  input: FinishRunInput,
): Promise<Run> {
  // 読んでから集計を書くまでをロックの中で行う。間に amendRunning（見直しの結果など）が書くと、集計から落ちるため
  return withRunLock(repo, () => closeRunLocked(store, repo, id, input));
}

async function closeRunLocked(
  store: Pick<Store, "runs" | "create">,
  repo: RunDirs,
  id: RunId,
  input: FinishRunInput,
): Promise<Run> {
  const local = await readRunningLocked(repo, id);
  const decided = input.decide?.(local.data) ?? { result: input.result, error: input.error };
  const finishedAt = input.finishedAt ?? toIsoDateTime(input.now);
  // 実行中の記録に重ねる。中の未知のキーは残す（DT-2）。実行中の記録は集計を書くまで書き換えない
  const base = local.raw;
  const closed: Record<string, unknown> = {
    ...base,
    finished_at: finishedAt < local.data.started_at ? local.data.started_at : finishedAt,
    result: decided.result,
    error: decided.error ?? null,
    retries: input.retries ?? local.data.retries,
    retry_reasons: [...(input.retryReasons ?? local.data.retry_reasons)],
    model: input.model === undefined ? local.data.model : input.model,
    // 項目より前の記録にもキーを省かずに書く（RN-1）
    session: local.data.session,
    review: local.data.review,
    // 渡されなかったキー（undefined）は重ねない
    usage: {
      ...(base["usage"] as Record<string, unknown>),
      ...Object.fromEntries(Object.entries(input.usage ?? {}).filter(([, v]) => v !== undefined)),
    },
    tools: input.tools === undefined ? local.data.tools : input.tools,
  };
  // 止まって待っている印は実行中のものだけで、閉じた Run（Git）には書かない（RN-3）
  delete closed["waiting_since"];
  delete closed["settling_since"];
  // 別のプロセスが先に閉じていないか、ファイルで確かめる（索引は古いことがある）
  if ((await hasSummary(repo, id)) || store.runs.has(id)) {
    await removeRunning(repo, id);
    throw new OperationError("REJECTED", `Run ${id} is already finished`);
  }
  return (await store.create("run", closed)).data;
}

/** 集計を書いた Run の実行中の記録を消す。ここで止まっても、次の start・finish・list が runs/ の集計を見て記録を消す */
export async function dropRunning(repo: RunDirs, id: RunId): Promise<void> {
  await withRunLock(repo, () => removeRunning(repo, id));
}

/** 実行中の Run を閉じ、完了時の集計を runs/ に書いて commit.mode に従ってコミットする */
export async function finishRun(
  ctx: WriteContext,
  id: RunId,
  input: FinishRunInput,
): Promise<{ run: Run; write: WriteOutcome }> {
  const written = await withWrite(ctx, () => closeRun(ctx.store, ctx.repo, id, input), {
    message: (run) => `Run ${run.id} を記録: ${run.ticket} ${run.step} ${run.result ?? ""}`,
  });
  await dropRunning(ctx.repo, id);
  return { run: written.value, write: written.write };
}
