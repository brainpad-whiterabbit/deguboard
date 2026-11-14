// harness のフックの出来事を Run の操作に写す（AG-1・AG-9・AG-10・RN-6〜RN-8、ADR-025）。入力の形は Adapter の hooks.parse が製品ごとに読み、
// ここは製品によらない出来事（HookEvent）だけを見る（AG-5）。フックはエージェントの作業を止めないよう、失敗は警告にして成功で返す。
//   - session_start：以後の Bash の環境に DEGUBOARD_ACTOR=agent・DEGUBOARD_SESSION・DEGUBOARD_TRANSCRIPT を export で書く
//     （届くのは親の Bash だけ。サブエージェントの claim・run start のセッションは Adapter の sessionFromEnv が補う）
//   - subagent_launched：頼んだ文の先頭の印（deguboard: ticket=<id> step=<step>）があれば、その Run を開いて記録の場所をサブエージェントの記録にする（RN-7）。
//     同じチケットで落ちたセッションに残った Run を先に interrupted で閉じる（見直しの起動は別のセッションの見直しの Run、
//     どの起動も別のセッションのサブエージェントの記録が古い Run。closeStaleRuns）。
//     前景の見直し役が動いている間に、その保留から sync・pr ready が見直しの記録（capture: none）を書いていたら、開かずにその記録を引き取る。
//     開いたままの前の手直しの Run は、ほかの Run を開くときと同じく openRun が区切りとして閉じる（引き取るときも同じ区切りで閉じる。RN-6）。
//     バックグラウンドの起動は、止まるまで動いている印（live）を付ける。印のある間は run finish が interrupted のほかで閉じない（RN-7）
//   - subagent_started：同じ記録の開いた Run（親への質問で止まっていたもの）を続きとして使い、止まって待っている印と書き終わり待ちの印を消し、動いている印を付ける
//   - subagent_stopped：記録の場所で Run を引き、記録の最初の文の印で照らしてから、step を終えた事実があれば記録の書き終わりを待って
//     記録の全体から数えて閉じる。事実がなければ閉じずに止まって待っている印を付ける。
//     前景のサブエージェントが Run のないうちに保留にした見直しの結果とやり直しの理由は、閉じる前の Run に結び付ける。
//     印のある Run がなければ、サブエージェントが自分で開いた Run（記録に ID が出る。run start で開いたものなど）に記録の場所を結び付け、
//     事実がなければ止まって待っている印を付ける（bindSelfOpened。消してよい条件はその関数のコメント）
//   - session_end：このセッションのサブエージェントの Run のうち開いたままのものをすべて閉じる。親が自分で開いた Run は残す
//   - tool_requested：.git/deguboard/ への書き込みと、dg を経由しない gh pr ready・merge を粗く拒む（ストアを開かない。t554）。
//     記録と判定は pre-tool-use.ts にあり、2 つの入口（bin/dg.js と同梱の dg.mjs の入口 cli/src/bundle.ts）の速い経路（fast-hook.ts）も
//     同じものを呼ぶ（t768・t769）。ツールのたびに呼ばれるので、止まった Run の掃除はしない
//   - turn_stopped：データのリポジトリの dg の外の変更（SY-7）を確かめ、見つけたら止まらずに続けさせて伝える（続けさせた後の Stop では伝えない）。
//     ストアを開かず（t770）、config のリモートの名前だけを読む文脈で確かめる（storelessRemote）。Stop は応答のたびに呼ばれ、ストアを開くと遅いため。
//     記録と確かめは turn-stopped.ts にあり、2 つの入口の速い経路も同じものを呼ぶ（t786）。
//     dg の外の変更の検査は、ほかのイベントでは runCommand でも行わない（フックで作業を止めない。ownsOutsideCheck）
//   どのイベントでも、扱うイベントなら読む項目の有無と時刻を deguboard-local/hook-inputs/ に残す（t542。dg hooks check が読む）。
//   届いた出来事の種類と、フックの中で出た警告は deguboard-local/hook-sessions/ にセッションごとに残し、next・brief・hooks check が後で知らせる（t756）
//   どのフックの後も、前のフックで書き終わりを待ちきれずに残した Run を閉じる（dg sync も同じ）

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { collectRunUsage, hookAgentNames, hooksOf, type HookEvent } from "../agents/index.js";
import { OperationError } from "../errors.js";
import { collectBranchFacts, lastPushedAt } from "../git/facts.js";
import { withWrite } from "../git/write.js";
import { toIsoDateTime } from "../model/common.js";
import { ticketIdSchema, type TicketId } from "../model/id.js";
import { REVIEW_STEP, type Run, type RunId, type RunResult, type RunReview } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import {
  adoptPendingRounds,
  amendRunning,
  appendRetryReasons,
  bindTranscript,
  finishRun,
  moveReviewToPending,
  readRunningRuns,
  readTranscriptPaths,
  takePendingReview,
  takePendingReviewEntry,
  takePendingRetryReasons,
} from "../run/record.js";
import { defineCommand, ok, runCommand, type CommandContext } from "./define.js";
import { recordAroundHook } from "./hook-records.js";
import {
  pruneHookSessions,
  recordMarkedLaunch,
  subagentStopMissingWarning,
} from "./hook-sessions.js";
import { runToolRequested } from "./pre-tool-use.js";
import { runTurnStopped } from "./turn-stopped.js";
import { adoptableReviewRecord } from "./orphan-review.js";
import {
  closePreviousFixRunOrWarn,
  crashedSubagentRunAt,
  isSubagentTranscript,
  openedInOtherSession,
  openedStepOf,
  openRun,
  REVIEW_UNRECORDED,
  runRefresh,
  STALE_SESSION_ERROR,
  transcriptUnderRoot,
  usageContext,
} from "./run.js";

