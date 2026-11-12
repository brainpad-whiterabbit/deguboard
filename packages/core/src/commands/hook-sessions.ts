// フックが届いたセッションの記録（deguboard-local/hook-sessions/<session>.json。t697）。
// フックの命令がハーネスの環境で動かない（PATH に node がないなど）と、dg hook は呼ばれず、サブエージェントの Run は黙って記録されない。
// dg hooks check がハンドラを dg 自身の環境で確かめても、ハーネスの環境とは PATH が違いうるので当てにならない。
// そこで、届いたことそのものを記録し、印で Run を任せる操作（next・brief・claim --no-run）がこのセッションに届いていなければ警告する。
// 届いていれば、実装と手直しはいつもサブエージェントに頼むので、next は親が自分で進める道を案内せず、--no-run なしの claim と run start の implement・fix は警告する（t713・t717）。
// 判定は SessionStart に限らず、このセッションのどのフックでもよい（セッションの途中で dg hooks install したときも、次のツールの PreToolUse で届く）
//
// フックの中の警告は終了コード 0 で標準エラーに出るだけで、エージェントにも人にも届かない。そこで、セッションごとに警告を書き残し、
// まだ知らせていないものを next・brief・hooks check が知らせる（t756）。「届く」はどれか 1 種類で真になるので、届いたフックの種類も
// セッションごとに残し、印で Run を開いたのに SubagentStop が届かないセッションを警告にする（Run が閉じないまま誰も気づかないため）。
// ファイルは種類ごと・警告ごとに分け、同時に動くフック（並べたツールの PreToolUse など）が読んで書き直す競合で記録を落とさない：
//   <session>.json（届いた時刻）・<session>.kind-<種類>.json（その種類が届いた時刻）・<session>.marked.jsonl（印で開いた起動。1 件 1 行）・
//   <session>.stop-warned（SubagentStop の警告を書いた印）・<session>.warnings.jsonl（警告。1 件 1 行）・<session>.reported（知らせた警告の終わりの位置）

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectAgent, hooksOf, sessionFromEnv, type AgentEnv } from "../agents/index.js";
import { REVIEW_STEP, type Run } from "../model/run.js";

const HOOK_SESSIONS_DIR = "hook-sessions";
/** 残す日数。SessionStart のたびに、これより古い記録を消す */
const KEEP_DAYS = 30;
/** ファイル名に使えるセッション ID。ほかの形はパスを組み立てずに記録しない */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 一度に知らせる警告の数。これより多ければ新しいものだけを出し、残りの数を添える */
const REPORT_LIMIT = 10;
const WARNINGS_SUFFIX = ".warnings.jsonl";
const KIND_PREFIX = ".kind-";
/** SubagentStop にあたる出来事の種類（HookEvent の kind） */
const SUBAGENT_STOPPED = "subagent_stopped";

const dirOf = (localDir: string) => path.join(localDir, HOOK_SESSIONS_DIR);
const fileOf = (localDir: string, session: string, suffix = ".json") =>
  path.join(dirOf(localDir), `${session}${suffix}`);

/**
 * このセッションにフックが届いたことと、届いた出来事の種類（HookEvent の kind）を記録する。
 * 中身は時刻だけで、入力の値は残さない（MT-4）
 */
export async function recordHookSession(
  localDir: string,
  session: string,
  receivedAt: string,
  kind?: string,
): Promise<void> {
  if (!SESSION_ID.test(session)) return;
  await mkdir(dirOf(localDir), { recursive: true });
  const body = `${JSON.stringify({ received_at: receivedAt })}\n`;
  await Promise.all([
    writeFile(fileOf(localDir, session), body),
    ...(kind && /^[a-z_]+$/.test(kind)
      ? [writeFile(fileOf(localDir, session, `${KIND_PREFIX}${kind}.json`), body)]
      : []),
  ]);
}

/** このセッションに届いた出来事の種類（HookEvent の kind）。記録がなければ空 */
export async function hookKindsOf(localDir: string, session: string): Promise<string[]> {
  if (!SESSION_ID.test(session)) return [];
  const prefix = `${session}${KIND_PREFIX}`;
  const names = await readdir(dirOf(localDir)).catch(() => [] as string[]);
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => n.slice(prefix.length, -".json".length))
    .sort();
}

/** フックの中で出た警告を、このセッションの警告に書き足す（1 件 1 行。追記なので同時に動くフックの記録を落とさない） */
export async function recordHookWarnings(
  localDir: string,
  session: string,
  event: string,
  at: string,
  warnings: readonly string[],
): Promise<void> {
  if (!SESSION_ID.test(session) || warnings.length === 0) return;
  await mkdir(dirOf(localDir), { recursive: true });
  await appendFile(
    fileOf(localDir, session, WARNINGS_SUFFIX),
    warnings.map((text) => `${JSON.stringify({ at, event, text })}\n`).join(""),
  );
}

/**
 * まだ知らせていないフックの警告を、すべてのセッションから古い順に取り出し、知らせたことにする（t756）。
 * 呼んだセッションに限らないのは、セッションの終わりに書いた警告を次のセッションで知らせるため（同じマシンの deguboard-local だけを読む）。
 * 知らせた位置はセッションごとに、読んだ行の終わりのバイト数で残す（書きかけの最後の行は次に回す）。
 * 同時に呼ぶと同じ警告を二度知らせうるが、落とすことはない
 */
