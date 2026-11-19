// claim したセッションの記録（deguboard-local/claim-sessions/<チケット>.json。SY-5。t1148）。
// 同じユーザのセッションは主体の ID がどれも `<ユーザ>/agent` なので、あるセッションが claim して進めているチケットに、別のセッションが
// もう一度の claim（手直しの始まり）や unclaim をできてしまう。そこで agent の claim が呼んだセッションをこのマシンに記録し、
// 別のセッションのその操作を止める。Git のデータの形は変えず、排他そのものは今までどおり claim の push で決まる（ADR-028）。
// 記録したセッションが生きているかは、すでにあるフックの記録（hook-sessions/）で見て、監視は足さない。
// ここは記録とフックの時刻を読み書きするだけで、拒むか・記録が効くかは何も読まない claim-judge.ts の decideSessionClaim が決める。
// 記録を書くのは claim の push が成功した後（取れなかった claim で記録を残さない）。もう一度の claim は書き込みがないので、通ったときに書く

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { claimRejectionError, decideSessionClaim, type SessionClaim } from "./claim-judge.js";
import type { CommandContext } from "./define.js";
import { nowIso } from "./helpers.js";
import { SESSION_ID } from "./hook-records.js";
import { hookTimesOf } from "./hook-sessions.js";
import { CRASHED_SUBAGENT_IDLE_MS, sessionOf } from "./run.js";

const CLAIM_SESSIONS_DIR = "claim-sessions";
/** 残す日数。記録を書くたびに、これより古い記録を消す（効くのは最後の知らせから 30 分なので、残っていても判定には使われない） */
const KEEP_DAYS = 30;

const dirOf = (localDir: string) => path.join(localDir, CLAIM_SESSIONS_DIR);
const fileOf = (localDir: string, ticket: string) => path.join(dirOf(localDir), `${ticket}.json`);

/** チケットの記録。なければ・読めなければ undefined */
export async function readSessionClaim(
  localDir: string,
  ticket: string,
): Promise<SessionClaim | undefined> {
  const text = await readFile(fileOf(localDir, ticket), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const d = JSON.parse(text) as Partial<SessionClaim>;
    return typeof d.session === "string" && typeof d.claimed_at === "string"
      ? { session: d.session, claimed_at: d.claimed_at }
      : undefined;
  } catch {
    return undefined;
  }
}

/** チケットの記録を消す（なくてもよい） */
async function removeSessionClaim(localDir: string, ticket: string): Promise<void> {
  await rm(fileOf(localDir, ticket), { force: true });
}

/** KEEP_DAYS より前に書いた記録を消す。消せないものは残す（次の機会に消す） */
async function pruneSessionClaims(localDir: string, now: Date): Promise<void> {
  const dir = dirOf(localDir);
  const before = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      const s = await stat(file).catch(() => undefined);
      if (s && s.mtimeMs < before) await rm(file, { force: true }).catch(() => undefined);
    }),
  );
}

/** チケットの記録を書く。一時ファイルに書いてから置き換え、読む側が途中の内容を見ないようにする */
async function writeSessionClaim(
  localDir: string,
  ticket: string,
  record: SessionClaim,
): Promise<void> {
  await mkdir(dirOf(localDir), { recursive: true });
  const file = fileOf(localDir, ticket);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8");
  await rename(tmp, file);
}

/**
 * もう一度の claim・unclaim を、別のセッションの記録で止める（SY-5）。拒否は dg のエラーを投げ、通すときの知らせは warnings に足す。
 * 記録は変えない（通った後に recordSessionClaim・dropSessionClaim で書く）
 */
export async function guardSessionClaim(
  ctx: CommandContext,
  ticket: string,
  operation: "claim" | "unclaim",
  input: { session?: string | undefined; take_over?: boolean | undefined },
  warnings: string[],
): Promise<void> {
  const localDir = ctx.repo.localDir;
  const record = await readSessionClaim(localDir, ticket);
  if (!record) return;
  const decision = decideSessionClaim({
    ticket,
    operation,
    record,
    ...(await hookTimesOf(localDir, record.session)),
    now: ctx.now(),
    idleMs: CRASHED_SUBAGENT_IDLE_MS,
    actorKind: ctx.actor.kind,
    session: sessionOf(ctx, input.session),
    takeOver: input.take_over === true,
  });
  if (decision.kind === "reject") throw claimRejectionError(decision, false);
  if (decision.warning) warnings.push(decision.warning);
}

/**
 * 通った claim（新しい claim ともう一度の claim）の後に、呼んだセッションがこのチケットを進めていると記録する。
 * 記録するのはセッションがわかる agent の claim だけ。人の claim とセッションがわからない claim は記録を作らず、新しい claim なら
 * 前の作業の記録を消す（fresh。残すと、前の作業のセッションが次の作業のもう一度の claim を止める）。もう一度の claim では記録を変えない。
 * claim は済んでいるので、書けなくても失敗させずに警告する
 */
export async function recordSessionClaim(
  ctx: CommandContext,
  ticket: string,
  input: { session?: string | undefined; fresh: boolean },
  warnings: string[],
): Promise<void> {
  const localDir = ctx.repo.localDir;
  const session = ctx.actor.kind === "agent" ? sessionOf(ctx, input.session) : undefined;
  try {
    if (session !== undefined && SESSION_ID.test(session)) {
      await writeSessionClaim(localDir, ticket, { session, claimed_at: nowIso(ctx) });
      await pruneSessionClaims(localDir, ctx.now());
    } else if (input.fresh) {
      await removeSessionClaim(localDir, ticket);
    }
  } catch (e) {
    warnings.push(
      `Could not record the session that claimed ${ticket} (${e instanceof Error ? e.message : String(e)}), so another session of yours is not stopped from claiming it again or unclaiming it`,
    );
  }
}

/** unclaim の後に記録を消す（claim がなくなったので、進めているセッションもない）。消せなくても失敗させない */
export async function dropSessionClaim(ctx: CommandContext, ticket: string): Promise<void> {
  await removeSessionClaim(ctx.repo.localDir, ticket).catch(() => undefined);
}
