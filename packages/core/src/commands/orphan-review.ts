// 持ち主のない保留の見直しの結果を、見直しの記録として数える（RN-9、ADR-025。t699）。dg next の段階と dg gate の review・fix_rounds が
// 同じ関数を読み、どちらも何も書かない。dg sync と dg pr ready は同じ判定で記録を Git に書き、保留をその Run に結び付ける
// （recordOrphanReviews。t700）。書いた後は保留が残らないので、書く前と同じ見直しを Git の Run から数える。
//   - 保留（run review-result が書く先の Run なしに置いた回。record.ts の ReviewRound の run が null）は、フックがあれば前景の見直し役が
//     返ったときにフックが見直しの Run に結び付ける（adoptPendingRounds）。親が next・gate を呼ぶときにまだ結び付いていない保留は、
//     フックが Run を記録しなかったもの（フックが届かない環境）なので、見直しの記録として数える
//   - チケットに開いた見直しの Run があるか、動いているサブエージェントの印（bindTranscript の live）があれば、これから結び付く
//     保留かもしれないので数えない
//   - 見直しは結果を書いた時刻（保留の at）に閉じたものとして数える。今の時刻にすると、最後のコミットより前の結果が
//     「最後の push より後の見直し」を満たしてしまう
//   - 同じ push の後の保留が複数あれば最新の 1 件だけを数える（同じ状態の見直しの呼び直し）。push をまたぐ保留は別の回にする。
//     push の区切りは作業ブランチのコミットの時刻で近似する（lastPushedAt と同じく push した時刻は Git に残らない）

import { branchCommitTimes } from "../git/facts.js";
import { toIsoDateTime } from "../model/common.js";
import { emptyUsage, newRunId, REVIEW_STEP, type Run, type RunId } from "../model/run.js";
import type { TicketId } from "../model/id.js";
import type { Ticket } from "../model/ticket.js";
import {
  isLiveSubagent,
  linkHeldRounds,
  readReviewFindings,
  type ReviewRound,
} from "../run/record.js";
import type { CommandContext } from "./define.js";

/** 持ち主のない保留から作った見直しの記録の ID。段階と判定の文に出る（Run の ID ではない） */
const orphanId = (at: string) => `held review result written at ${at}` as RunId;

/**
 * 保留の回から、見直しとして数える記録を作る（純粋関数）。since（branch_at）より前の回は前の作業なので数えない。
 * commits は作業ブランチのコミットの時刻（push の区切り）。同じ区切りの中では最新の回だけを残す
 */
export function orphanReviewsOf(
  ticket: TicketId,
  rounds: readonly Pick<ReviewRound, "run" | "at" | "review">[],
  since: string | undefined,
  commits: readonly string[],
): Run[] {
  const boundaries = [...commits].sort();
  // 結果を書いた時刻の直前のコミットの時刻（なければ空）。同じ値の回は同じ push の後の回
  const pushOf = (at: string) => boundaries.filter((c) => c <= at).at(-1) ?? "";
  const latest = new Map<string, Pick<ReviewRound, "at" | "review">>();
  const held = rounds
    .filter((r) => r.run === null && r.at >= (since ?? ""))
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const r of held) latest.set(pushOf(r.at), r);
  return [...latest.values()].map((r) => ({
    id: orphanId(r.at),
    ticket,
    step: REVIEW_STEP,
    agent: "unknown",
    model: null,
    started_at: r.at,
    finished_at: r.at,
    result: "success",
    error: null,
    retries: 0,
    retry_reasons: [],
    usage: emptyUsage(),
    tools: null,
    session: null,
    review: r.review,
    // 会話記録を取らずに作った記録の印。書いた記録（recordOrphanReviews）にもそのまま入る
    capture: "none",
    waiting_since: null,
    settling_since: null,
  }));
}

/**
 * チケットの持ち主のない保留を、閉じた見直しの記録として返す。running は実行中の Run（ほかのチケットのものを含んでよい）。
 * 開いた見直しの Run か、動いているサブエージェントの印（止まって待つ印・書き終わり待ちの印のないもの）があれば空
 */
