// 進め始める Plan とチケットの予約（deguboard-local/reservations/<チケットか Plan の ID>.json。PL-7。t1149）。
// 承認された Plan のチケットは claim されるまで todo のままで、claim の記録（claim-sessions.ts。t1148）ではまだ止められない。
// そこで、進め始めるセッションが `plan show <p> --reserve`・`next <ticket> --reserve` で Plan（そのチケット）を予約し、
// 別のセッションの agent の claim と `dg next` を止める。見るだけの呼び出し（--reserve なし）は予約を作らない。
// 記録の形と置き方（このマシンだけ・Git に入れない）は claim の記録と同じで、効くか・拒むかも同じ関数
// （claim-judge.ts の sessionClaimHolds・decideSessionClaim）が決める。ここは記録とフックの時刻を読み書きするだけ

import { z } from "zod";
import { UsageError } from "../errors.js";
import {
  claimRejectionError,
  decideSessionClaim,
  holdingReservation,
  type ClaimRejection,
  type ReservationCandidate,
  type SessionClaim,
  type SessionClaimDecision,
  type SessionOperation,
} from "./claim-judge.js";
import { readSessionRecord, removeSessionRecord, writeSessionRecord } from "./claim-sessions.js";
import type { CommandContext } from "./define.js";
import { nowIso, openPlanOf } from "./helpers.js";
import { SESSION_ID } from "./hook-records.js";
import { hookTimesOf } from "./hook-sessions.js";
import { CRASHED_SUBAGENT_IDLE_MS, sessionOf } from "./run.js";
import type { TicketId } from "../model/id.js";
import type { Plan } from "../model/plan.js";

const RESERVATIONS_DIR = "reservations";

/** `plan show`・`next` の予約の指定。付けない呼び出し（見るだけ）は予約を作らない */
export const reserveFields = {
  reserve: z
    .boolean()
    .optional()
    .describe(
      "Reserve it for the calling session. Pass it only when you are about to advance it (the steps of dg guide work and the commands of dg flow next carry it), not when you only look. While the session is alive, an agent in another session of the same user cannot claim the reserved tickets, and dg next returns wait_session to it. Kept in deguboard-local/reservations/ on this machine, not in Git, and ignored under the same conditions as the record of the session that claimed a ticket (dg ticket claim --help). A person's call and a call whose session is unknown reserve nothing (a warning says so)",
    ),
  take_over: z
    .boolean()
    .optional()
    .describe(
      "With --reserve, take over what another live session of yours reserved: the reservation moves to the calling session. Use when that session has stopped or a person told you to take the work over",
    ),
};

/** --take-over は --reserve と一緒にだけ使える（予約を移す指定なので、見るだけの呼び出しには意味がない） */
export function requireReserveWithTakeOver(input: {
  reserve?: boolean | undefined;
  take_over?: boolean | undefined;
}): void {
  if (input.take_over && !input.reserve)
    throw new UsageError("take_over can be used only with reserve");
}

/** 対象（チケットか Plan の ID）の予約。なければ・読めなければ undefined */
export const readReservation = (
  localDir: string,
  target: string,
): Promise<SessionClaim | undefined> => readSessionRecord(localDir, RESERVATIONS_DIR, target);

/** 呼び出しのセッションの指定と --take-over */
interface CallerInput {
  session?: string | undefined;
  take_over?: boolean | undefined;
}

/** チケットに効きうる予約の対象。優先の順（チケット自身、それを含む開いた Plan。holdingReservation） */
function targetsOf(ctx: CommandContext, ticket: TicketId): string[] {
  const plan = openPlanOf(ctx.store, ticket);
  return plan ? [ticket, plan.id] : [ticket];
}

/** 対象の予約とフックの時刻を読み、subject への操作を止めるかを claim の記録と同じ関数で決める。記録は変えない */
async function judge(
  ctx: CommandContext,
  subject: string,
  targets: readonly string[],
  operation: SessionOperation,
  input: CallerInput,
): Promise<SessionClaimDecision> {
  const localDir = ctx.repo.localDir;
  const candidates: ReservationCandidate[] = [];
  for (const target of targets) {
    const record = await readReservation(localDir, target);
    if (record)
      candidates.push({ target, record, ...(await hookTimesOf(localDir, record.session)) });
  }
  const clock = { now: ctx.now(), idleMs: CRASHED_SUBAGENT_IDLE_MS };
  const held = holdingReservation(candidates, clock);
  return decideSessionClaim({
    ticket: subject,
    operation,
    record: held?.record,
    ...(held ? { reserved: held.target } : {}),
    lastHookAt: held?.lastHookAt,
    endedAt: held?.endedAt,
    ...clock,
    actorKind: ctx.actor.kind,
    session: sessionOf(ctx, input.session),
    takeOver: input.take_over === true,
  });
}