/** 頼んだ文の先頭の印。最初の空でない行が `deguboard: ticket=<id> step=<step>` のとき */
export function parseMarker(prompt: string): { ticket: TicketId; step: string } | undefined {
  const first = prompt.split(/\r?\n/).find((l) => l.trim() !== "");
  const m = /^\s*deguboard:\s*ticket=(\S+)\s+step=(\S+)\s*$/.exec(first ?? "");
  if (!m) return undefined;
  const ticket = ticketIdSchema.safeParse(m[1]);
  return ticket.success ? { ticket: ticket.data, step: m[2]! } : undefined;
}

/** シェルの単一引用符で囲む */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface HookView {
  event: string;
  /** 行ったこと（1 件 1 行） */
  done: string[];
  /** フックが標準出力に書く文（ツールの使用を拒むときの製品の形。Adapter の denyOutput が作る） */
  output?: string;
}

/** フックを持つエージェント名。省けば、フックを持つ Adapter が 1 つならそれ、なければ空 */
function hookAgentOf(agent: string | undefined): string {
  const names = hookAgentNames();
  return agent ?? (names.length === 1 ? names[0]! : "");
}

/** 入力の出来事の種類（扱わない入力・フックを持たない Adapter は undefined）。storeless の判定に使う */
function eventKindOf(
  input: {
    agent?: string | undefined;
    event: string;
    payload?: Record<string, unknown> | undefined;
  },
  env: Readonly<Record<string, string | undefined>>,
): HookEvent["kind"] | undefined {
  return hooksOf(hookAgentOf(input.agent))?.parse(input.event, input.payload ?? {}, env)?.kind;
}