export async function orphanReviewRuns(
  ctx: CommandContext,
  ticket: Pick<Ticket, "id" | "branch" | "branch_at">,
  running: readonly Run[],
): Promise<Run[]> {
  const open = running.filter((r) => r.ticket === ticket.id && r.finished_at === null);
  if (open.some((r) => r.step === REVIEW_STEP)) return [];
  for (const r of open) {
    // 止まったかの見方は run finish が動いているサブエージェントの Run を拒むとき（rejectLiveSubagentRun）と同じ
    if (r.waiting_since !== null || r.settling_since !== null) continue;
    if (await isLiveSubagent(ctx.repo, r.id)) return [];
  }
  const rounds = (await readReviewFindings(ctx.repo, ticket.id))?.rounds ?? [];
  if (!rounds.some((r) => r.run === null)) return [];
  // fetch はしない（next と gate は先に lastPushedAt で取り込む）。読めなければ区切りなし（最新の 1 件だけ）
  const commits = ticket.branch
    ? ((await branchCommitTimes(ctx.repo, ticket.branch).catch(() => undefined)) ?? [])
    : [];
  return orphanReviewsOf(
    ticket.id,
    rounds,
    ticket.branch_at,
    // コミッタの時刻は時差付きなので、保留の時刻（UTC）と文字列で比べられる形にそろえる
    commits.map((c) => toIsoDateTime(new Date(c.at))),
  );
}

/** 持ち主のない保留から書いた見直しの記録。written は今回書いた Run、linked は保留を結び付ける Run（前に書いた記録を含む） */
export interface RecordedOrphanReviews {
  written: Run[];
  linked: Run[];
}

/**
 * 持ち主のない保留を、閉じた見直しの Run（capture: none）としてストアに書く（t700）。判定は orphanReviewRuns と同じで、
 * 呼び出し側の書き込み（withWrite の変更か sync の照合）の中で呼び、コミットの後に linkOrphanRounds で保留を Run に結び付ける。
 *   - ID は結果を書いた時刻を開始にした新しい Run の ID（辞書順が開始の順になる）
 *   - 前に書いた記録（同じチケットの capture: none の見直しで、開始が保留の時刻のもの）があれば書き直さない。
 *     Git に書いた後、保留を結び付ける前に止まった残りなので、結び付けだけをやり直す（同じ見直しを 2 回書かない）
 *   - 止まって待つ印・書き終わり待ちの印は、閉じた Run（Git）に書かない（closeRun と同じ）
 */
export async function recordOrphanReviews(
  ctx: CommandContext,
  ticket: Pick<Ticket, "id" | "branch" | "branch_at">,
  running: readonly Run[],
): Promise<RecordedOrphanReviews> {
  const out: RecordedOrphanReviews = { written: [], linked: [] };
  for (const made of await orphanReviewRuns(ctx, ticket, running)) {
    const earlier = [...ctx.store.runs.values()].find(
      (d) =>
        d.data.ticket === ticket.id &&
        d.data.step === REVIEW_STEP &&
        d.data.capture === "none" &&
        d.data.started_at === made.started_at,
    );
    if (earlier) {
      out.linked.push(earlier.data);
      continue;
    }
    const startedAt = new Date(made.started_at);
    let id = newRunId(startedAt);
    while (ctx.store.runs.has(id) || running.some((r) => r.id === id)) id = newRunId(startedAt);
    const { waiting_since: _waiting, settling_since: _settling, ...closed } = made;
    const run = (await ctx.store.create("run", { ...closed, id })).data;
    out.written.push(run);
    out.linked.push(run);
  }
  return out;
}

/** recordOrphanReviews の後（コミットの後）に、保留の回を書いた Run に結び付ける。Git に書けなかったときは呼ばない（保留を残す） */
export async function linkOrphanRounds(
  ctx: CommandContext,
  ticket: Pick<Ticket, "id" | "branch_at">,
  recorded: RecordedOrphanReviews,
): Promise<void> {
  await linkHeldRounds(ctx.repo, ticket.id, ticket.branch_at, recorded.linked);
}
