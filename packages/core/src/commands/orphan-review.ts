// 持ち主のない保留の見直しの結果を、見直しの記録として数える（RN-9、ADR-025。t699）。dg next の段階と dg gate の review・fix_rounds が
// 同じ関数を読み、どちらも何も書かない。dg sync と dg pr ready は同じ判定で記録を Git に書き、保留をその Run に結び付ける
// （recordOrphanReviews。t700）。書いた後は保留が残らないので、書く前と同じ見直しを Git の Run から数える。
// 数える判定（どの保留を数えるか、いつ数えないか、push の区切り）は orphan-review-judge.ts の countOrphanReviews にあり、
// ここは事実（サブエージェントが動いているか・保留の回・コミットの時刻）を集めて渡すことと、記録を書くことだけをする

import { branchCommitTimes } from "../git/facts.js";
import { toIsoDateTime } from "../model/common.js";
import { newRunId, REVIEW_STEP, type Run, type RunId } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import { isLiveSubagent, linkHeldRounds, readReviewFindings } from "../run/record.js";
import type { CommandContext } from "./define.js";
import { countOrphanReviews } from "./orphan-review-judge.js";

/**
 * チケットの持ち主のない保留を、閉じた見直しの記録として返す（判定は countOrphanReviews）。running は実行中の Run
 * （ほかのチケットのものを含んでよい）
 */
export async function orphanReviewRuns(
  ctx: CommandContext,
  ticket: Pick<Ticket, "id" | "branch" | "branch_at">,
  running: readonly Run[],
): Promise<Run[]> {
  const live = new Set<RunId>();
  for (const r of running) {
    if (r.ticket !== ticket.id || r.finished_at !== null) continue;
    if (await isLiveSubagent(ctx.repo, r.id)) live.add(r.id);
  }
  const rounds = (await readReviewFindings(ctx.repo, ticket.id))?.rounds ?? [];
  // コミットの時刻は保留の回があるときだけ読む（git を呼ぶので。保留がなければ判定は区切りを使わない）。
  // fetch はしない（next と gate は先に remoteTip で取り込む）。読めなければ区切りなし（最新の 1 件だけ）
  const commits =
    ticket.branch && rounds.some((r) => r.run === null)
      ? ((await branchCommitTimes(ctx.repo, ticket.branch).catch(() => undefined)) ?? [])
      : [];
  return countOrphanReviews(ticket.id, {
    running,
    live,
    rounds,
    since: ticket.branch_at,
    // コミッタの時刻は時差付きなので、保留の時刻（UTC）と文字列で比べられる形にそろえる
    commits: commits.map((c) => toIsoDateTime(new Date(c.at))),
  });
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