/** --reserve のない `dg next` を、別のセッションの予約で止めるかを決める（止めるなら拒否の決定を返す。記録は変えない） */
export const judgeReservedNext = (ctx: CommandContext, ticket: TicketId) =>
  judge(ctx, ticket, targetsOf(ctx, ticket), "next", {});

/**
 * claim（start は todo の新しい claim、claim はもう一度の claim）を、別のセッションの予約で止める。拒否は dg のエラーを投げ、
 * 通すときの知らせは warnings に足す。--take-over で越えたら true を返す（claim が通った後に moveReservation で予約を移す）
 */
export async function guardReservedClaim(
  ctx: CommandContext,
  ticket: TicketId,
  operation: "start" | "claim",
  input: CallerInput,
  warnings: string[],
): Promise<boolean> {
  const decision = await judge(ctx, ticket, targetsOf(ctx, ticket), operation, input);
  if (decision.kind === "reject") throw claimRejectionError(decision, false);
  if (decision.warning) warnings.push(decision.warning);
  return decision.takenOver === true;
}

/** 対象の予約を、呼んだセッションのものとして書く。書けなくても失敗させずに警告する */
async function write(
  ctx: CommandContext,
  target: string,
  session: string,
  warnings: string[],
): Promise<void> {
  try {
    await writeSessionRecord(
      ctx.repo.localDir,
      RESERVATIONS_DIR,
      target,
      { session, claimed_at: nowIso(ctx) },
      ctx.now(),
    );
  } catch (e) {
    warnings.push(
      `Could not record the reservation of ${target} (${e instanceof Error ? e.message : String(e)}), so another session of yours is not stopped from advancing it`,
    );
  }
}

/** --take-over で越えた claim の後に、チケットの予約を呼んだセッションに移す（guardReservedClaim が true を返したときだけ呼ぶ） */
export async function moveReservation(
  ctx: CommandContext,
  ticket: TicketId,
  input: CallerInput,
  warnings: string[],
): Promise<void> {
  const session = sessionOf(ctx, input.session);
  if (session !== undefined && SESSION_ID.test(session))
    await write(ctx, ticket, session, warnings);
}

/** 対象の予約を消す（unclaim したチケットと閉じた Plan。なくてもよく、消せなくても失敗させない） */
export async function dropReservation(ctx: CommandContext, target: string): Promise<void> {
  await removeSessionRecord(ctx.repo.localDir, RESERVATIONS_DIR, target).catch(() => undefined);
}

/**
 * `plan show <p> --reserve`・`next <ticket> --reserve`：呼んだセッションが Plan（そのチケット）を予約する。
 * 別のセッションの予約が効いていれば、予約を変えずに拒否の決定を返す（--take-over で越えて予約を移す）。
 * 予約するのはセッションがわかる agent だけ。人とセッションがわからない呼び出しは予約を作らず、そのことを知らせる。
 * Plan を引き継いだら、その Plan のチケットに残る別のセッションの予約も消す（チケットの予約が Plan の予約より先に効くため）
 */
export async function reserve(
  ctx: CommandContext,
  target: { ticket: TicketId } | { plan: Plan },
  input: CallerInput,
  warnings: string[],
): Promise<ClaimRejection | undefined> {
  const id = "plan" in target ? target.plan.id : target.ticket;
  const targets = "plan" in target ? [id] : targetsOf(ctx, target.ticket);
  const decision = await judge(ctx, id, targets, "reserve", input);
  if (decision.kind === "reject") return decision;
  if (decision.warning) warnings.push(decision.warning);
  const session = ctx.actor.kind === "agent" ? sessionOf(ctx, input.session) : undefined;
  if (session === undefined || !SESSION_ID.test(session)) {
    warnings.push(
      `${id} was not reserved: ${
        ctx.actor.kind === "agent"
          ? "the session calling dg is unknown (the agent sets no session ID)"
          : "only an agent's session makes a reservation"
      }, so other sessions are not stopped from advancing it`,
    );
    return undefined;
  }
  await write(ctx, id, session, warnings);
  if ("plan" in target && decision.takenOver) {
    const localDir = ctx.repo.localDir;
    for (const ticket of target.plan.tickets) {
      const record = await readReservation(localDir, ticket);
      if (record && record.session !== session) await dropReservation(ctx, ticket);
    }
  }
  return undefined;
}