export const hook = defineCommand({
  name: "hook",
  positionals: ["event"],
  group: "hook",
  summary:
    "Called by the harness hooks (dg hooks install writes them into the settings; people do not run it). Reads the hook input (JSON) from stdin with --payload -. At the start of a session, puts the actor, session ID, and record path into the environment. For a sub-agent whose prompt starts with the marker `deguboard: ticket=<id> step=<step>`, opens a Run when it starts " +
    "(if a Run for the same ticket and step is still open, it does not open one and warns. Before opening, it closes as interrupted the open Runs of the same ticket that are left over from a crashed session: for a review, a review Run from a different session; for any step, a Run of any step tied to the record of a sub-agent of a different session whose record has not been written for 30 minutes (a newer record is taken as a sub-agent still running in parallel, and a Run the parent opened itself, or one whose session is not known, is left open). A review result written to that Run after a foreground start is held and linked to the new Run. When a foreground reviewer returns and dg sync or dg pr ready has already written its held result as a review record (capture: none) in the same session after the start, it does not open a Run; it ties the transcript to that record, re-reads its usage, removes capture: none, and replaces its result with a result held after the record was written. In both cases, an earlier fix Run still open on the same ticket is closed at the start boundary, as run start does). When it stops, if the step was finished, it closes the Run (otherwise it marks the Run as stopped and waiting, and resuming continues it; a Run opened by the agent itself is the same). At the end of the session it closes the open Runs of that session's sub-agents. " +
    "Before a tool is used (PreToolUse), it rejects writes under .git/deguboard/ by writing tools, and Bash containing the word .git/deguboard (including read-only commands, and text inside quotes or comments), and points to dg's read and write commands instead " +
    "(writes that do not show the word are not seen; a miss is found as a change outside dg the next time dg runs, and at Stop). " +
    "It rejects gh pr ready and gh pr merge run outside dg (including the same operations through gh api) and points to dg pr ready and dg pr merge " +
    "(it does not read the PR argument. Without parsing the tokens, it stops if the rest, after removing dg pr ready, dg pr merge, and gh pr ready --undo, contains the words gh, pr, merge, or ready. " +
    "It does not hide text inside quotes, here-documents, or comments; it advises writing the body to a file and passing it with --body-file or git commit -F). " +
    "PreToolUse is called for every tool, so it decides only from the path and command string, without opening the store (tickets, Plans, Epics, Iterations, config), and does not check for changes outside dg. " +
    "When an agent finishes its response (Stop), it checks the data repository for changes outside dg (uncommitted changes, and commits with no dg mark) without opening the store, reading only the data remote's name from config; if it finds any, it keeps the agent going instead of stopping, and reports which files and how to restore or adopt them (dg adopt). A Stop after the agent was already kept going does not report them again. Other events do not stop work even when there are changes outside dg. " +
    "For each event it keeps, in deguboard-local/hook-inputs/, the presence of the input fields it reads and the time, as the latest one entry per event (no values are kept; dg hooks check reads it), and, in deguboard-local/hook-sessions/, the time a hook last reached each session and each kind of event that reached it (kept for 30 days; dg next, dg brief, and dg ticket claim --no-run warn when no hook has reached the calling session). " +
    "Other failures are turned into warnings and return success, so they do not stop work. The warnings are also kept per session in deguboard-local/hook-sessions/, and dg next, dg brief, and dg hooks check report the ones not reported yet (from any session on this machine). " +
    "When a Run was opened from the marker but no SubagentStop has reached the session (seen at a foreground launch or at the end of the session; background launches alone may still be running, so they are not judged), it adds a warning once per session",
  input: z.object({
    event: z
      .string()
      .min(1)
      .describe("Hook event name (the product's event name; written by dg hooks install)"),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Agent name with hooks (${hookAgentNames().join(", ")}). Can be omitted when exactly one Adapter has hooks`,
      ),
    payload: z
      .record(z.string(), z.unknown())
      .meta({ cliFile: "payload" })
      .optional()
      .describe("Hook input (JSON). On the CLI, read from stdin with --payload -"),
  }),
  write: true,
  needs: "store",
  // dg の外の変更は Stop でだけ確かめて伝える。ほかのイベントでフックが止まらないよう、runCommand では確かめない
  ownsOutsideCheck: true,
  // PreToolUse（tool_requested）はツールのたびに呼ばれるので、ストアを開かない文脈で動く（t554）。判定に使うのは repo の場所と入力だけ。
  // Stop（turn_stopped）も応答のたびに呼ばれるので、ストアを開かずに dg の外の変更を確かめる（t770）。読むのは config のリモートの名前だけ
  storeless: (input, env) => {
    const kind = eventKindOf(input, env);
    return kind === "tool_requested" || kind === "turn_stopped";
  },
  storelessRemote: (input, env) => eventKindOf(input, env) === "turn_stopped",
  async run(ctx, input) {
    const view: HookView = { event: input.event, done: [] };
    const agent = hookAgentOf(input.agent);
    const hooks = hooksOf(agent);
    if (!hooks) return ok(view, undefined, [`agent ${agent} has no hooks`]);
    const env = ctx.env ?? process.env;
    const payload = input.payload ?? {};
    const event = hooks.parse(input.event, payload, env);
    // PreToolUse は記録から判定までを、2 つの入口（bin/dg.js と同梱の dg.mjs）の速い経路と同じ関数で行う（t768。同じ出力と記録になる）
    if (event?.kind === "tool_requested") {
      const r = await runToolRequested({
        hooks,
        eventName: input.event,
        payload,
        event,
        repo: ctx.repo,
        now: () => ctx.now(),
      });
      return ok(
        { ...view, done: r.done, ...(r.output !== undefined ? { output: r.output } : {}) },
        undefined,
        r.warnings,
      );
    }
    // Stop も、2 つの入口の速い経路と同じ関数で行う（t786）。リモートの名前は storelessRemote の文脈が読んだもの。
    // 応答のたびに呼ばれるので、止まった Run の掃除（closeStoppedRuns）はしない
    if (event?.kind === "turn_stopped") {
      const r = await runTurnStopped({
        hooks,
        eventName: input.event,
        payload,
        event,
        repo: ctx.repo,
        now: () => ctx.now(),
      });
      return ok(
        { ...view, done: r.done, ...(r.output !== undefined ? { output: r.output } : {}) },
        undefined,
        r.warnings,
      );
    }
    // 記録の流れは PreToolUse と同じ recordAroundHook（hook-records.ts）。フックの入力の項目の有無をイベントごとの最新の 1 件に残し
    // （dg hooks check が読む。扱うイベントの名前だけを使う）、このセッションにフックが届いたことと届いた種類を残し
    // （next・brief・claim --no-run が、届いていないセッションを警告する。t697・t756）、警告をセッションごとに残す
    // （警告は標準エラーに出るだけで誰にも届かないので、next・brief・hooks check が後で知らせる。t756）。失敗で作業を止めない
    const warnings = await recordAroundHook({
      localDir: ctx.repo.localDir,
      eventName: input.event,
      ...(hooks.events.some((e) => e.event === input.event)
        ? { inputFields: () => hooks.inputFields(input.event, payload) }
        : {}),
      payload,
      event,
      at: toIsoDateTime(ctx.now()),
      body: async (event, warnings) => {
        if (event.kind === "session_start") {
          try {
            await pruneHookSessions(ctx.repo.localDir, ctx.now());
          } catch (e) {
            warnings.push(
              `Could not prune old hook session records (${e instanceof Error ? e.message : String(e)})`,
            );
          }
        }
        await handle(ctx, agent, event, view, warnings);
      },
    });
    return ok(view, undefined, warnings);
  },
});

async function handle(
  ctx: CommandContext,
  agent: string,
  event: Exclude<HookEvent, { kind: "tool_requested" | "turn_stopped" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const calledAt = toIsoDateTime(ctx.now());
  switch (event.kind) {
    case "session_start":
      return sessionStart(event, view, warnings);
    case "subagent_launched":
      await subagentLaunched(ctx, agent, event, view, warnings);
      break;
    case "subagent_started":
      await subagentStarted(ctx, agent, event, view);
      break;
    case "subagent_stopped":
      await subagentStopped(ctx, agent, event, view, warnings);
      break;
    case "session_end":
      return sessionEnd(ctx, event, view, warnings);
  }
  // 記録の書き終わりを待ちきれずに残した Run を、次のフックの機会に閉じる（RN-7）
  await closeStoppedRuns(ctx, warnings, view, { session: event.session, markedBefore: calledAt });
}

async function sessionStart(
  event: Extract<HookEvent, { kind: "session_start" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  if (!event.envFile) {
    warnings.push(
      "No file to write the environment to was given, so the actor and session ID are not put in the environment",
    );
    return;
  }
  // export を付けないとシェルの変数になるだけで、dg に届かない
  const lines = [
    "export DEGUBOARD_ACTOR=agent",
    `export DEGUBOARD_SESSION=${quote(event.session)}`,
    ...(event.transcript ? [`export DEGUBOARD_TRANSCRIPT=${quote(event.transcript)}`] : []),
  ];
  await appendFile(event.envFile, `${lines.join("\n")}\n`);
  view.done.push(
    "Put the actor (agent), the session ID, and the transcript path into the environment of later Bash calls",
  );
}

async function subagentLaunched(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_launched" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const marker = parseMarker(event.prompt);
  // 印のないサブエージェント（調べものなど）は Run にしない
  if (!marker) return;
  const ticket = ctx.store.tickets.get(marker.ticket);
  if (!ticket) {
    warnings.push(`The marked ticket ${marker.ticket} was not found, so no Run was opened`);
    return;
  }
  if (event.transcript && !(await underRoot(ctx, agent, event.transcript, warnings))) return;
  // 前景の起動で、先に来た終わりの出来事がサブエージェント自身の開いた Run をこの記録に結び付けていたら、もう 1 本は開かない
  if (
    event.transcript &&
    [...(await readTranscriptPaths(ctx.repo)).values()].includes(event.transcript)
  ) {
    view.done.push(
      `Does not open ${marker.step} for ${marker.ticket}, because a Run is already tied to this transcript`,
    );
    return;
  }
  const now = ctx.now();
  // 前景の起動は終わってから返るので、かかった時間だけ開始を前にする。かかった時間が渡されなければ、サブエージェントの記録の
  // 最初の行（頼んだ文）の時刻を起動の時刻にする（今の時刻にすると、見直し役が古い Run に書いた結果を起動より前のものと見誤る）
  const startedAt = !event.finished
    ? undefined
    : event.durationMs !== null
      ? new Date(now.getTime() - event.durationMs)
      : event.transcript
        ? await firstLineTime(event.transcript)
        : undefined;
  // 前景の見直し役が動いている間に、その結果（保留）を別のプロセスの sync・pr ready が見直しの記録にしていたら、開かずに引き取る（t701）
  if (
    marker.step === REVIEW_STEP &&
    event.finished &&
    event.transcript &&
    startedAt &&
    (await adoptReviewRecord(ctx, agent, event, ticket.data, startedAt, view, warnings))
  )
    return;
  // 同じチケットで別のセッションに残った Run は、そのセッションが落ちた残り。閉じてから開く（RN-6）。
  // 同じセッションの Run を重ねて開くのは二重の起動なので、閉じずに下の openRun が拒否する
  await closeStaleRuns(ctx, marker, event.session, startedAt ?? now, view, warnings);
  // 開いたままの前の手直しの Run は、openRun がこの起動の開始を区切りとして閉じてから開く（RN-6）
  let run: Run;
  try {
    const opened = await openRun(ctx, ticket.data, {
      step: marker.step,
      agent,
      model: event.model ?? undefined,
      session: event.session,
      transcript: event.transcript ?? undefined,
      startedAt,
      reopensFix: true,
    });
    run = opened.run;
    warnings.push(...opened.warnings);
    view.done.push(`Opened the ${run.step} Run ${run.id} for ${run.ticket}`);
  } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    warnings.push(`Could not open the ${marker.step} Run of ${marker.ticket}: ${e.message}`);
    return;
  }
  // 印で開いた起動を残し、SubagentStop が届かないと言えれば警告する（t756）。書けなくても Run の扱いは止めない
  try {
    await recordMarkedLaunch(ctx.repo.localDir, event.session, toIsoDateTime(now), event.finished);
    const stopMissing = await subagentStopMissingWarning(ctx.repo.localDir, event.session, {
      foreground: event.finished,
    });
    if (stopMissing) warnings.push(stopMissing);
  } catch (e) {
    warnings.push(
      `Could not write the marked launch record (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!event.transcript) return;
  // 前景の起動はもう終わっている（終わりの出来事は先に来て、閉じる Run がなかった）ので、ここで閉じる
  if (event.finished) await stopSubagentRun(ctx, agent, run, event.transcript, view, warnings);
  // バックグラウンドの起動は、止まるまで動いている印を付ける。印のある間は run finish が閉じない（t638）
  else await bindTranscript(ctx.repo, run.id, event.transcript, true);
}

/** 見直しの結果が同じか（数と通ったか）。記録と同じ秒に置いた保留の結果が呼び直しかを見分ける */
const sameReview = (a: RunReview, b: RunReview | null) =>
  b !== null && a.heavy === b.heavy && a.light === b.light && a.passed === b.passed;

/**
 * 前景の見直し役が返ったとき、その結果から先に書かれた見直しの記録（capture: none）を引き取る（t701。どの記録かは adoptableReviewRecord）。
 * 新しい Run は開かず、記録に会話記録を結び付け、起動から今までの Run として agent・開始・終了・モデル・使用量・ツールの回数を書き直し、
 * capture: none を外す（閉じた Run を書き換える RN-4 の例外）。結果（review・result）は記録のまま。ただし記録より後に置いた保留の結果
 * （記録を書いた後の run review-result の呼び直し）があれば、review をそれに置き換える。
 * 開始を起動の時刻、終了を今にするのは、会話記録を数える範囲（サブエージェントの記録は終了まで）に見直し役の最後の応答を入れるため。
 * ID は結果を書いた時刻のままにする（保留の回と Git の記録が ID で結び付いている）。
 * 保留の結果と保留の回は記録と同じ見直しなので消すか記録に結び付ける（残すと次の見直しの Run に結び付き、同じ見直しを 2 回数える）。
 * 引き取る記録がなければ false（呼び出し側が今までどおり Run を開く）
 */
async function adoptReviewRecord(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_launched" }>,
  target: Ticket,
  launchedAt: Date,
  view: HookView,
  warnings: string[],
): Promise<boolean> {
  const ticket = target.id;
  const transcript = event.transcript!;
  const startedAt = toIsoDateTime(launchedAt);
  const record = adoptableReviewRecord(
    [...ctx.store.runs.values()].map((d) => d.data),
    ticket,
    event.session,
    startedAt,
  );
  if (!record) return false;
  // 引き取りは openRun を通らないので、openRun と同じく起動の時刻を区切りに開いたままの前の手直しの Run を閉じる（RN-6）
  await closePreviousFixRunOrWarn(
    ctx,
    target,
    { step: REVIEW_STEP, session: event.session, startedAt: launchedAt },
    warnings,
  );
  await bindTranscript(ctx.repo, record.id, transcript);
  // 記録を書いた後に見直し役が run review-result を呼び直した結果は、記録（結果のある閉じた Run）に書けずに保留になっている。
  // 記録より後に置いた保留は同じ見直し役の新しい結果なので、記録の結果をそれに置き換える（捨てると記録が古い結果のまま残る）
  const pending = await takePendingReviewEntry(ctx.repo, ticket, startedAt);
  // 時刻は秒の精度なので、記録の元の結果と同じ秒に呼び直した結果は時刻だけでは見分けられない。同じ秒なら内容が違うかで見分ける
  const newer =
    pending &&
    (pending.at > record.started_at ||
      (pending.at === record.started_at && !sameReview(pending.review, record.review)))
      ? pending.review
      : undefined;
  await adoptPendingRounds(ctx.repo, ticket, record.id, startedAt, { relink: newer !== undefined });
  if (!(await waitSettled(agent, transcript)))
    warnings.push(
      `The last response in the record of Run ${record.id} was not written within ${hookTiming.settleMs} ms, so its usage may miss it (dg run refresh ${record.id} reads it again)`,
    );
  const now = ctx.now();
  const finishedAt = toIsoDateTime(now < launchedAt ? launchedAt : now);
  const adopted: Run = {
    ...record,
    agent,
    model: event.model ?? record.model,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  const { others } = await usageContext(ctx, (await readRunningRuns(ctx.repo)).runs);
  const collected = await collectRunUsage(ctx.config, {
    run: adopted,
    finishedAt,
    env: ctx.env ?? process.env,
    topLevel: ctx.repo.topLevel,
    others,
    transcript,
  });
  const written = await withWrite(
    ctx,
    async () => {
      const doc = ctx.store.runs.get(record.id);
      if (doc?.data.capture !== "none")
        throw new OperationError(
          "REJECTED",
          `The review record ${record.id} was already taken over during the write`,
        );
      return (
        await ctx.store.update("run", record.id, {
          capture: undefined,
          agent,
          model: collected.model ?? adopted.model,
          started_at: startedAt,
          finished_at: finishedAt,
          // 渡されなかったキー（undefined）は重ねない。usage の中の未知のキーは残す（DT-2）
          usage: {
            ...(doc.raw["usage"] as Record<string, unknown>),
            ...Object.fromEntries(
              Object.entries(collected.usage).filter(([, v]) => v !== undefined),
            ),
          },
          tools: collected.tools ?? doc.data.tools,
          ...(newer ? { review: newer } : {}),
        })
      ).data;
    },
    { message: (run) => `Take over review record ${run.id}: ${run.ticket} review ${run.result}` },
  );
  warnings.push(
    ...collected.warnings.map((w) => `Run ${record.id}: ${w}`),
    ...written.write.warnings,
  );
  view.done.push(
    `Took over the review record ${record.id} for ${ticket}, written from the held result while the reviewer was running, instead of opening a new Run`,
  );
  return true;
}

/**
 * 印の起動の前に、このマシンで開いたままの同じチケットの Run のうち、落ちたセッションの残りを interrupted で閉じる（RN-6）。残りとみなすのは次の 2 つ。
 *   - 見直しの起動では、別のセッションで開いた見直しの Run（記録の新しさによらない。見直しを別のセッションで並行して動かすことは想定しない）
 *   - どの step の起動でも、落ちたセッションに残ったサブエージェントの Run（crashedSubagentRunAt。step によらない。t765）。
 *     記録が新しい別のセッションの Run・親が自分で開いた Run は、並行して動いているかセッションをまたいで続くので閉じない
 * 使用量はその Run の記録の場所から数える。前景の見直しの起動では見直し役が終わってからここに来るので、その間の run review-result は
 * 古い見直しの Run に書かれている。起動（launchedAt）より後に書かれた結果は古い Run から外して保留に移し、新しい Run を閉じるときに結び付ける。
 * 閉じられなければ警告して続ける（下の openRun が拒否して警告する）
 */
async function closeStaleRuns(
  ctx: CommandContext,
  marker: { ticket: TicketId; step: string },
  session: string,
  launchedAt: Date,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: stale } of (await readRunningRuns(ctx.repo)).runs) {
    if (stale.ticket !== marker.ticket || !openedInOtherSession(stale, session)) continue;
    const review = stale.step === REVIEW_STEP && marker.step === REVIEW_STEP;
    if (
      !review &&
      (await crashedSubagentRunAt(stale, paths.get(stale.id), session, ctx.now())) === undefined
    )
      continue;
    try {
      let run = stale;
      if (review && (await moveReviewToPending(ctx.repo, run.id, launchedAt))) {
        run = { ...run, review: null };
        view.done.push(
          `The review result for ${marker.ticket} was written by the current reviewer, so it was taken off Run ${run.id} and kept pending`,
        );
      }
      await closeSubagentRun(
        ctx,
        run,
        paths.get(run.id),
        { result: "interrupted", error: STALE_SESSION_ERROR },
        view,
        warnings,
      );
    } catch (e) {
      warnings.push(
        `Could not close Run ${stale.id}, which is still open in another session (${stale.session}) (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
}

/** パスが agent の会話記録の置き場所の下か。外なら警告して false（HTTP・MCP から hook を呼んでも任意のファイルを読ませない） */
async function underRoot(
  ctx: CommandContext,
  agent: string,
  transcript: string,
  warnings: string[],
): Promise<boolean> {
  if (await transcriptUnderRoot(agent, transcript, ctx.env ?? process.env)) return true;
  warnings.push(
    `The record path is not under the place where ${agent} keeps conversation records, so it is not used`,
  );
  return false;
}

/** 記録の最初の行の時刻（サブエージェントの記録では、頼んだ文を受け取った時刻）。読めなければ undefined */
async function firstLineTime(transcript: string): Promise<Date | undefined> {
  const text = await readFile(transcript, "utf8").catch(() => "");
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
  const at = Date.parse(/"timestamp":"([^"]+)"/.exec(firstLine)?.[1] ?? "");
  return Number.isNaN(at) ? undefined : new Date(at);
}

/**
 * サブエージェントが自分で開いた Run（記録に ID が出る、実行中か閉じた Run）。同じセッションで、記録の最初の行より後に始まった
 * ものだけにする（一覧を読んだ・頼んだ文が前の Run の ID を含むだけの Run を結び付け直さない）
 */
async function mentionedRuns(
  ctx: CommandContext,
  transcript: string,
  agent: string,
  session: string,
): Promise<RunId[]> {
  const since = (await firstLineTime(transcript))?.getTime();
  if (since === undefined) return [];
  // run start・ticket claim の結果に出た、自分で開いた Run だけ（警告・一覧・詳細に出るほかの Run の ID は取らない）
  const ids = new Set(await hooksOf(agent)!.selfOpenedRunIds(transcript));
  // すでにほかのサブエージェントの記録に結び付いた Run（起動のフックが開いた兄弟の Run）は外す
  const paths = await readTranscriptPaths(ctx.repo);
  const boundElsewhere = (id: string) => {
    const p = paths.get(id);
    return p !== undefined && p !== transcript && path.basename(path.dirname(p)) === "subagents";
  };
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const known = (id: string) =>
    running.find((r) => r.id === id) ?? ctx.store.runs.get(id as RunId)?.data;
  return [...ids].filter((id) => {
    const run = known(id);
    // 開始は秒までなので、その秒の初めまで許す
    return (
      run?.agent === agent &&
      run.session === session &&
      Date.parse(run.started_at) >= since - 999 &&
      !boundElsewhere(id)
    );
  }) as RunId[];
}

async function subagentStopped(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_stopped" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const transcript = event.transcript;
  if (!transcript) {
    warnings.push(`No record path was given for subagent ${event.agentId}`);
    return;
  }
  if (!(await underRoot(ctx, agent, transcript, warnings))) return;
  const paths = await readTranscriptPaths(ctx.repo);
  const running = (await readRunningRuns(ctx.repo)).runs;
  // 起動のフックが開いた Run は、記録の場所がこのサブエージェントの記録のもの
  const opened = running.find(
    (r) =>
      r.data.agent === agent && paths.get(r.id) === transcript && r.data.session === event.session,
  );
  if (!opened) {
    await bindSelfOpened(ctx, agent, transcript, event.session, view, warnings);
    return;
  }
  await stopSubagentRun(ctx, agent, opened.data, transcript, view, warnings);
}

/** 記録の書き終わりを待つ間隔と上限（ミリ秒）。テストが短くする */
export const hookTiming: {
  settleMs: number;
  pollMs: number;
  /** 待ちきれなかった直後に呼ぶ（テストが、その後の掃除の前に記録を書き足すため） */
  onGiveUp?: (() => Promise<void>) | undefined;
} = { settleMs: 3000, pollMs: 100 };

/**
 * サブエージェントが止まったときの Run の扱い（RN-7）。記録の最初の文の印で照らしてチケットと step を直し、記録の場所を
 * サブエージェントの記録にする。step を終えた事実（resultOf が success）があり、記録が書き終わっていれば閉じる。
 * 事実がなければ（親への質問で止まったなど）閉じずに止まって待っている印（waiting_since）を付ける。記録が書き終わらなければ
 * 書き終わり待ちの印（settling_since）を付けて残し、次のフック・sync・SessionEnd が閉じる（closeStoppedRuns）。settle が false なら書き終わりを待たない
 */
async function stopSubagentRun(
  ctx: CommandContext,
  agent: string,
  opened: Run,
  transcript: string,
  view: HookView,
  warnings: string[],
  settle = true,
): Promise<void> {
  const prompt = await hooksOf(agent)!.firstPrompt(transcript);
  const marker = prompt ? parseMarker(prompt) : undefined;
  let run = opened;
  // 印は起動のフックが開いた Run を照らす。サブエージェントが自分で開いた Run（手直しを続きで頼んだあとの claim など）は、
  // 記録の最初の文の印（実装の step）で直さない。直すと手直しが実装に書き換わる
  const selfOpened = (await hooksOf(agent)!.selfOpenedRunIds(transcript)).includes(run.id);
  if (marker && !selfOpened && (marker.ticket !== run.ticket || marker.step !== run.step)) {
    // 並べて起動して取り違えた。記録の最初の文が正しい
    run = await amendRunning(ctx.repo, run.id, marker);
    warnings.push(
      `Corrected Run ${run.id} to ${marker.ticket} ${marker.step} to match the marker in its record`,
    );
  }
  await bindTranscript(ctx.repo, run.id, transcript);
  const ticket = ctx.store.tickets.get(run.ticket)?.data;
  run = await bindPending(ctx, run, ticket, view);
  const decided = await resultOf(ctx, run, ticket);
  if (decided.result !== "success") {
    // 書き終わり待ちで呼び直したときに事実が取れなかった（gh・fetch の一時的な失敗など）なら、書き終わり待ちをやめて答え待ちにする。
    // 両方の印を残すと、掃除がフックのたびに事実を取り直し続ける
    if (run.settling_since !== null)
      run = await amendRunning(ctx.repo, run.id, { settling_since: null });
    await markWaiting(ctx, run, view);
    return;
  }
  if (settle && !(await waitSettled(agent, transcript))) {
    await hookTiming.onGiveUp?.();
    if (run.settling_since === null)
      await amendRunning(ctx.repo, run.id, { settling_since: toIsoDateTime(ctx.now()) });
    warnings.push(
      `The last response in the record of Run ${run.id} was not written within ${hookTiming.settleMs} ms, so it is not closed yet (it is closed at the next hook, dg sync, or the end of the session)`,
    );
    return;
  }
  await closeSubagentRun(ctx, run, transcript, decided, view, warnings);
}

/**
 * 前景のサブエージェントが Run のないうちに保留にしたものを、閉じる前の Run に結び付ける。見直しは結果（RN-9）、
 * 手直しはやり直しの理由（RN-8）。どちらもその Run の開始より後に置いたものだけ
 */
async function bindPending(
  ctx: CommandContext,
  run: Run,
  ticket: Ticket | undefined,
  view: HookView,
): Promise<Run> {
  if (run.step === REVIEW_STEP) {
    // Run に結果があれば、保留の結果は同じ見直しの重なりなので消す（Run の結果を残す。t638）
    const review = await takePendingReview(ctx.repo, run.ticket, run.started_at);
    await adoptPendingRounds(ctx.repo, run.ticket, run.id, run.started_at);
    if (!review || run.review !== null) return run;
    view.done.push(`Tied the pending review result for ${run.ticket} to Run ${run.id}`);
    return amendRunning(ctx.repo, run.id, { review });
  }
  if (ticket && run.step === openedStepOf(ctx, ticket, "reclaim")) {
    const reasons = await takePendingRetryReasons(ctx.repo, run.ticket, run.started_at);
    if (reasons.length === 0) return run;
    view.done.push(`Tied the pending retry reasons for ${run.ticket} to Run ${run.id}`);
    return appendRetryReasons(ctx.repo, run.id, reasons);
  }
  return run;
}

/** 止まって待っている印を付ける（付いていれば今のまま） */
async function markWaiting(ctx: CommandContext, run: Run, view: HookView): Promise<void> {
  if (run.waiting_since !== null) return;
  await amendRunning(ctx.repo, run.id, { waiting_since: toIsoDateTime(ctx.now()) });
  view.done.push(
    `The ${run.step} Run ${run.id} for ${run.ticket} has stopped and is waiting (not closed)`,
  );
}

/**
 * 記録の最後の api-request の後に使用量付きの応答が出るまで待つ。上限を過ぎたら false。
 * 待つのは最後の応答の使用量（多くは最も大きい）を欠かさないため。上限を置くのは、フックでエージェントの作業を止めないため
 */
async function waitSettled(agent: string, transcript: string): Promise<boolean> {
  const hooks = hooksOf(agent)!;
  const until = Date.now() + hookTiming.settleMs;
  for (;;) {
    if (await hooks.transcriptSettled(transcript)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, hookTiming.pollMs));
  }
}

/** サブエージェントの Run を、記録の全体から数えて閉じる。見直しの成否はロックの中で読み直した記録で決める */
async function closeSubagentRun(
  ctx: CommandContext,
  run: Run,
  transcript: string | undefined,
  decided: { result: RunResult; error?: string },
  view: HookView,
  warnings: string[],
): Promise<void> {
  const { others } = await usageContext(ctx, (await readRunningRuns(ctx.repo)).runs);
  const now = ctx.now();
  const collected = await collectRunUsage(ctx.config, {
    run,
    finishedAt: toIsoDateTime(now),
    env: ctx.env ?? process.env,
    topLevel: ctx.repo.topLevel,
    others,
    transcript,
  });
  const closed = await finishRun(ctx, run.id, {
    result: decided.result,
    error: decided.error,
    // 見直しの成否は、閉じる直前にロックの中で読み直した記録の結果で決める（数えている間に書かれた結果を落とさない）
    decide:
      run.step === REVIEW_STEP && decided.result !== "interrupted" ? reviewResultOf : undefined,
    model: collected.model ?? undefined,
    usage: collected.usage,
    tools: collected.tools,
    now,
  });
  warnings.push(...collected.warnings.map((w) => `Run ${run.id}: ${w}`), ...closed.write.warnings);
  view.done.push(
    `Closed the ${run.step} Run ${run.id} for ${run.ticket} with ${closed.run.result}`,
  );
}

/**
 * 書き終わり待ちの印（settling_since）の付いたサブエージェントの Run のうち、記録が書き終わったものを閉じる（RN-7）。
 * フックのたびと dg sync が呼ぶ。止まって待っている印（質問への答え待ち）の Run は、再開で続くので閉じない。
 * session を渡せばそのセッションの Run だけ、markedBefore を渡せばその時刻より前に印を付けたものだけ（今のフックで残した Run を、
 * 同じフックの中で閉じない）。reviewSession を渡せば、見直しの Run のうちそのセッションと別のセッションのものを閉じない（dg sync。
 * 落ちたセッションの見直しの Run には、前景で動いている今回の見直し役が結果を書いているかもしれない。次の見直しの起動が振り分けて閉じる）
 */
export async function closeStoppedRuns(
  ctx: CommandContext,
  warnings: string[],
  view: HookView = { event: "", done: [] },
  only: {
    session?: string | undefined;
    markedBefore?: string | undefined;
    reviewSession?: string | undefined;
  } = {},
): Promise<void> {
  const { session, markedBefore, reviewSession } = only;
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: run } of (await readRunningRuns(ctx.repo)).runs) {
    const transcript = paths.get(run.id);
    if (run.settling_since === null || !isSubagentTranscript(transcript) || !hooksOf(run.agent))
      continue;
    if (session !== undefined && run.session !== session) continue;
    if (markedBefore !== undefined && run.settling_since >= markedBefore) continue;
    if (run.step === REVIEW_STEP && openedInOtherSession(run, reviewSession)) continue;
    // まだ書き終わっていない記録は、待たずに次の機会に回す
    if (!(await hooksOf(run.agent)!.transcriptSettled(transcript!))) continue;
    try {
      await stopSubagentRun(ctx, run.agent, run, transcript!, view, warnings, false);
    } catch (e) {
      warnings.push(
        `Could not close Run ${run.id}, which was waiting for its writing to finish (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
}

/** サブエージェントがもう一度始まった（親の SendMessage で続きを頼まれた）。同じ記録の開いた Run を続きとして使い、印を消す */
async function subagentStarted(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_started" }>,
  view: HookView,
): Promise<void> {
  if (!event.transcript) return;
  const paths = await readTranscriptPaths(ctx.repo);
  const run = (await readRunningRuns(ctx.repo)).runs.find(
    (r) =>
      r.data.agent === agent &&
      paths.get(r.id) === event.transcript &&
      r.data.session === event.session,
  )?.data;
  // 初めての起動（Run は起動の呼び出しが返ってから開く）と、印のない Run は何もしない
  if (!run || (run.waiting_since === null && run.settling_since === null)) return;
  await amendRunning(ctx.repo, run.id, { waiting_since: null });
  // 続きの作業があるので、書き終わり待ちもやめる（次の Stop がもう一度決める）
  if (run.settling_since !== null) await amendRunning(ctx.repo, run.id, { settling_since: null });
  // 次に止まるまで動いている（run finish が閉じない。t638）
  await bindTranscript(ctx.repo, run.id, event.transcript, true);
  view.done.push(
    `Uses the ${run.step} Run ${run.id} for ${run.ticket} as the continuation (removed the mark)`,
  );
}

/**
 * サブエージェントが自分で開いた Run に記録の場所を結び付ける（印のある Run がないときの受け皿。RN-5・RN-7）。
 * 対象は記録に ID が出る Run のうち、印で開いたものでないもの。主に、サブエージェントが `run start` や、印のない頼み方の
 * `ticket claim`（`--no-run` なし）で開いた Run。閉じていれば取り直し、開いたままで step を終えた事実がなければ
 * （手直しで push がないなど）止まって待っている印を付ける。事実があれば印は付けず、閉じない。
 * 消してよいのは、サブエージェントの記録から Run を開く経路がなくなったとき（run start と claim がサブエージェントに Run を開かせず、
 * 実装と手直しを印で頼む手順だけになったとき）。そのときは mentionedRuns とこの関数、テストを一緒に消す。
 */
async function bindSelfOpened(
  ctx: CommandContext,
  agent: string,
  transcript: string,
  session: string,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const ids = await mentionedRuns(ctx, transcript, agent, session);
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const closed: RunId[] = [];
  for (const id of ids) {
    await bindTranscript(ctx.repo, id, transcript);
    view.done.push(`Set the transcript of Run ${id} to the sub-agent's transcript`);
    if (ctx.store.runs.has(id)) {
      closed.push(id);
      continue;
    }
    // 開いたままで返った Run にも、印のある Run と同じく、step を終えた事実がなければ止まって待っている印を付ける（RN-7）。
    // 事実があれば印は付けず、閉じない（手直しは sync の区切り、ほかはセッションの終わりが閉じる）
    const run = running.find((r) => r.id === id);
    if (!run) continue;
    const decided = await resultOf(ctx, run, ctx.store.tickets.get(run.ticket)?.data);
    if (decided.result !== "success") await markWaiting(ctx, run, view);
  }
  if (closed.length === 0) return;
  const refreshed = await runCommand(runRefresh, ctx, { runs: closed });
  warnings.push(...refreshed.warnings);
  view.done.push(`Re-read the usage of the closed Runs ${closed.join(", ")}`);
}

/**
 * フックが閉じる Run の結果（RN-7）。step ごとの事実で決める。見直しは結果（run review-result）が記録されていれば success（RN-9）。
 * 実装は PR があれば success。手直しは開始より後の push があれば success。ほかの step は success
 */
async function resultOf(
  ctx: CommandContext,
  run: Run,
  ticket: Ticket | undefined,
): Promise<{ result: RunResult; error?: string }> {
  if (!ticket) return { result: "success" };
  const claimStep = openedStepOf(ctx, ticket, "claim");
  const fixStep = openedStepOf(ctx, ticket, "reclaim");
  if (run.step === claimStep) {
    if (ticket.pr !== undefined) return { result: "success" };
    if (!ticket.branch)
      return { result: "failure", error: "サブエージェントが終わったとき PR がない" };
    const facts = await collectBranchFacts(ctx.repo, ticket.branch, {
      needPr: true,
      status: ticket.status,
      since: ticket.branch_at,
    }).catch(() => undefined);
    return facts?.pr !== undefined
      ? { result: "success" }
      : { result: "failure", error: "サブエージェントが終わったとき PR がない" };
  }
  if (run.step === fixStep) {
    const pushed = ticket.branch
      ? await lastPushedAt(ctx.repo, ticket.branch, { fetch: true }).catch(() => undefined)
      : undefined;
    return pushed !== undefined && pushed >= run.started_at
      ? { result: "success" }
      : { result: "failure", error: "サブエージェントが終わったとき手直しの push がない" };
  }
  if (run.step === REVIEW_STEP) return reviewResultOf(run);
  return { result: "success" };
}

/** 見直しの Run の結果。結果（run review-result）が記録されていれば success（RN-9） */
function reviewResultOf(run: Run): { result: RunResult; error?: string } {
  return run.review !== null
    ? { result: "success" }
    : { result: "failure", error: REVIEW_UNRECORDED };
}

/**
 * セッションの終わり（RN-7）。このセッションのサブエージェントの Run（記録の場所がサブエージェントの記録のもの）のうち開いたままのものを閉じる。
 * step を終えた事実があれば成功で閉じ、なければ見直し・手直しなどは interrupted、実装は PR がないので failure。親が自分で進める Run は残す
 */
async function sessionEnd(
  ctx: CommandContext,
  event: Extract<HookEvent, { kind: "session_end" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  // 印で開いた起動があるのに SubagentStop が一度も届かなかったセッションは、終わりで警告を残す（次のセッションの next などが知らせる。t756）
  const stopMissing = await subagentStopMissingWarning(ctx.repo.localDir, event.session, {
    ending: true,
  }).catch(() => undefined);
  if (stopMissing) warnings.push(stopMissing);
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: run } of (await readRunningRuns(ctx.repo)).runs) {
    const transcript = paths.get(run.id);
    if (run.session !== event.session || !isSubagentTranscript(transcript) || !hooksOf(run.agent))
      continue;
    try {
      const ticket = ctx.store.tickets.get(run.ticket)?.data;
      const current = await bindPending(ctx, run, ticket, view);
      const decided = await resultOf(ctx, current, ticket);
      const claimStep = ticket ? openedStepOf(ctx, ticket, "claim") : undefined;
      const closing =
        decided.result === "success" || run.step === claimStep
          ? decided
          : { result: "interrupted" as const, error: "セッションが終わったとき開いたままだった" };
      await closeSubagentRun(ctx, current, transcript!, closing, view, warnings);
    } catch (e) {
      warnings.push(
        `Could not close Run ${run.id} at the end of the session (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
}

export const hookCommands = [hook];
