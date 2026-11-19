// 持ち主のない保留の見直しの判定（RN-9、ADR-025。t699・t701）。事実（OrphanReviewFacts）を受け取って決めるだけで、
// git・ファイルを読まない（import は型と定数と純粋な関数だけ）。事実を集めて数え、記録を書くのは orphan-review.ts。
// 判定の組み合わせ（開いた見直しの Run・待ちの印・書き終わりの待ち・動いているサブエージェント・push の区切り）は
// orphan-review-judge.test.ts が git なしで確かめ、git を通すテストは経路の代表だけを見る
//   - 保留（run review-result が書く先の Run なしに置いた回。record.ts の ReviewRound の run が null）は、フックがあれば前景の見直し役が
//     返ったときにフックが見直しの Run に結び付ける（adoptPendingRounds）。親が next・gate を呼ぶときにまだ結び付いていない保留は、
//     フックが Run を記録しなかったもの（フックが届かない環境）なので、見直しの記録として数える
//   - チケットに開いた見直しの Run があるか、動いているサブエージェントの印（bindTranscript の live）があれば、これから結び付く
//     保留かもしれないので数えない。止まって待つ印・書き終わり待ちの印のある Run は、印があっても動いていないとみなす
//   - 見直しは結果を書いた時刻（保留の at）に閉じたものとして数える。今の時刻にすると、最後のコミットより前の結果が
//     「最後の push より後の見直し」を満たしてしまう（見直した SHA を持たない前の回のとき。SHA を持つ回は SHA で比べる。t763）
//   - 同じ push の後の保留が複数あれば最新の 1 件だけを数える（同じ状態の見直しの呼び直し）。push をまたぐ保留は別の回にする。
//     push の区切りは作業ブランチのコミットの時刻で近似する（lastPushedAt と同じく push した時刻は Git に残らない）
//   - 前景の見直し役が動いている間に書いた記録は、見直し役が返ったときに起動のフックが引き取り、capture: none を外す
//     （adoptableReviewRecord。t701）

import { emptyUsage, REVIEW_STEP, type Run, type RunId } from "../model/run.js";
import type { TicketId } from "../model/id.js";
import type { ReviewRound } from "../run/record.js";

/** 判定が読む保留の回の項目 */
export type HeldRound = Pick<ReviewRound, "run" | "at" | "review" | "session" | "head">;

/** 判定が読む実行中の Run の項目（保留を引き取りうる Run か見る） */
export type AdopterRunFact = Pick<
  Run,
  "id" | "ticket" | "step" | "finished_at" | "waiting_since" | "settling_since"
>;

/** 持ち主のない保留を数えるのに要る事実。集めるのは orphan-review.ts の orphanReviewRuns */
export interface OrphanReviewFacts {
  /** 実行中の Run（ほかのチケットのものを含んでよい） */
  running: readonly AdopterRunFact[];
  /** running のうち、動いているサブエージェントの印（bindTranscript の live）がある Run の ID */
  live: ReadonlySet<RunId>;
  /** チケットの見直しの回（Run に結び付いた回を含んでよい） */
  rounds: readonly HeldRound[];
  /** 作業ブランチを切った時刻（branch_at）。これより前の回は前の作業なので数えない */
  since: string | undefined;
  /** 作業ブランチのコミットの時刻（UTC の ISO 形式。push の区切り）。読めなければ空（区切りなし） */
  commits: readonly string[];
}

/** 持ち主のない保留から作った見直しの記録の ID。段階と判定の文に出る（Run の ID ではない） */
const orphanId = (at: string) => `held review result written at ${at}` as RunId;

/**
 * 保留がこれから Run に結び付くかもしれないか。チケットに開いた見直しの Run があるか、
 * 止まって待つ印・書き終わり待ちの印のない開いた Run に動いているサブエージェントの印があるとき。
 * 止まったかの見方は run finish が動いているサブエージェントの Run を拒むとき（rejectLiveSubagentRun）と同じ
 */
function mayBeAdopted(
  ticket: TicketId,
  running: readonly AdopterRunFact[],
  live: ReadonlySet<RunId>,
): boolean {
  const open = running.filter((r) => r.ticket === ticket && r.finished_at === null);
  if (open.some((r) => r.step === REVIEW_STEP)) return true;
  return open.some((r) => r.waiting_since === null && r.settling_since === null && live.has(r.id));
}

/**
 * チケットの持ち主のない保留を、閉じた見直しの記録として返す。dg next・dg gate が数え、dg sync・dg pr ready が書く記録はこれ。
 * これから Run に結び付くかもしれない保留（mayBeAdopted）があれば空
 */
export function countOrphanReviews(ticket: TicketId, facts: OrphanReviewFacts): Run[] {
  if (mayBeAdopted(ticket, facts.running, facts.live)) return [];
  return orphanReviewsOf(ticket, facts.rounds, facts.since, facts.commits);
}

/**
 * 保留の回から、見直しとして数える記録を作る。since（branch_at）より前の回は前の作業なので数えない。
 * commits は作業ブランチのコミットの時刻（push の区切り）。同じ区切りの中では最新の回だけを残す
 */
export function orphanReviewsOf(
  ticket: TicketId,
  rounds: readonly HeldRound[],
  since: string | undefined,
  commits: readonly string[],
): Run[] {
  const boundaries = [...commits].sort();
  // 結果を書いた時刻の直前のコミットの時刻（なければ空）。同じ値の回は同じ push の後の回
  const pushOf = (at: string) => boundaries.filter((c) => c <= at).at(-1) ?? "";
  const latest = new Map<string, Omit<HeldRound, "run">>();
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
    // 結果を書いたセッション。起動のフックが同じセッションの記録だけを引き取る（adoptableReviewRecord）
    session: r.session ?? null,
    review: r.review,
    // 結果を書いたときのローカルの先端。新しさは dg gate・dg next がこれをリモートの先端と比べる（t763。ない回は時刻で比べる）
    ...(r.head ? { head: r.head } : {}),
    // 会話記録を取らずに作った記録の印。書いた記録（recordOrphanReviews）にもそのまま入る
    capture: "none",
    waited_seconds: null,
    waiting_since: null,
    settling_since: null,
  }));
}

/**
 * 前景の見直し役が返ったときに、起動のフックが新しい Run を開かずに引き取る見直しの記録（t701）。見直し役が動いている間は Run がないので、
 * 別のプロセスの dg sync・dg pr ready がその保留を持ち主のないものとして先に記録にしうる。引き取らずに開くと、結果のない Run が
 * 失敗で閉じて最新の見直しが失敗に見え、保留が新しい Run に結び付けば同じ見直しを 2 回数える。
 * 引き取るのは、同じチケットの capture: none の見直しの記録のうち、同じセッション（結果を書いたセッション）で起動（launchedAt）より後に
 * 書かれたものだけ。セッションの分からない記録・別のセッションの記録・起動より前の記録は、この見直し役の結果でないので引き取らない。
 * 複数あれば最も後のもの
 */
export function adoptableReviewRecord(
  runs: Iterable<Run>,
  ticket: TicketId,
  session: string,
  launchedAt: string,
): Run | undefined {
  return [...runs]
    .filter(
      (r) =>
        r.ticket === ticket &&
        r.step === REVIEW_STEP &&
        r.capture === "none" &&
        r.session === session &&
        r.started_at >= launchedAt,
    )
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id))
    .at(-1);
}
