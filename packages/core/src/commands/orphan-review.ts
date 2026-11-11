// 持ち主のない保留の見直しの結果を、見直しの記録として数える（RN-9、ADR-025。t699）。dg next の段階と dg gate の review・fix_rounds が
// 同じ関数を読み、どちらも何も書かない（Git に書くのは別の操作）。
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
import { emptyUsage, REVIEW_STEP, type Run, type RunId } from "../model/run.js";
import type { TicketId } from "../model/id.js";
import type { Ticket } from "../model/ticket.js";
import { isLiveSubagent, readReviewFindings, type ReviewRound } from "../run/record.js";
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
