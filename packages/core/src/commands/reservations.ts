// 進め始める Plan とチケットの予約（deguboard-local/reservations/<チケットか Plan の ID>.json。PL-7。t1149）。
// 承認された Plan のチケットは claim されるまで todo のままで、claim の記録（claim-sessions.ts。t1148）ではまだ止められない。
// そこで、進め始めるセッションが `plan show <p> --reserve`・`next <ticket> --reserve` で Plan（そのチケット）を予約し、
// 別のセッションの agent の claim と `dg next` を止める。見るだけの呼び出し（--reserve なし）は予約を作らない。
// 記録の形と置き方（このマシンだけ・Git に入れない）は claim の記録と同じで、効くか・拒むかも同じ関数
// （claim-judge.ts の sessionClaimHolds・decideSessionClaim）が決める。ここは記録とフックの時刻を読み書きするだけ。
// 予約の読む・決める・書くは deguboard-local/locks/reservations のロックで直列にする。
// 予約せずに claim した agent のセッションにも、claim が push の前にチケットの予約を書く（reserveForClaim。t1158）

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UsageError } from "../errors.js";
import { withLock } from "../git/lock.js";
import {
  claimRejectionError,
  decideClaimReservation,
  decideReservationRollback,
  decideSessionClaim,
  holdingReservation,
  type ClaimRejection,
  type ReservationCandidate,
  type SessionClaim,
  type SessionClaimDecision,
  type SessionClaimFacts,
  type SessionOperation,
} from "./claim-judge.js";
import {
  readSessionClaim,
  readSessionRecord,
  removeSessionRecord,
  writeSessionRecord,
} from "./claim-sessions.js";
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
      "With --reserve, take over what another live session of yours reserved: the reservation moves to the calling session. Tickets that the other session already claimed stay with it through its claim record, also after a Plan's reservation moves; taking one of them over needs dg ticket claim <ticket> --take-over. Use when that session has stopped or a person told you to take the work over",
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

/** 操作の対象：チケットか、Plan そのもの（`plan show <p> --reserve`） */
type Subject = { ticket: TicketId } | { plan: Plan };

const idOf = (subject: Subject): string => ("plan" in subject ? subject.plan.id : subject.ticket);

/**
 * 対象の予約とフックの時刻を読み、対象への操作を止めるかを claim の記録と同じ関数で決める。記録は変えない。
 * チケットに効きうる予約は優先の順（チケット自身、それを含む開いた Plan）に渡し、チケットの claim の記録が呼んだセッションの
 * ものなら予約では止めない（holdingReservation）。todo のチケットの claim の記録は前の作業の周期のものなので、渡しても数えない（fresh）
 */
const judge = async (
  ctx: CommandContext,
  subject: Subject,
  operation: SessionOperation,
  input: CallerInput,
): Promise<SessionClaimDecision> =>
  decideSessionClaim(await factsOf(ctx, subject, operation, input));

/** judge が決めるのに使う事実（記録とフックの時刻を読むだけ）。record は対象に効いている予約 */
async function factsOf<O extends SessionOperation>(
  ctx: CommandContext,
  subject: Subject,
  operation: O,
  input: CallerInput,
): Promise<SessionClaimFacts & { operation: O }> {
  const localDir = ctx.repo.localDir;
  const id = idOf(subject);
  const plan = "plan" in subject ? undefined : openPlanOf(ctx.store, subject.ticket);
  const candidates: ReservationCandidate[] = [];
  for (const target of plan ? [id, plan.id] : [id]) {
    const record = await readReservation(localDir, target);
    if (record)
      candidates.push({ target, record, ...(await hookTimesOf(localDir, record.session)) });
  }
  const clock = { now: ctx.now(), idleMs: CRASHED_SUBAGENT_IDLE_MS };
  const session = sessionOf(ctx, input.session);
  const claim = "plan" in subject ? undefined : await readSessionClaim(localDir, subject.ticket);
  const fresh =
    "ticket" in subject && ctx.store.tickets.get(subject.ticket)?.data.status === "todo";
  const held = holdingReservation(candidates, clock, { claim, session, fresh });
  return {
    ticket: id,
    operation,
    record: held?.record,
    ...(held ? { reserved: held.target } : {}),
    lastHookAt: held?.lastHookAt,
    endedAt: held?.endedAt,
    ...clock,
    actorKind: ctx.actor.kind,
    session,
    takeOver: input.take_over === true,
  };
}

/**
 * 予約を読んで決めてから書くまでを直列にするロック（deguboard-local/locks/reservations）。ないと、同じ対象を同時に予約した
 * 2 つのセッションがどちらも「予約なし」を読んで通り、両方が進める手を受け取る
 */
async function withReservationLock<T>(ctx: CommandContext, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.join(ctx.repo.localDir, "locks"), { recursive: true });
  return withLock(ctx.repo.localDir, RESERVATIONS_DIR, fn);
}

/** --reserve のない `dg next` を、別のセッションの予約で止めるかを決める（止めるなら拒否の決定を返す。記録は変えない） */
export const judgeReservedNext = (ctx: CommandContext, ticket: TicketId) =>
  judge(ctx, { ticket }, "next", {});

/** claim が push の前に書いたチケットの予約（record）と、書く前にあった予約（previous。なければ undefined） */
export interface ClaimReservation {
  ticket: TicketId;
  record: SessionClaim;
  previous: SessionClaim | undefined;
}

