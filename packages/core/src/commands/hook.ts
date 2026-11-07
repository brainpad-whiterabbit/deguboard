// harness のフックの出来事を Run の操作に写す（AG-1・AG-9・RN-5・RN-6、ADR-012・ADR-014）。入力の形は Adapter の hooks.parse が製品ごとに読み、
// ここは製品によらない出来事（HookEvent）だけを見る（AG-5）。フックはエージェントの作業を止めないよう、失敗は警告にして成功で返す。
//   - session_start：以後の Bash の環境に DEGUBOARD_ACTOR=agent・DEGUBOARD_SESSION・DEGUBOARD_TRANSCRIPT を export で書く
//   - subagent_launched：頼んだ文の先頭の印（deguboard: ticket=<id> step=<step>）があれば、その Run を開いて記録の場所をサブエージェントの記録にする
//   - subagent_started：同じ記録の開いた Run（親への質問で止まっていたもの）を続きとして使い、止まって待っている印と書き終わり待ちの印を消す
//   - subagent_stopped：記録の場所で Run を引き、記録の最初の文の印で照らしてから、step を終えた事実があれば記録の書き終わりを待って
//     記録の全体から数えて閉じる。事実がなければ閉じずに止まって待っている印を付ける。
//     印のある Run がなければ、サブエージェントが自分で開いた Run（記録に ID が出る）に記録の場所を結び付ける（移行期の経路）
//   - session_end：このセッションのサブエージェントの Run のうち開いたままのものをすべて閉じる。親が自分で開いた Run は残す
//   どのフックの後も、前のフックで書き終わりを待ちきれずに残した Run を閉じる（dg sync も同じ）

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { collectRunUsage, hookAgentNames, hooksOf, type HookEvent } from "../agents/index.js";
import { OperationError } from "../errors.js";
import { collectBranchFacts, lastPushedAt } from "../git/facts.js";
import { runGit } from "../git/run.js";
import { judgeGate } from "./gate.js";
import { toIsoDateTime } from "../model/common.js";
import { ticketIdSchema, type TicketId } from "../model/id.js";
import { REVIEW_STEP, type Run, type RunId, type RunResult } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import {
  amendRunning,
  bindTranscript,
  finishRun,
  readRunningRuns,
  readTranscriptPaths,
  takePendingReview,
} from "../run/record.js";
import { defineCommand, ok, runCommand, type CommandContext } from "./define.js";
import {
  openedStepOf,
  openRun,
  REVIEW_UNRECORDED,
  runRefresh,
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

export const hook = defineCommand({
  name: "hook",
  positionals: ["event"],
  group: "hook",
  summary:
    "harness のフックが呼ぶ（dg hooks install が設定に書く。人が打つものではない）。--payload - で標準入力のフックの入力（JSON）を読み、" +
    "セッションの始まりに主体とセッション ID・記録のパスを環境に入れ、頼んだ文の先頭に `deguboard: ticket=<id> step=<step>` の印のあるサブエージェントの Run を起動で開き、step を終えた事実があれば止まったときに閉じ" +
    "（なければ止まって待っている印を付け、再開で続ける）、セッションの終わりにそのセッションのサブエージェントの開いたままの Run を閉じる。失敗しても作業を止めないよう、警告にして成功で返す",
  input: z.object({
    event: z
      .string()
      .min(1)
      .describe("フックのイベント名（製品のイベント名。dg hooks install が書く）"),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        `フックを持つエージェント名（${hookAgentNames().join("・")}）。フックを持つ Adapter が 1 つなら省ける`,
      ),
    payload: z
      .record(z.string(), z.unknown())
      .meta({ cliFile: "payload" })
      .optional()
      .describe("フックの入力（JSON）。CLI では --payload - で標準入力から読む"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const view: HookView = { event: input.event, done: [] };
    const warnings: string[] = [];
    const names = hookAgentNames();
    const agent = input.agent ?? (names.length === 1 ? names[0]! : "");
    const hooks = hooksOf(agent);
    if (!hooks) return ok(view, undefined, [`agent ${agent} にはフックがない`]);
    const env = ctx.env ?? process.env;
    const event = hooks.parse(input.event, input.payload ?? {}, env);
    if (!event) return ok(view, undefined, warnings);
    try {
      await handle(ctx, agent, event, view, warnings);
    } catch (e) {
      // フックの失敗で作業を止めない
      warnings.push(
        `${input.event} のフックを最後まで行えなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
    return ok(view, undefined, warnings);
  },
});

async function handle(
  ctx: CommandContext,
  agent: string,
  event: HookEvent,
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
    case "tool_requested":
      // ツールのたびに呼ばれるので、止まった Run の掃除はしない
      return toolRequested(ctx, agent, event, view, warnings);
  }
  // 記録の書き終わりを待ちきれずに残した Run を、次のフックの機会に閉じる（ADR-014）
  await closeStoppedRuns(ctx, warnings, view, event.session, calledAt);
}

async function sessionStart(
  event: Extract<HookEvent, { kind: "session_start" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  if (!event.envFile) {
    warnings.push(
      "環境を書くファイルが渡されなかったので、主体とセッション ID を環境に入れていない",
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
  view.done.push("主体（agent）とセッション ID・記録のパスを以後の Bash の環境に入れた");
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
    warnings.push(`印のチケット ${marker.ticket} が見つからないので Run を開いていない`);
    return;
  }
  if (event.transcript && !(await underRoot(ctx, agent, event.transcript, warnings))) return;
  // 前景の起動で、先に来た終わりの出来事がサブエージェント自身の開いた Run をこの記録に結び付けていたら、もう 1 本は開かない
  if (
    event.transcript &&
    [...(await readTranscriptPaths(ctx.repo)).values()].includes(event.transcript)
  ) {
    view.done.push(
      `${marker.ticket} の ${marker.step} は、この記録に結び付いた Run があるので開かない`,
    );
    return;
  }
  let run: Run;
  try {
    const now = ctx.now();
    const opened = await openRun(ctx, ticket.data, {
      step: marker.step,
      agent,
      model: event.model ?? undefined,
      session: event.session,
      transcript: event.transcript ?? undefined,
      // 前景の起動は終わってから返るので、かかった時間だけ開始を前にする
      startedAt:
        event.finished && event.durationMs !== null
          ? new Date(now.getTime() - event.durationMs)
          : undefined,
    });
    run = opened.run;
    warnings.push(...opened.warnings);
    view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を開いた`);
  } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    warnings.push(`${marker.ticket} の ${marker.step} の Run を開いていない: ${e.message}`);
    return;
  }
  // 前景の起動はもう終わっている（終わりの出来事は先に来て、閉じる Run がなかった）ので、ここで閉じる
  if (event.finished && event.transcript)
    await stopSubagentRun(ctx, agent, run, event.transcript, view, warnings);
}

/** パスが agent の会話記録の置き場所の下か。外なら警告して false（HTTP・MCP から hook を呼んでも任意のファイルを読ませない） */
async function underRoot(
  ctx: CommandContext,
  agent: string,
  transcript: string,
  warnings: string[],
): Promise<boolean> {
  if (await transcriptUnderRoot(agent, transcript, ctx.env ?? process.env)) return true;
  warnings.push(`記録のパスが ${agent} の会話記録の置き場所の下にないので使わない`);
  return false;
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
  const text = await readFile(transcript, "utf8").catch(() => "");
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
  const since = Date.parse(/"timestamp":"([^"]+)"/.exec(firstLine)?.[1] ?? "");
  if (Number.isNaN(since)) return [];
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
    warnings.push(`サブエージェント ${event.agentId} の記録のパスが渡されなかった`);
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

/** 記録のパスがサブエージェントの記録（<session>/subagents/ の下）か。agent_id 付きの Run の見分けに使う */
const isSubagentTranscript = (p: string | undefined) =>
  p !== undefined && path.basename(path.dirname(p)) === "subagents";

/**
 * サブエージェントが止まったときの Run の扱い（ADR-014）。記録の最初の文の印で照らしてチケットと step を直し、記録の場所を
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
  if (marker && (marker.ticket !== run.ticket || marker.step !== run.step)) {
    // 並べて起動して取り違えた。記録の最初の文が正しい
    run = await amendRunning(ctx.repo, run.id, marker);
    warnings.push(
      `Run ${run.id} のチケットと step を記録の印に合わせて ${marker.ticket} の ${marker.step} に直した`,
    );
  }
  await bindTranscript(ctx.repo, run.id, transcript);
  if (run.step === REVIEW_STEP && run.review === null) {
    // 前景の見直し役が、Run のないうちに保留にした結果を結び付ける
    const review = await takePendingReview(ctx.repo, run.ticket, run.started_at);
    if (review) {
      run = await amendRunning(ctx.repo, run.id, { review });
      view.done.push(`${run.ticket} の保留の見直しの結果を Run ${run.id} に結び付けた`);
    }
  }
  const ticket = ctx.store.tickets.get(run.ticket)?.data;
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
      `Run ${run.id} の記録の最後の応答が ${hookTiming.settleMs} ミリ秒のうちに書かれなかったので、まだ閉じない（次のフック・dg sync・セッションの終わりで閉じる）`,
    );
    return;
  }
  await closeSubagentRun(ctx, run, transcript, decided, view, warnings);
}

/** 止まって待っている印を付ける（付いていれば今のまま） */
async function markWaiting(ctx: CommandContext, run: Run, view: HookView): Promise<void> {
  if (run.waiting_since !== null) return;
  await amendRunning(ctx.repo, run.id, { waiting_since: toIsoDateTime(ctx.now()) });
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} は止まって待っている（閉じない）`);
}

/** 記録の最後の api-request の後に使用量付きの応答が出るまで待つ。上限を過ぎたら false */
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
  transcript: string,
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
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を ${closed.run.result} で閉じた`);
}

/**
 * 書き終わり待ちの印（settling_since）の付いたサブエージェントの Run のうち、記録が書き終わったものを閉じる（ADR-014）。
 * フックのたびと dg sync が呼ぶ。止まって待っている印（質問への答え待ち）の Run は、再開で続くので閉じない。
 * session を渡せばそのセッションの Run だけ、markedBefore を渡せばその時刻より前に印を付けたものだけ（今のフックで残した Run を、
 * 同じフックの中で閉じない）
 */
export async function closeStoppedRuns(
  ctx: CommandContext,
  warnings: string[],
  view: HookView = { event: "", done: [] },
  session?: string,
  markedBefore?: string,
): Promise<void> {
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: run } of (await readRunningRuns(ctx.repo)).runs) {
    const transcript = paths.get(run.id);
    if (run.settling_since === null || !isSubagentTranscript(transcript) || !hooksOf(run.agent))
      continue;
    if (session !== undefined && run.session !== session) continue;
    if (markedBefore !== undefined && run.settling_since >= markedBefore) continue;
    // まだ書き終わっていない記録は、待たずに次の機会に回す
    if (!(await hooksOf(run.agent)!.transcriptSettled(transcript!))) continue;
    try {
      await stopSubagentRun(ctx, run.agent, run, transcript!, view, warnings, false);
    } catch (e) {
      warnings.push(
        `書き終わりを待っていた Run ${run.id} を閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
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
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を続きとして使う（印を消した）`);
}

/** 移行期の経路：サブエージェントが自分で開いた Run に記録の場所を結び付け、閉じていれば取り直す */
async function bindSelfOpened(
  ctx: CommandContext,
  agent: string,
  transcript: string,
  session: string,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const ids = await mentionedRuns(ctx, transcript, agent, session);
  const closed: RunId[] = [];
  for (const id of ids) {
    await bindTranscript(ctx.repo, id, transcript);
    view.done.push(`Run ${id} の記録の場所をサブエージェントの記録にした`);
    if (ctx.store.runs.has(id)) closed.push(id);
  }
  if (closed.length === 0) return;
  const refreshed = await runCommand(runRefresh, ctx, { runs: closed });
  warnings.push(...refreshed.warnings);
  view.done.push(`閉じた Run ${closed.join("・")} の使用量を取り直した`);
}

/**
 * フックが閉じる Run の結果（ADR-012）。step ごとの事実で決める。見直しは結果（run review-result）が記録されていれば success（ADR-013）。
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

/** 見直しの Run の結果。結果（run review-result）が記録されていれば success（ADR-013） */
function reviewResultOf(run: Run): { result: RunResult; error?: string } {
  return run.review !== null
    ? { result: "success" }
    : { result: "failure", error: REVIEW_UNRECORDED };
}

/**
 * セッションの終わり（ADR-014）。このセッションのサブエージェントの Run（記録の場所がサブエージェントの記録のもの）のうち開いたままのものを閉じる。
 * step を終えた事実があれば成功で閉じ、なければ見直し・手直しなどは interrupted、実装は PR がないので failure。親が自分で進める Run は残す
 */
async function sessionEnd(
  ctx: CommandContext,
  event: Extract<HookEvent, { kind: "session_end" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: run } of (await readRunningRuns(ctx.repo)).runs) {
    const transcript = paths.get(run.id);
    if (run.session !== event.session || !isSubagentTranscript(transcript) || !hooksOf(run.agent))
      continue;
    try {
      const ticket = ctx.store.tickets.get(run.ticket)?.data;
      let current = run;
      if (current.step === REVIEW_STEP && current.review === null) {
        const review = await takePendingReview(ctx.repo, current.ticket, current.started_at);
        if (review) current = await amendRunning(ctx.repo, current.id, { review });
      }
      const decided = await resultOf(ctx, current, ticket);
      const claimStep = ticket ? openedStepOf(ctx, ticket, "claim") : undefined;
      const closing =
        decided.result === "success" || run.step === claimStep
          ? decided
          : { result: "interrupted" as const, error: "セッションが終わったとき開いたままだった" };
      await closeSubagentRun(ctx, current, transcript!, closing, view, warnings);
    } catch (e) {
      warnings.push(
        `Run ${run.id} をセッションの終わりに閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
}

/** .git/deguboard/ の下のパスを指す語（相対・絶対） */
const DATA_PATH = String.raw`\S*\.git/deguboard(?:/\S*)?`;

/** Bash のコマンドのうち、.git/deguboard/ の下に書くもの（リダイレクト・ファイルを変えるコマンド・sed -i・データのリポジトリへの git の書き込み） */
const DATA_WRITES = [
  new RegExp(String.raw`(?:>>?|\btee\b(?:\s+-a)?)\s*["']?${DATA_PATH}`),
  new RegExp(
    String.raw`\b(?:rm|rmdir|mv|cp|touch|mkdir|ln|chmod|chown|truncate|install|rsync|unlink)\b[^|;&]*${DATA_PATH}`,
  ),
  new RegExp(String.raw`\bsed\b[^|;&]*\s-i\S*[^|;&]*${DATA_PATH}`),
  new RegExp(
    String.raw`\bgit\s+(?:-C\s+)?["']?${DATA_PATH}["']?\s+(?:add|commit|rm|mv|reset|checkout|restore|stash|merge|rebase|cherry-pick|apply|am|push|update-ref|branch|tag)\b`,
  ),
];

/** Bash のコマンドが .git/deguboard/ の下に書くか（t532）。読むだけ（cat・ls・git log など）は通す */
export function writesDataDir(command: string): boolean {
  return DATA_WRITES.some((re) => re.test(command));
}

/** gh pr merge・gh pr ready の呼び出し。selector は PR の番号・URL・ブランチ名（省けば今のブランチ） */
export function parseGhPr(
  command: string,
): { action: "merge" | "ready"; selector?: string | undefined; undo: boolean } | undefined {
  const m = /\bgh\s+pr\s+(merge|ready)\b([^|;&]*)/.exec(command);
  if (!m) return undefined;
  const tokens = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
  // 値を取るフラグ（値を selector と取り違えない）
  const withValue = new Set([
    "-R",
    "--repo",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-t",
    "--subject",
    "-A",
    "--author-email",
    "--match-head-commit",
  ]);
  let selector: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (withValue.has(t)) i++;
    else if (!t.startsWith("-") && selector === undefined) selector = t.replace(/^["']|["']$/g, "");
  }
  return { action: m[1] as "merge" | "ready", selector, undo: tokens.includes("--undo") };
}

/** gh の PR の指定からチケットを引く。番号（#12・URL を含む）は pr、ほかはブランチ名。省けば cwd の今のブランチ */
async function ticketOfPr(
  ctx: CommandContext,
  selector: string | undefined,
  cwd: string | null,
): Promise<Ticket | undefined> {
  const tickets = [...ctx.store.tickets.values()].map((d) => d.data);
  const number = selector ? /^(?:#)?(\d+)$|\/pull\/(\d+)/.exec(selector) : null;
  if (number) {
    const n = Number(number[1] ?? number[2]);
    return tickets.find((t) => t.pr === n);
  }
  let branch = selector;
  if (!branch) {
    const head = await runGit(cwd ?? ctx.repo.topLevel, ["rev-parse", "--abbrev-ref", "HEAD"], {
      allowFailure: true,
    }).catch(() => undefined);
    branch = head?.code === 0 ? head.stdout.trim() : undefined;
  }
  return branch ? tickets.find((t) => t.branch === branch) : undefined;
}

/**
 * ツールを使う前（PreToolUse。t532）。.git/deguboard/ の下への書き込み（書くツールと Bash）を拒み、gh pr merge・gh pr ready を
 * 品質ゲート（dg gate）で止める。チケットを引けない PR は判定できないので止めない。判定の途中で失敗したら、通さずに止める
 */
async function toolRequested(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "tool_requested" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const deny = (reason: string) => {
    view.output = hooksOf(agent)!.denyOutput("PreToolUse", reason);
    view.done.push(`拒んだ: ${reason}`);
  };
  const dataWrite =
    "deguboard のデータ（.git/deguboard/）はファイルを直接書かず、dg のコマンドで読み書きする";
  if (event.tool === "write") {
    if (!event.path) return;
    const target = path.resolve(event.cwd ?? ctx.repo.topLevel, event.path);
    const inside = (dir: string) => {
      const rel = path.relative(dir, target);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (inside(ctx.repo.dataDir) || /(^|[\\/])\.git[\\/]deguboard([\\/]|$)/.test(target))
      deny(dataWrite);
    return;
  }
  const command = event.command ?? "";
  if (writesDataDir(command)) {
    deny(dataWrite);
    return;
  }
  const gh = parseGhPr(command);
  if (!gh || gh.undo) return;
  const stage = gh.action === "merge" ? "merge" : "ready";
  try {
    const ticket = await ticketOfPr(ctx, gh.selector, event.cwd);
    if (!ticket) {
      view.done.push(`gh pr ${gh.action} の PR に当たるチケットがないので、品質ゲートを判定しない`);
      return;
    }
    const judged = await judgeGate(ctx, ticket, stage);
    if (judged.passed) {
      view.done.push(`${ticket.id} の品質ゲート（${stage}）を満たす`);
      return;
    }
    const failed = judged.conditions.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
    deny(
      `${ticket.id} の品質ゲート（dg gate ${ticket.id} --for ${stage}）を満たさない。${failed.join("。")}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    warnings.push(`品質ゲートを判定できなかった（${message}）`);
    deny(`品質ゲートを判定できなかったので止めた（${message}）。dg gate で確かめる`);
  }
}

export const hookCommands = [hook];
