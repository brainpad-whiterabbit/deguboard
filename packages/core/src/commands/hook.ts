// harness のフックの出来事を Run の操作に写す（AG-1・RN-5・RN-6、ADR-012）。入力の形は Adapter の hooks.parse が製品ごとに読み、
// ここは製品によらない出来事（HookEvent）だけを見る（AG-5）。フックはエージェントの作業を止めないよう、失敗は警告にして成功で返す。
//   - session_start：以後の Bash の環境に DEGUBOARD_ACTOR=agent・DEGUBOARD_SESSION・DEGUBOARD_TRANSCRIPT を export で書く
//   - subagent_launched：頼んだ文の先頭の印（deguboard: ticket=<id> step=<step>）があれば、その Run を開いて記録の場所をサブエージェントの記録にする
//   - subagent_stopped：記録の場所で Run を引き、記録の最初の文の印で照らしてから、記録の全体から数えて閉じる。
//     印のある Run がなければ、サブエージェントが自分で開いた Run（記録に ID が出る）に記録の場所を結び付ける（移行期の経路）
//   - session_end：このセッションの見直しと手直しの Run のうち開いたままのものを interrupted で閉じる。実装の Run は PR の記録で閉じる

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { collectRunUsage, hookAgentNames, hooksOf, type HookEvent } from "../agents/index.js";
import { OperationError } from "../errors.js";
import { collectBranchFacts, lastPushedAt } from "../git/facts.js";
import { toIsoDateTime } from "../model/common.js";
import { ticketIdSchema, type TicketId } from "../model/id.js";
import type { Run, RunId, RunResult } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import {
  amendRunning,
  bindTranscript,
  finishRun,
  readRunningRuns,
  readTranscriptPaths,
} from "../run/record.js";
import { defineCommand, ok, runCommand, type CommandContext } from "./define.js";
import { openedStepOf, openRun, runRefresh, transcriptUnderRoot, usageContext } from "./run.js";

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
}

export const hook = defineCommand({
  name: "hook",
  positionals: ["event"],
  group: "hook",
  summary:
    "harness のフックが呼ぶ（dg hooks install が設定に書く。人が打つものではない）。--payload - で標準入力のフックの入力（JSON）を読み、" +
    "セッションの始まりに主体とセッション ID・記録のパスを環境に入れ、頼んだ文の先頭に `deguboard: ticket=<id> step=<step>` の印のあるサブエージェントの Run を起動で開いて終わりで閉じ、" +
    "セッションの終わりに開いたままの見直しと手直しの Run を interrupted で閉じる。失敗しても作業を止めないよう、警告にして成功で返す",
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
  switch (event.kind) {
    case "session_start":
      return sessionStart(event, view, warnings);
    case "subagent_launched":
      return subagentLaunched(ctx, agent, event, view, warnings);
    case "subagent_stopped":
      return subagentStopped(ctx, agent, event, view, warnings);
    case "session_end":
      return sessionEnd(ctx, event, view, warnings);
  }
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
    await closeSubagentRun(ctx, agent, run, event.transcript, event.lastMessage, view, warnings);
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
  await closeSubagentRun(ctx, agent, opened.data, transcript, event.lastMessage, view, warnings);
}

/**
 * 起動のフックが開いた Run を閉じる。記録の最初の文の印で照らしてチケットと step を直し、記録の場所をサブエージェントの記録にして、
 * その記録の全体から数える。結果は step ごとの事実で決める（resultOf）
 */
async function closeSubagentRun(
  ctx: CommandContext,
  agent: string,
  opened: Run,
  transcript: string,
  lastMessage: string | null,
  view: HookView,
  warnings: string[],
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
  const ticket = ctx.store.tickets.get(run.ticket)?.data;
  const { result, error } = await resultOf(ctx, run, ticket, lastMessage);
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
    result,
    error,
    model: collected.model ?? undefined,
    usage: collected.usage,
    tools: collected.tools,
    now,
  });
  warnings.push(...collected.warnings.map((w) => `Run ${run.id}: ${w}`), ...closed.write.warnings);
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を ${result} で閉じた`);
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
 * フックが閉じる Run の結果（ADR-012）。step ごとの事実で決める。見直しは最後の応答があれば success（結果の記録は t531 で足す）。
 * 実装は PR があれば success。手直しは開始より後の push があれば success。ほかの step は success
 */
async function resultOf(
  ctx: CommandContext,
  run: Run,
  ticket: Ticket | undefined,
  lastMessage: string | null,
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
  if (run.step === "review") {
    return lastMessage
      ? { result: "success" }
      : { result: "failure", error: "見直し役が結果を返さずに終わった" };
  }
  return { result: "success" };
}

async function sessionEnd(
  ctx: CommandContext,
  event: Extract<HookEvent, { kind: "session_end" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const running = (await readRunningRuns(ctx.repo)).runs;
  for (const r of running) {
    if (r.data.session !== event.session) continue;
    const ticket = ctx.store.tickets.get(r.data.ticket)?.data;
    // 実装の Run は PR の記録で閉じるので残す
    if (ticket && r.data.step === openedStepOf(ctx, ticket, "claim")) continue;
    if (
      r.data.step !== "review" &&
      (!ticket || r.data.step !== openedStepOf(ctx, ticket, "reclaim"))
    )
      continue;
    const now = ctx.now();
    const { others, transcriptOf } = await usageContext(ctx, running);
    const collected = await collectRunUsage(ctx.config, {
      run: r.data,
      finishedAt: toIsoDateTime(now),
      env: ctx.env ?? process.env,
      topLevel: ctx.repo.topLevel,
      others,
      transcript: transcriptOf(r.data.id),
    });
    const closed = await finishRun(ctx, r.data.id, {
      result: "interrupted",
      error: "セッションが終わったとき開いたままだった",
      model: collected.model ?? undefined,
      usage: collected.usage,
      tools: collected.tools,
      now,
    });
    warnings.push(...closed.write.warnings);
    view.done.push(`${r.data.ticket} の ${r.data.step} の Run ${r.id} を interrupted で閉じた`);
  }
}

export const hookCommands = [hook];
