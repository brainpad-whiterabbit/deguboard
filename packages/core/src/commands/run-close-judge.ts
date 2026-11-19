// チケットの操作と照合に付随して閉じる Run の結果と finished_at の決め方（RN-6）。値を受け取って決めるだけで、
// git・ファイルを読まない（import は型と定数だけ）。チケットの操作（ticket.ts・run.ts）と照合の決定（reconcile-judge.ts）が同じ規則を使う。
// 閉じる書き込みは run.ts の closeOpenedRun。決めるのは：
//   - runsClosedByMove：move に付随して閉じる Run
//   - fixRunFinishedAt：手直しの Run を区切りで閉じるときの finished_at（照合と、次の Run を開く操作で同じ）
//   - decidePreviousFixRunClose：Run を開く操作（claim・もう一度の claim・run start・起動のフック）が、開いたままの前の手直しの Run を
//     閉じるか・その結果・finished_at。組み合わせ（区切り・push の時刻・セッション・step）は run-close-judge.test.ts が git なしで確かめる

import type { Status } from "../model/common.js";
import {
  OPENED_STEPS,
  type Run,
  type RunId,
  type RunResult,
  type StepOpener,
} from "../model/run.js";
import type { Ticket } from "../model/ticket.js";

/** 照合が、todo に戻ったチケットの実装の Run を閉じるときのエラー（RN-6） */
export const RECONCILE_TODO_ERROR = "Went back to todo during reconcile";

/** 照合が、ほかの主体の claim になったチケットの実装の Run を閉じるときのエラー（RN-6） */
export const RECONCILE_TAKEN_ERROR = "Became claimed by another actor during reconcile";

/** 別のセッションで開いたままだった Run を interrupted で閉じるときのエラー（RN-6） */
export const STALE_SESSION_ERROR =
  "Left open in another session (closed as left over from a session that ended)";

/**
 * 実行中の Run を閉じる、という決定（RN-6）。照合の行うことの列（reconcile-judge.ts の ReconcileAction）と、Run を開く操作が
 * 前の手直しの Run を閉じる決定（decidePreviousFixRunClose）で同じ形。finishedAt が undefined なら行う側が今の時刻で閉じる。
 * 別の文脈が先に閉じていたら、行う側は閉じずに警告して次へ進む。
 * note は、閉じたときだけ、閉じた知らせの前に warnings に足す文（手直しの Run の区切りと finished_at の根拠）
 */
export interface CloseRunAction {
  kind: "close_run";
  run: RunId;
  opener: StepOpener;
  result: RunResult;
  finishedAt: string | undefined;
  error?: string;
  note?: string;
}

/**
 * move に付随して閉じる Run の開き手と結果（RN-6）。abandoned は実装と手直しを failure で閉じる。
 * PR の要らない作業（branch なし）の review、と PR のない done は実装を success で閉じる。branch のあるチケットの review は PR の記録・発見が閉じる。
 * 照合も終わったチケットの実装の Run をこの結果で閉じる（ticket move と同じ結果）
 */
export function runsClosedByMove(
  ticket: Pick<Ticket, "branch" | "pr">,
  to: Status,
): { openers: readonly StepOpener[]; result: "success" | "failure" } | undefined {
  if (to === "abandoned") return { openers: ["claim", "reclaim"], result: "failure" };
  if ((to === "review" && !ticket.branch) || (to === "done" && !ticket.pr))
    return { openers: ["claim"], result: "success" };
  return undefined;
}

/**
 * 手直しの Run を区切りで閉じるときの finished_at（RN-6）。この Run の開始より後で区切りまでの push があればその時刻、
 * なければ区切りの時刻、fallback（PR のマージ時刻）、今（undefined）の順。pushed はその Run の push の時刻を使ったか
 */
export function fixRunFinishedAt(input: {
  pushedAt?: string | undefined;
  startedAt: string;
  boundaryAt?: string | undefined;
  fallback?: string | undefined;
}): { finishedAt: string | undefined; pushed: boolean } {
  const { pushedAt, startedAt, boundaryAt, fallback } = input;
  if (
    pushedAt !== undefined &&
    pushedAt >= startedAt &&
    (boundaryAt === undefined || pushedAt <= boundaryAt)
  ) {
    return { finishedAt: pushedAt, pushed: true };
  }
  return { finishedAt: boundaryAt ?? fallback, pushed: false };
}

/**
 * 開いたままの Run が、今の操作とは別のセッションで開いたものか（RN-6）。別のセッションの Run は、そのセッションが落ちて
 * 閉じ損ねた残りとみなす（同じチケットと step を別のセッションで並行して動かすことは想定しない。並行していれば動いている方を閉じる）。
 * どちらかのセッションが分からなければ（セッションを渡さない製品・環境）false
 */
