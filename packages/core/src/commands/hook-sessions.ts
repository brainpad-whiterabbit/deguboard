// フックが届いたセッションの記録（deguboard-local/hook-sessions/<session>.json。t697）。
// フックの命令がハーネスの環境で動かない（PATH に node がないなど）と、dg hook は呼ばれず、サブエージェントの Run は黙って記録されない。
// dg hooks check がハンドラを dg 自身の環境で確かめても、ハーネスの環境とは PATH が違いうるので当てにならない。
// そこで、届いたことそのものを記録し、印で Run を任せる操作（next・brief・claim --no-run）がこのセッションに届いていなければ警告する。
// 届いていれば、実装と手直しはいつもサブエージェントに頼むので、next は親が自分で進める道を案内せず、--no-run なしの claim は警告する（t713）。
// 判定は SessionStart に限らず、このセッションのどのフックでもよい（セッションの途中で dg hooks install したときも、次のツールの PreToolUse で届く）

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectAgent, hooksOf, sessionFromEnv, type AgentEnv } from "../agents/index.js";
import { REVIEW_STEP, type Run } from "../model/run.js";

const HOOK_SESSIONS_DIR = "hook-sessions";
/** 残す日数。SessionStart のたびに、これより古い記録を消す */
const KEEP_DAYS = 30;
/** ファイル名に使えるセッション ID。ほかの形はパスを組み立てずに記録しない */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const fileOf = (localDir: string, session: string) =>
  path.join(localDir, HOOK_SESSIONS_DIR, `${session}.json`);

/** このセッションにフックが届いたことを記録する。中身は時刻だけで、入力の値は残さない（MT-4） */
export async function recordHookSession(
  localDir: string,
  session: string,
  receivedAt: string,
): Promise<void> {
  if (!SESSION_ID.test(session)) return;
  await mkdir(path.join(localDir, HOOK_SESSIONS_DIR), { recursive: true });
  await writeFile(fileOf(localDir, session), `${JSON.stringify({ received_at: receivedAt })}\n`);
}

/** KEEP_DAYS より前に書いた記録を消す。消せないものは残す（次の機会に消す） */
export async function pruneHookSessions(localDir: string, now: Date): Promise<void> {
  const dir = path.join(localDir, HOOK_SESSIONS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const before = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      const s = await stat(file).catch(() => undefined);
      if (s && s.mtimeMs < before) await rm(file, { force: true }).catch(() => undefined);
    }),
  );
}

/** このセッションにフックが届いたか */
export async function hookReachedSession(localDir: string, session: string): Promise<boolean> {
  if (!SESSION_ID.test(session)) return false;
  return stat(fileOf(localDir, session)).then(
    () => true,
    () => false,
  );
}

/**
 * フックを持つエージェントの中から呼ばれ、そのセッションにフックが届いているか（t713）。
 * エージェントを判定できない・フックを持たない・セッション ID を読めないときは、届くとは言えないので false
 */
export async function hooksReachSession(localDir: string, env: AgentEnv): Promise<boolean> {
  const { agent } = detectAgent(env);
  if (!agent || !hooksOf(agent)) return false;
  const session = sessionFromEnv(env);
  return session ? hookReachedSession(localDir, session) : false;
}

/**
 * フックが届くセッションで、agent が --no-run なしに claim（もう一度の claim を含む）したときの警告（t713）。
 * 親が自分で開く Run は親の長い文脈を読み直す分が使用量に入り、サブエージェントの Run と比べられないので、
 * 実装と手直しはモデルが親と同じでも小さな手直しでもサブエージェントに頼む。claim と Run の開き方は変えない（知らせるだけ）。
 * フックが届かないセッションでは印で頼んでも Run が開かないので、親が自分で進める道を残し、警告しない
 */
export async function selfRunWarning(
  localDir: string,
  env: AgentEnv,
  ticket: string,
): Promise<string | undefined> {
  if (!(await hooksReachSession(localDir, env))) return undefined;
  return `dg hooks reach this session, so ask a sub-agent to implement or fix ${ticket} instead of doing it yourself, even when the model is the parent's and the fix is small: claim with --no-run (a fix needs no claim) and pass the brief from dg next (it has the mark). A Run the parent opens itself counts the parent's long context in its usage. The claim and its Run were made as asked`;
}

/**
 * フックを持つエージェントの中から呼ばれ、そのセッションにまだフックが 1 つも届いていなければ警告を返す。
 * エージェントを判定できない・フックを持たない・セッション ID を読めないときは判定できないので undefined。
 * 見つかった警告の文は、使用量と時間は残らないが見直しの結果は残る、と知らせる（見直しは保留から記録に変わる。t702）
 */
export async function hooksSilentWarning(
  localDir: string,
  env: AgentEnv,
): Promise<string | undefined> {
  const { agent } = detectAgent(env);
  if (!agent || !hooksOf(agent)) return undefined;
  const session = sessionFromEnv(env);
  if (!session || (await hookReachedSession(localDir, session))) return undefined;
  return `No dg hook has reached this ${agent} session (${session}), so the Runs of sub-agents started with the marker will not be recorded: their usage and time are not kept, but a review result is still kept as a review (capture: none; dg next and dg gate count it). The command the hooks call may not run in the agent's environment (for example, node is not on its PATH). Check with dg hooks check`;
}

/**
 * フックを持つエージェントが、フックの結び付かなかった見直しの記録（capture: none。持ち主のない保留か、それを sync・pr ready が
 * 書いたもの）を、作業ブランチ（since）の後の見直しとして数えたときに警告を返す（t702）。
 * 見直しは数えられたが Run はフックが結ばなかった、という事実を知らせる。フックを持たない・判定できないエージェントでは
 * その記録が正常な形なので undefined
 */
export function unlinkedReviewWarning(
  env: AgentEnv,
  ticket: string,
  reviews: readonly Run[],
  since: string | undefined,
): string | undefined {
  const { agent } = detectAgent(env);
  if (!agent || !hooksOf(agent)) return undefined;
  const count = reviews.filter(
    (r) =>
      r.step === REVIEW_STEP &&
      r.capture === "none" &&
      r.ticket === ticket &&
      r.started_at >= (since ?? ""),
  ).length;
  if (count === 0) return undefined;
  return `${count} review result(s) of ${ticket} were counted as review(s) with no Run linked by a dg hook (capture: none), so the hook did not record their Run and their usage and time are not kept. Check with dg hooks check`;
}
