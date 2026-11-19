// チケットの操作と照合に付随して閉じる Run の結果と finished_at の決め方（RN-6）。値を受け取って決めるだけで、
// git・ファイルを読まない（import は型だけ）。チケットの操作（ticket.ts・run.ts）と照合の決定（reconcile-judge.ts）が同じ規則を使う。
// 閉じる書き込みは run.ts の closeOpenedRun

import type { Status } from "../model/common.js";
import type { StepOpener } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";

/** 照合が、todo に戻ったチケットの実装の Run を閉じるときのエラー（RN-6） */
export const RECONCILE_TODO_ERROR = "Went back to todo during reconcile";

/** 照合が、ほかの主体の claim になったチケットの実装の Run を閉じるときのエラー（RN-6） */
export const RECONCILE_TAKEN_ERROR = "Became claimed by another actor during reconcile";

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
