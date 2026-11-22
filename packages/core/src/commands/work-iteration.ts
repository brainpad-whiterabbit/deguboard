// 作業中（in_progress・review）のチケットの Iteration は active、という Core の固定の規則（IT-4、ADR-009）を、索引の今の Iteration で
// 行う。事実を集めて決定（work-iteration-judge.ts。git・ファイルを読まない）に渡し、決定が開始なら Iteration を開始して、拒否なら
// REJECTED を投げる。チケットを作業中にする claim（claim-setup.ts）と ticket move、作業中のチケットを Iteration に入れる iteration add と
// ticket update --iteration、着手の手を返す dg next、照合と lint（setup.ts）がここを通る

import { OperationError } from "../errors.js";
import { otherActiveOf, type Iteration } from "../model/iteration.js";
import type { Ticket } from "../model/ticket.js";
import type { Store } from "../storage/store.js";
import type { CommandContext } from "./define.js";
import { nowIso } from "./helpers.js";
import {
  decideWorkAssignment,
  decideWorkIteration,
  type WorkIterationDecision,
  type WorkRoute,
} from "./work-iteration-judge.js";

/**
 * 索引の Iteration のうち、it のほかに active のもの（model/iteration.ts の otherActiveOf）。IT-4 の規則のほかに、
 * iteration start・reopen の拒否（IT-1。iteration.ts の rejectIfOtherActive）もここで求める
 */
export function otherActiveIn(store: Store, it: Pick<Iteration, "id">): Iteration | undefined {
  return otherActiveOf(
    [...store.iterations.values()].map((i) => i.data),
    it,
  );
}

/**
 * チケットを作業中にしてよいかの決定に要る Iteration の事実（work-iteration-judge.ts の WorkIterationFacts の iteration と
 * otherActive）を、索引の今の Iteration で求める。照合（setup.ts）も同じ事実を決定に渡す
 */
export function workIterationFactsOf(
  ctx: CommandContext,
  iterationId: Ticket["iteration"],
): { iteration: Iteration | undefined; otherActive: string | undefined } {
  const it = iterationId ? ctx.store.iterations.get(iterationId) : undefined;
  return {
    iteration: it?.data,
    otherActive: it ? otherActiveIn(ctx.store, it.data)?.id : undefined,
  };
}

/** チケットを作業中にしてよいかの決定（work-iteration-judge.ts）を、索引の今の Iteration で求める。何も書かない */
export function workIterationDecision(
  ctx: CommandContext,
  route: WorkRoute,
  ticketId: string,
  iterationId: Ticket["iteration"],
): WorkIterationDecision {
  return decideWorkIteration({
    route,
    ticket: ticketId,
    ...workIterationFactsOf(ctx, iterationId),
  });
}

/**
 * 作業中のチケットを Iteration に入れる書き込み（iteration add・ticket update --iteration）の中で、入れ先が active でなければ
 * REJECTED を投げる（IT-4。決定は work-iteration-judge.ts の decideWorkAssignment）。今と同じ Iteration は出し入れでないので見ない
 */
export function requireWorkAssignment(
  ctx: CommandContext,
  ticket: Pick<Ticket, "id" | "status" | "iteration">,
  target: Iteration,
): void {
  if (ticket.iteration === target.id) return;
  const message = decideWorkAssignment({
    ticket: ticket.id,
    status: ticket.status,
    target,
    otherActive: otherActiveIn(ctx.store, target)?.id,
  });
  if (message) throw new OperationError("REJECTED", message);
}

/**
 * チケットを作業中にする書き込みの中で、その Iteration が active であることを守る（IT-4。claim と ticket move が共有する）。
 * 決定が開始なら planned の Iteration を開始して warnings に書き、拒否なら REJECTED を投げる（何も書く前に呼ぶ）。
 * cannotStart は、開始を書けない書き込み（ticket move の排他でない書き込み）で渡し、決定が開始なら書かずにその誤りを投げる
 */
export async function startIterationForWork(
  ctx: CommandContext,
  route: WorkRoute,
  ticketId: string,
  iterationId: Ticket["iteration"],
  warnings: string[],
  cannotStart?: () => Error,
): Promise<void> {
  const decision = workIterationDecision(ctx, route, ticketId, iterationId);
  if (decision.kind === "reject") throw new OperationError("REJECTED", decision.message);
  if (decision.kind !== "start") return;
  if (cannotStart) throw cannotStart();
  // iteration.start と同じく、実績の期間の始まり started_at を書く（IT-1）
  await ctx.store.update("iteration", decision.iteration, {
    status: "active",
    started_at: nowIso(ctx),
  });
  warnings.push(`Started ${decision.iteration} (active)`);
}