export function openedInOtherSession(
  run: Pick<Run, "session">,
  session: string | undefined,
): boolean {
  return run.session !== null && session !== undefined && run.session !== session;
}

/**
 * Run を開く操作が、開く前に、開いたままの前の手直しの Run を閉じにいくか（RN-6）。同じチケットと step の Run が実行中
 * （duplicate）なら、開くのは拒まれる（二重起動の拒否。SY-5）ので閉じない。ただし手直しを開き直す操作（reopensFix：もう一度の claim と
 * 印の起動のフック）が開く手直しの step では、前の手直しを閉じて開き直す
 */
export function closesFixRunBeforeOpening(opening: {
  step: string;
  duplicate: boolean;
  reopensFix: boolean;
}): boolean {
  return !opening.duplicate || (opening.reopensFix && opening.step === OPENED_STEPS.reclaim);
}

/**
 * 開く Run の開始が、開いたままの手直しの Run の区切りになるか。手直しの Run の開始と同じ秒か後の開始だけを区切りに数える
 * （照合の reconcile-judge.ts の fixRunActions と同じ。前景の起動で前にした開始が手直しより前なら区切りにしない）。
 * 同じ秒を数えるのは、時刻が秒までの記録では前後を決められず、手直しの後に続けて見直しを開くと同じ秒になりうるため
 */
export function startsAtOrAfterFixRun(
  previous: Pick<Run, "started_at">,
  startedAt: string,
): boolean {
  return startedAt >= previous.started_at;
}

/** Run を開く操作が、開いたままの前の手直しの Run をどう閉じるか決めるのに要る事実 */
export interface PreviousFixRunFacts {
  /** チケットの ID（知らせる文に書く） */
  ticket: string;
  /** 同じチケットの、開いたままの前の手直しの Run */
  previous: Pick<Run, "id" | "step" | "started_at" | "session">;
  /** これから開く Run。startedAt が区切りの時刻。session は開く操作のセッション（分からなければ undefined） */
  opening: { step: string; session: string | undefined; startedAt: string };
  /** 作業ブランチに最後に push したコミットの時刻（git/facts.ts の lastPushedAt。push がない・作業ブランチがなければ undefined） */
  pushedAt: string | undefined;
}

/**
 * Run を開く操作が、開いたままの前の手直しの Run を、開く Run の開始を区切りとして閉じるか・その結果・finished_at を決める（RN-6）。
 * claim・もう一度の claim・起動のフック・run start のどこから開いても同じ規則になる。
 *   - 開く Run の開始が前の手直しより前なら閉じない（undefined。startsAtOrAfterFixRun）
 *   - finished_at は、前の Run の開始より後で区切りまでの最後の push の時刻。push がなければ区切りの時刻（fixRunFinishedAt。前景の手直しの
 *     起動では、フックが来る時点で今回の push が済んでいることがあり、そのとき前の回の手直しは区切りの時刻で閉じる）
 *   - 結果は success。ただし手直しの step を開くとき、前の手直しが別のセッションで開いたものなら、そのセッションが落ちた残りとみなして
 *     interrupted にする（どちらかのセッションが分からなければ success）
 */
export function decidePreviousFixRunClose(f: PreviousFixRunFacts): CloseRunAction | undefined {
  const { ticket, previous, opening } = f;
  if (!startsAtOrAfterFixRun(previous, opening.startedAt)) return undefined;
  const { finishedAt, pushed } = fixRunFinishedAt({
    pushedAt: f.pushedAt,
    startedAt: previous.started_at,
    boundaryAt: opening.startedAt,
  });
  const close = { kind: "close_run", run: previous.id, opener: "reclaim", finishedAt } as const;
  // error は定数の名前をここに書く（web の l10n.test.ts が、core のソースで error に渡す定数を拾って訳の表と突き合わせる）
  if (opening.step === previous.step && openedInOtherSession(previous, opening.session))
    return {
      ...close,
      result: "interrupted",
      error: STALE_SESSION_ERROR,
      note: `${ticket}: the earlier fix Run ${previous.id} was still open in another session (${previous.session}), so it is treated as left over from a crashed session and closed as interrupted`,
    };
  const when = pushed ? "the time of the last push" : "the start time, since there was no push";
  return {
    ...close,
    result: "success",
    note: `${ticket}: closing the earlier fix Run ${previous.id} with the start of the next ${opening.step} Run as the boundary, at ${when}`,
  };
}