export async function takeHookWarnings(localDir: string): Promise<string[]> {
  const names = await readdir(dirOf(localDir)).catch(() => [] as string[]);
  const found: Array<{ at: string; line: string }> = [];
  for (const name of names.filter((n) => n.endsWith(WARNINGS_SUFFIX))) {
    const session = name.slice(0, -WARNINGS_SUFFIX.length);
    if (!SESSION_ID.test(session)) continue;
    const text = await readFile(fileOf(localDir, session, WARNINGS_SUFFIX), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) continue;
    const reportedFile = fileOf(localDir, session, ".reported");
    const from = Number.parseInt(
      (await readFile(reportedFile, "utf8").catch(() => "0")).trim(),
      10,
    );
    const bytes = Buffer.from(text, "utf8");
    const start = Number.isFinite(from) && from >= 0 && from <= bytes.length ? from : 0;
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (end <= start) continue;
    for (const raw of bytes.subarray(start, end).toString("utf8").split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const d = JSON.parse(raw) as { at?: unknown; event?: unknown; text?: unknown };
        if (typeof d.text !== "string") continue;
        const at = typeof d.at === "string" ? d.at : "";
        const event = typeof d.event === "string" ? d.event : "?";
        found.push({ at, line: `dg hook ${event} (${at}, session ${session}): ${d.text}` });
      } catch {
        // 読めない行は飛ばす
      }
    }
    await writeFile(reportedFile, `${end}\n`).catch(() => undefined);
  }
  found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (found.length <= REPORT_LIMIT) return found.map((f) => f.line);
  const skipped = found.length - REPORT_LIMIT;
  return [
    `${skipped} earlier warning(s) from dg hooks are not shown (they are in ${dirOf(localDir)})`,
    ...found.slice(-REPORT_LIMIT).map((f) => f.line),
  ];
}

/** 印で Run を開いた起動を、このセッションの記録に書き足す。foreground は前景の起動（終わってから返る） */
export async function recordMarkedLaunch(
  localDir: string,
  session: string,
  at: string,
  foreground: boolean,
): Promise<void> {
  if (!SESSION_ID.test(session)) return;
  await mkdir(dirOf(localDir), { recursive: true });
  await appendFile(
    fileOf(localDir, session, ".marked.jsonl"),
    `${JSON.stringify({ at, foreground })}\n`,
  );
}

/**
 * 印で Run を開いたのに、このセッションに SubagentStop が 1 つも届いていなければ警告を返す（セッションごとに 1 回。t756）。
 * SubagentStop は印のないサブエージェントでも届くので、1 つでも届いていれば警告しない。届かないと言えるのは、
 *   - 前景の起動を開いたとき（SubagentStop は前景の起動の結果より先に来る）
 *   - 印で開いた起動が 2 つ目になったとき（前の起動が止まっていても届いていない見込みが高い）
 *   - セッションが終わるとき（ending）
 * のどれか。バックグラウンドの起動 1 つだけでは、まだ動いているのと見分けられないので待つ
 */
export async function subagentStopMissingWarning(
  localDir: string,
  session: string,
  opts: { foreground?: boolean; ending?: boolean },
): Promise<string | undefined> {
  if (!SESSION_ID.test(session)) return undefined;
  if ((await hookKindsOf(localDir, session)).includes(SUBAGENT_STOPPED)) return undefined;
  const launches = (
    await readFile(fileOf(localDir, session, ".marked.jsonl"), "utf8").catch(() => "")
  )
    .split("\n")
    .filter((l) => l.trim() !== "").length;
  if (launches === 0) return undefined;
  if (!opts.ending && !opts.foreground && launches < 2) return undefined;
  // 一度だけ書く。印のファイルがもうあれば書かない（同時に来たフックでも 1 回）
  const wrote = await writeFile(fileOf(localDir, session, ".stop-warned"), "", { flag: "wx" }).then(
    () => true,
    () => false,
  );
  if (!wrote) return undefined;
  return `No SubagentStop hook has reached this session (${session}), although ${launches} sub-agent(s) were started with the marker. A Run that the marker opened for a background sub-agent is not closed when the sub-agent stops (it stays open until the session ends, and its usage and time may not be counted). The SubagentStop hook may be missing from the settings, or its command may not run in the agent's environment. Check with dg hooks check`;
}

/** KEEP_DAYS より前に書いた記録（どのファイルも）を消す。消せないものは残す（次の機会に消す） */
export async function pruneHookSessions(localDir: string, now: Date): Promise<void> {
  const dir = dirOf(localDir);
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
 * フックが届くセッションで、親が自分で実装・手直しの Run を開いたときの警告（t713・t717）。
 * agent が --no-run なしに claim（もう一度の claim を含む）したとき（opened: "claim"）と、run start で implement・fix を開いたとき（opened: "run start"）に使う。
 * 親が自分で開く Run は親の長い文脈を読み直す分が使用量に入り、サブエージェントの Run と比べられないので、
 * 実装と手直しはモデルが親と同じでも小さな手直しでもサブエージェントに頼む。Run の開き方は変えない（知らせるだけ）。
 * フックが届かないセッションでは印で頼んでも Run が開かないので、親が自分で進める道を残し、警告しない
 */
export async function selfRunWarning(
  localDir: string,
  env: AgentEnv,
  ticket: string,
  opened: "claim" | "run start" = "claim",
): Promise<string | undefined> {
  if (!(await hooksReachSession(localDir, env))) return undefined;
  const how =
    opened === "claim"
      ? "claim with --no-run (a fix needs no claim) and pass the brief from dg next (it has the mark)"
      : "next time, pass the brief from dg next instead of run start (it has the mark, and the hook opens and closes the Run)";
  const made =
    opened === "claim"
      ? "The claim and its Run were made as asked"
      : "This Run was opened as asked";
  return `dg hooks reach this session, so ask a sub-agent to implement or fix ${ticket} instead of doing it yourself, even when the model is the parent's and the fix is small: ${how}. A Run the parent opens itself counts the parent's long context in its usage. ${made}`;
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