/**
 * claim（start は todo の新しい claim、claim はもう一度の claim）を、別のセッションの予約で止め、通すときはチケットの予約を
 * 呼んだセッションのものとして書く（書くかは claim-judge.ts の decideClaimReservation）。拒否は dg のエラーを投げ、通すときの
 * 知らせは warnings に足す。書いたら、書いた予約を返す（claim が取れなかったときに rollbackClaimReservation で戻す）。
 * 読む・決める・書くは予約のロックの中で行い、claim の push の前に終える。予約せずに claim したセッションも push の前に予約を
 * 持つので、push の間の別のセッションの `next --reserve` と claim は、この予約で止まる（t1158）。
 * ロックは書いたら放し、push の間は持たない。取り込みと push（それぞれ上限 60 秒）の間も持つと、ロックの待ち時間（10 秒）を
 * 超え、別のセッションの `next --reserve`・`plan show --reserve` が失敗する
 */
export const reserveForClaim = (
  ctx: CommandContext,
  ticket: TicketId,
  operation: "start" | "claim",
  input: CallerInput,
  warnings: string[],
): Promise<ClaimReservation | undefined> =>
  withReservationLock(ctx, async () => {
    const facts = await factsOf(ctx, { ticket }, operation, input);
    const session = facts.session;
    const recordable =
      ctx.actor.kind === "agent" && session !== undefined && SESSION_ID.test(session);
    const decision = decideClaimReservation({ ...facts, recordable });
    if (decision.kind === "reject") throw claimRejectionError(decision, false);
    if (decision.warning) warnings.push(decision.warning);
    if (!decision.write || session === undefined) return undefined;
    const previous = await readReservation(ctx.repo.localDir, ticket);
    const record = await write(ctx, ticket, session, warnings);
    return record ? { ticket, record, previous } : undefined;
  });

/**
 * claim の前に書いた予約を、claim が取れなかったとき（拒否・push の失敗・取り込み直しの途中のエラー）に戻す（戻し方は
 * claim-judge.ts の decideReservationRollback）。残すと、claim していないセッションの予約が別のセッションを止め続ける。
 * 読む・決める・戻すは予約のロックの中で行う。claim の失敗を伝えるのが先なので、戻せなくても失敗させない。
 * dg が push の途中で落ちたときは戻せずに予約が残るが、`next --reserve` で予約したのと同じ状態で、同じセッションはもう一度
 * claim でき、予約は SessionEnd か 30 分で無視される
 */
export async function rollbackClaimReservation(
  ctx: CommandContext,
  written: ClaimReservation,
): Promise<void> {
  const localDir = ctx.repo.localDir;
  await withReservationLock(ctx, async () => {
    const rollback = decideReservationRollback({
      written: written.record,
      previous: written.previous,
      current: await readReservation(localDir, written.ticket),
    });
    if (rollback.kind === "remove")
      await removeSessionRecord(localDir, RESERVATIONS_DIR, written.ticket);
    if (rollback.kind === "restore")
      await writeSessionRecord(
        localDir,
        RESERVATIONS_DIR,
        written.ticket,
        rollback.record,
        ctx.now(),
      );
  }).catch(() => undefined);
}

/** 対象の予約を、呼んだセッションのものとして書き、書いた記録を返す。書けなくても失敗させずに警告する（undefined を返す） */
async function write(
  ctx: CommandContext,
  target: string,
  session: string,
  warnings: string[],
): Promise<SessionClaim | undefined> {
  const record = { session, claimed_at: nowIso(ctx) };
  try {
    await writeSessionRecord(ctx.repo.localDir, RESERVATIONS_DIR, target, record, ctx.now());
    return record;
  } catch (e) {
    warnings.push(
      `Could not record the reservation of ${target} (${e instanceof Error ? e.message : String(e)}), so another session of yours is not stopped from advancing it`,
    );
    return undefined;
  }
}

/** 対象の予約を消す（unclaim したチケットと閉じた Plan。なくてもよく、消せなくても失敗させない） */
export async function dropReservation(ctx: CommandContext, target: string): Promise<void> {
  await removeSessionRecord(ctx.repo.localDir, RESERVATIONS_DIR, target).catch(() => undefined);
}

/**
 * `plan show <p> --reserve`・`next <ticket> --reserve`：呼んだセッションが Plan（そのチケット）を予約する。
 * 別のセッションの予約が効いていれば、予約を変えずに拒否の決定を返す（--take-over で越えて予約を移す）。
 * 予約するのはセッションがわかる agent だけ。人とセッションがわからない呼び出しは予約を作らず、そのことを知らせる。
 * Plan を引き継いだら、その Plan のチケットに残る別のセッションの予約も消す（チケットの予約が Plan の予約より先に効くため）。
 * 読む・決める・書くはロックの中で行い、同時の予約は片方だけが通る（withReservationLock）
 */
export const reserve = (
  ctx: CommandContext,
  target: Subject,
  input: CallerInput,
  warnings: string[],
): Promise<ClaimRejection | undefined> =>
  withReservationLock(ctx, () => reserveLocked(ctx, target, input, warnings));

async function reserveLocked(
  ctx: CommandContext,
  target: Subject,
  input: CallerInput,
  warnings: string[],
): Promise<ClaimRejection | undefined> {
  const id = idOf(target);
  const decision = await judge(ctx, target, "reserve", input);
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
