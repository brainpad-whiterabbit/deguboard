// Run の操作（requirements.md 5.9 RN-4〜RN-6・RN-8、6.6 MT-1・MT-2・MT-5、6.7 EX-2、ADR-029）。記録の置き場所とロックは run/record.ts、
// 使用量の取り込みは agents（Run の agent の値で Adapter を選ぶ。特定の AI 製品をここに書かない。AG-5）

import { z } from "zod";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  agentNames,
  collectRunUsage,
  detectAgent,
  hooksOf,
  sessionFromEnv,
  type RunSpan,
} from "../agents/index.js";
import { slugSchema, toIsoDateTime, type Status } from "../model/common.js";
import { filterRuns, placeRun, runDurationSeconds, type MetricFilter } from "../model/metrics.js";
import { OperationError, UsageError } from "../errors.js";
import {
  isRunId,
  REVIEW_STEP,
  RUN_RESULTS,
  type Run,
  reviewFindingSchema,
  type ReviewFinding,
  type RunReview,
  type RunId,
  type RunResult,
  type RunUsage,
} from "../model/run.js";
import { AbortWrite, withWrite } from "../git/write.js";
import { lastPushedAt } from "../git/facts.js";
import { findingText, isHeavyFinding, latestRoundSince, matchFindings } from "../run/findings.js";
import {
  amendRunning,
  appendRetryReasons,
  closeRun,
  adoptPendingRounds,
  putPendingReview,
  putReviewRound,
  putPendingRetryReasons,
  dropRunning,
  finishRun,
  isLiveSubagent,
  pruneTranscripts,
  readReviewFindings,
  readRunningRuns,
  readTranscriptPaths,
  setHandedFindings,
  startRun,
  takePendingReview,
  TRANSCRIPT_RETENTION_DAYS,
  transcriptExpired,
  type PrunedTranscript,
} from "../run/record.js";
import type { Doc } from "../storage/documents.js";
import { DEFAULT_OPENED_STEPS, findStep, stepOpenedOn } from "../workflow/resolve.js";
import type { Ticket } from "../model/ticket.js";
import type { StepOpener } from "../model/workflow.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { idShapeOf, iterationRef, ticketRef } from "./helpers.js";

/**
 * 一覧の 1 件。running は deguboard-local/runs/ にだけある終わっていない Run。
 * duration_seconds は metrics.show の集計と同じ実行時間（終わっていなければ null）
 */
export type RunView = Run & { running: boolean; duration_seconds: number | null };

/**
 * Adapter が期間の重なる Run と応答を分けるための、閉じた Run とこのマシンで実行中の Run の期間と、
 * このマシンに置いた会話記録のパス（deguboard-local/transcripts/。RN-3）
 */
function runSpans(
  closed: Iterable<{ data: Run }>,
  running: Iterable<{ data: Run }>,
  transcripts: ReadonlyMap<string, string>,
) {
  const spans = new Map<string, RunSpan>();
  for (const { data } of [...closed, ...running]) {
    spans.set(data.id, {
      started_at: data.started_at,
      finished_at: data.finished_at,
      agent: data.agent,
      transcript: transcripts.get(data.id),
    });
  }
  return spans;
}

/** Adapter に渡す、ほかの Run の期間と、この Run の会話記録のパス */
export async function usageContext(ctx: CommandContext, local: Iterable<{ data: Run }>) {
  const transcripts = await readTranscriptPaths(ctx.repo);
  return {
    others: runSpans(ctx.store.runs.values(), local, transcripts),
    transcriptOf: (id: string) => transcripts.get(id),
  };
}

/**
 * --agent を省いたときの agent。Adapter が環境変数から判定する（AG-5）。判定できなければ理由を返す
 * （run start は使い方の誤りに、ticket claim は Run を開かない警告にする。RN-5）
 */
export function agentFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { agent: string; reason?: undefined } | { agent: null; reason: string } {
  const { agent, matched } = detectAgent(env);
  if (agent) return { agent };
  const reason =
    matched.length > 1
      ? `Cannot decide the agent from the environment variables: they match ${matched.join(", ")}`
      : `Cannot decide the agent from the environment variables (only an Adapter that sets environment variables can be decided)`;
  return { agent: null, reason: `${reason}. Pass the agent name with --agent` };
}

/**
 * Run を開く（run start と、agent の ticket claim が共有する。RN-5）。step がチケットの Workflow の steps になければ
 * VALIDATION_FAILED、同じチケットと step の Run が実行中なら startRun が ALREADY_EXISTS。
 * Workflow が読めない・Adapter のない agent・このマシンで同じ agent の Run が開いたままは警告して開く。
 * 同じチケットの開いたままの手直しの Run は、この Run の開始を区切りとして閉じてから開く（closePreviousFixRun。reopensFix のない同じ step の二重起動では閉じずに拒む）。
 * retryReasons はもう一度の claim が開く手直しの Run に、直す指摘を最初から残すためのもの。
 * session・transcript は会話記録の場所（MT-2）。session は Run に、transcript はこのマシンの deguboard-local/transcripts/ に置く。
 * 渡されなければ、harness のフックが環境に入れた DEGUBOARD_SESSION・DEGUBOARD_TRANSCRIPT を使う（AG-9。セッションは sessionOf）。
 * transcript は agent の Adapter の会話記録の置き場所の下だけを受け付ける（ほかのファイルを読ませない）
 */
export async function openRun(
  ctx: CommandContext,
  ticket: Ticket,
  input: {
    step: string;
    agent: string;
    model?: string | undefined;
    retryReasons?: readonly string[] | undefined;
    /** 開始の時刻。省けば今（フックが、終わってから返った前景のサブエージェントの Run を開くときに前にする） */
    startedAt?: Date | undefined;
    /**
     * 手直しを新しく始める操作（もう一度の claim と、印の起動のフック）。手直しの step を開くとき、開いたままの前の手直しを
     * 閉じて開き直す。省けば（run start）同じチケットと step の Run が開いたままなら拒む
     */
    reopensFix?: boolean | undefined;
  } & TranscriptInput,
): Promise<{ run: Run; warnings: string[] }> {
  const { step, agent } = input;
  const warnings: string[] = [];
  const env = ctx.env ?? process.env;
  const session = sessionOf(ctx, input.session);
  const transcript = input.transcript ?? (env["DEGUBOARD_TRANSCRIPT"] || undefined);
  if (transcript !== undefined && !(await transcriptUnderRoot(agent, transcript, env))) {
    throw new OperationError(
      "VALIDATION_FAILED",
      `transcript accepts only files under the place where ${agent} keeps conversation records`,
    );
  }
  const workflow = ctx.store.workflowFor(ticket);
  if (workflow) {
    const found = findStep(workflow.resolved, step);
    if (!found.ok) {
      throw new OperationError(
        "VALIDATION_FAILED",
        `step ${step} is not in the steps of Workflow ${workflow.resolved.id} (${found.known.join(", ")})`,
      );
    }
  } else {
    warnings.push(
      `The Workflow of ${ticket.id} is not found or cannot be read, so step ${step} was not checked`,
    );
  }
  if (!agentNames().includes(agent)) {
    warnings.push(
      `agent ${agent} has no Adapter, so finish cannot take in usage or the model name (names with an Adapter: ${agentNames().join(", ")}. A subagent also starts with the name of its own Adapter)`,
    );
  }
  const startedAt = input.startedAt ?? ctx.now();
  // 同じチケットの次の Run の開始は、開いたままの手直しの Run の区切り。sync を待たずにその場で閉じてから開く（RN-6）。
  // 閉じられなくても開くのは止めない（後の sync が同じ区切りで閉じる）。
  // 同じチケットと step の Run が開いたままなら、下の startRun が拒むので閉じない（二重起動の拒否。SY-5）。
  // ただし手直しを開き直す操作（reopensFix）が開く手直しの step では、前の手直しを閉じて開き直す（RN-6）。
  // 二重起動の判定と前の手直しを閉じる処理は同じロックの中にないので、同じチケットの Run を別のプロセスが同時に開くと、
  // 拒まれた側が前の手直しを閉じることがある
  const duplicate = (await readRunningRuns(ctx.repo)).runs.some(
    (r) => r.data.ticket === ticket.id && r.data.step === step,
  );
  if (!duplicate || (input.reopensFix === true && step === openedStepOf(ctx, ticket, "reclaim"))) {
    await closePreviousFixRunOrWarn(ctx, ticket, { step, session, startedAt }, warnings);
  }
  // 同じ会話記録で期間が重なると、応答は後に始めた Run にだけ数える（同じ応答を二重に数えないため。MT-2）。閉じ忘れに気づけるように知らせる
  const open = (await readRunningRuns(ctx.repo)).runs.filter((r) => r.data.agent === agent);
  if (open.length > 0) {
    warnings.push(
      `${agent} Run ${open.map((r) => `${r.id} (${r.data.ticket} ${r.data.step})`).join(", ")} is still open on this machine. If it shares the same conversation record, the responses after this are counted only toward the new Run. Close finished Runs with dg run finish (you can ignore Runs of other agents working in parallel, or IDs you do not remember starting)`,
    );
  }
  const run = await startRun(ctx.repo, {
    ticket: ticket.id,
    step,
    agent,
    model: input.model,
    retryReasons: input.retryReasons,
    session,
    transcript,
    now: startedAt,
  });
  return { run, warnings };
}

/** closePreviousFixRun を呼び、失敗しても Run を開くのは止めずに警告にする */
async function closePreviousFixRunOrWarn(
  ctx: CommandContext,
  ticket: Ticket,
  input: { step: string; session: string | undefined; startedAt: Date },
  warnings: string[],
): Promise<void> {
  const { step, session, startedAt } = input;
  try {
    await closePreviousFixRun(
      ctx,
      ticket,
      { step, session, boundaryAt: toIsoDateTime(startedAt) },
      warnings,
    );
  } catch (e) {
    warnings.push(
      `Could not close the earlier fix Run of ${ticket.id} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/**
 * Run を開く操作のセッション ID。渡されなければ、harness のフックが環境に入れた DEGUBOARD_SESSION（AG-9）。
 * それもなければ、dg を呼んだエージェントの Adapter が環境から読むセッション ID（Adapter の sessionFromEnv）。
 * フックの環境が届かないサブエージェントの Bash でも、起動した親のセッションの ID になる
 */
export function sessionOf(ctx: CommandContext, session: string | undefined): string | undefined {
  const env = ctx.env ?? process.env;
  return session ?? (env["DEGUBOARD_SESSION"] || sessionFromEnv(env));
}

/**
 * 開いたままの Run が、今の操作とは別のセッションで開いたものか（RN-6）。別のセッションの Run は、そのセッションが落ちて
 * 閉じ損ねた残りとみなす（同じチケットと step を別のセッションで並行して動かすことは想定しない。並行していれば動いている方を閉じる）。
 * どちらかのセッションが分からなければ（セッションを渡さない製品・環境）false
 */
export function openedInOtherSession(run: Run, session: string | undefined): boolean {
  return run.session !== null && session !== undefined && run.session !== session;
}

/** 別のセッションで開いたままだった Run を interrupted で閉じるときのエラー（RN-6） */
export const STALE_SESSION_ERROR =
  "別のセッションで開いたままだった（落ちたセッションの残りとみなして閉じた）";

/** シンボリックリンクを解いたパス。まだないファイルは、あるところまでの親を解いて残りをつなぐ */
async function resolvedPath(p: string): Promise<string> {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(await realpath(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 会話記録のパスが agent の Adapter の置き場所の下か（HTTP・MCP・フックから任意のファイルを読ませない）。シンボリックリンクは解いて比べる。
 * 置き場所を持たない Adapter（フックのない製品。今はパスを読まない）の agent では確かめない
 */
export async function transcriptUnderRoot(
  agent: string,
  transcript: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const root = hooksOf(agent)?.transcriptRoot(env);
  if (!root) return true;
  const rel = path.relative(await resolvedPath(root), await resolvedPath(transcript));
  return !(rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** Run を開く操作（run start・ticket claim）が受け取る会話記録の場所 */
export interface TranscriptInput {
  session?: string | undefined;
  transcript?: string | undefined;
}

/** run start と ticket claim の入力の、会話記録の場所の項目（MT-2） */
export const transcriptFields = {
  session: z
    .string()
    .regex(/^\S+$/, "One word with no spaces or line breaks")
    .optional()
    .describe(
      "Session ID of the conversation record. Kept on the Run; finish and refresh count from that session's record. If omitted, uses DEGUBOARD_SESSION from the environment (set by the harness hook), else the session ID the calling agent sets in its environment (read by the Adapter; for a sub-agent, the parent session that started it), else null",
    ),
  transcript: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Path of the conversation record file. Not written to a Run that goes into Git; it is kept in deguboard-local/transcripts/ on this machine. If present, finish and refresh count from that file. Passed by the harness hook",
    ),
};

/** チケットの操作が開く Run の step（RN-5）。Workflow が読めなければ既定の名前（claim が開く step も同じ） */
export function openedStepOf(ctx: CommandContext, ticket: Ticket, opener: StepOpener): string {
  const wf = ctx.store.workflowFor(ticket);
  return wf ? stepOpenedOn(wf.resolved, opener) : DEFAULT_OPENED_STEPS[opener];
}

/** 操作が開く Run の呼び名（警告とコミットメッセージ）。claim は実装、reclaim は手直し */
export const openedRunLabel = (opener: StepOpener): string =>
  opener === "claim" ? "実装" : "手直し";

/** 警告に書く操作が開いた Run の呼び名（英語。コミットメッセージの openedRunLabel とは別に持つ） */
const openedRunWord = (opener: StepOpener): string =>
  opener === "claim" ? "implementation" : "fix";

/**
 * チケットの操作（claim は実装、reclaim は手直し。RN-5）が開く step の Run のうち、このマシンで実行中のもの。
 * 同じチケットと step の Run は 1 つしか実行中にならない。running を渡せば読み直さない
 */
export async function findOpenedRun(
  ctx: CommandContext,
  ticket: Ticket,
  opener: StepOpener,
  running?: readonly Doc<Run>[],
): Promise<Doc<Run> | undefined> {
  const step = openedStepOf(ctx, ticket, opener);
  const runs = running ?? (await readRunningRuns(ctx.repo)).runs;
  return runs.find((r) => r.data.ticket === ticket.id && r.data.step === step);
}

/**
 * move に付随して閉じる Run の開き手と結果（RN-6）。abandoned は実装と手直しを failure で閉じる。
 * PR の要らない作業（branch なし）の review、と PR のない done は実装を success で閉じる。branch のあるチケットの review は PR の記録・発見が閉じる。
 * 照合も終わったチケットの実装の Run をこの結果で閉じる（ticket move と同じ結果）
 */
export function runsClosedByMove(
  ticket: Ticket,
  to: Status,
): { openers: readonly StepOpener[]; result: "success" | "failure" } | undefined {
  if (to === "abandoned") return { openers: ["claim", "reclaim"], result: "failure" };
  if ((to === "review" && !ticket.branch) || (to === "done" && !ticket.pr))
    return { openers: ["claim"], result: "success" };
  return undefined;
}

/** チケットの操作か照合に付随して閉じた Run（RN-6） */
export interface ClosedOpenedRun {
  run: Run;
  /** 閉じたことの知らせと、使用量を取り込めなかった理由（finish と同じ） */
  warnings: string[];
}

/**
 * 操作が開いた Run をチケットの操作か照合に付随して閉じる（RN-6）。呼び出し側の書き込みの中で呼び、コミットの後に dropRunning で実行中の記録を消す。
 * 使用量は finish と同じく Adapter が会話記録から取り込む。finishedAt（PR の作成時刻・最後の push の時刻など）を渡せばその時刻までの応答を数える
 */
export async function closeOpenedRun(
  ctx: CommandContext,
  running: Doc<Run>,
  input: {
    opener: StepOpener;
    result: RunResult;
    error?: string | undefined;
    finishedAt?: string | undefined;
  },
): Promise<ClosedOpenedRun> {
  const now = ctx.now();
  const finishedAt = input.finishedAt ?? toIsoDateTime(now);
  const local = (await readRunningRuns(ctx.repo)).runs;
  const { others, transcriptOf } = await usageContext(ctx, local);
  const collected = await collectRunUsage(ctx.config, {
    run: running.data,
    finishedAt,
    env: ctx.env ?? process.env,
    topLevel: ctx.repo.topLevel,
    others,
    transcript: transcriptOf(running.data.id),
  });
  const run = await closeRun(ctx.store, ctx.repo, running.data.id, {
    result: input.result,
    error: input.error,
    model: collected.model ?? undefined,
    usage: collected.usage,
    tools: collected.tools,
    finishedAt,
    now,
  });
  return {
    run,
    warnings: [
      `Closed the ${openedRunWord(input.opener)} Run ${run.id} of ${run.ticket} with ${run.result} (finished_at ${run.finished_at})`,
      ...collected.warnings.map((w) => `Run ${run.id}: ${w}`),
    ],
  };
}

/**
 * チケットの操作か照合に付随して Run を閉じる（RN-6）。閉じる直前に別の文脈（別のプロセス・別のマシンの sync）が先に閉じていた
 * （REJECTED）なら、止めずに索引を読み直して警告だけ warnings に入れ、閉じなかったことを呼び出し側に知らせる（undefined）。
 * where は警告に書く呼び出し側の名前（照合・この操作）
 */
export async function closeOpenedRunUnlessClosed(
  ctx: CommandContext,
  running: Doc<Run>,
  input: Parameters<typeof closeOpenedRun>[2],
  where: string,
  warnings: string[],
): Promise<ClosedOpenedRun | undefined> {
  try {
    return await closeOpenedRun(ctx, running, input);
  } catch (e) {
    if (!(e instanceof OperationError) || e.code !== "REJECTED") throw e;
    await ctx.store.rescan();
    warnings.push(
      `${running.data.ticket}: the ${openedRunWord(input.opener)} Run ${running.id} was already closed (another operation or another machine closed it first), so it is not closed in ${where}`,
    );
    return undefined;
  }
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

/** チケットの操作と照合のコミットメッセージに書く、付随して閉じた Run の一覧。開いた操作ごとに呼び名を分ける */
export function describeClosedRuns(
  closed: ReadonlyArray<{
    run: { ticket: string; id: string; result: RunResult | null };
    opener: StepOpener;
  }>,
): string[] {
  const parts: string[] = [];
  for (const opener of ["claim", "reclaim"] as const) {
    const runs = closed.filter((c) => c.opener === opener);
    if (runs.length === 0) continue;
    parts.push(
      `${openedRunLabel(opener)}の Run を記録: ${runs.map((c) => `${c.run.ticket} ${c.run.id} ${c.run.result}`).join(", ")}`,
    );
  }
  return parts;
}

/** closeOpenedRunAlone が、別の文脈が先に閉じていた Run を閉じずに書き込みを捨てるための例外 */
class AlreadyClosed extends AbortWrite {}

/**
 * 操作が開いた Run を、それだけの書き込み（commit.mode に従ってコミット）で閉じる。
 * Run を開く処理が、開いたままの前の手直しの Run を次の Run の開始の区切りとして閉じるのに使う（RN-6）。
 * 別の文脈が先に閉じていた Run は、何も書かずに警告だけ返す（run は undefined）
 */
export async function closeOpenedRunAlone(
  ctx: CommandContext,
  running: Doc<Run>,
  input: Parameters<typeof closeOpenedRun>[2],
): Promise<{ run: Run | undefined; warnings: string[] }> {
  const rejected: string[] = [];
  try {
    const written = await withWrite(
      ctx,
      async () => {
        const closed = await closeOpenedRunUnlessClosed(
          ctx,
          running,
          input,
          "this operation",
          rejected,
        );
        if (!closed) throw new AlreadyClosed();
        return closed;
      },
      {
        message: ({ run }) =>
          `${openedRunLabel(input.opener)}の Run を記録: ${run.ticket} ${run.id} ${run.result ?? ""}`,
      },
    );
    await dropRunning(ctx.repo, running.data.id);
    return {
      run: written.value.run,
      warnings: [...written.write.warnings, ...written.value.warnings],
    };
  } catch (e) {
    if (!(e instanceof AlreadyClosed)) throw e;
    // 実行中の記録は closeRun が REJECTED の前に消している
    return { run: undefined, warnings: [...e.warnings, ...rejected] };
  }
}

/**
 * 開いたままの前の手直しの Run を、同じチケットの次の Run の開始（boundaryAt）を区切りとして閉じる（RN-6）。openRun が開く前に呼ぶので、
 * claim・もう一度の claim・起動のフック・run start のどこから開いても同じ規則になる。
 * 区切りの判定は sync の fixRunBoundary と同じで、手直しの Run の開始と同じ秒か後の開始だけを区切りに数える（前景の起動で前にした開始が手直しより前なら閉じない）。
 * 同じ秒を数えるのは、時刻が秒までの記録では前後を決められず、手直しの後に続けて見直しを開くと同じ秒になりうるため。
 * 前の Run の開始より後で区切りまでの最後の push の時刻で閉じ、push がなければ区切りの時刻にする（前景の手直しの起動では、
 * フックが来る時点で今回の push が済んでいることがあり、そのとき前の回の手直しは区切りの時刻で閉じる）。
 * 結果は success。ただし手直しの step を開くとき、前の手直しが別のセッションで開いたものなら、そのセッションが落ちた残りとみなして interrupted にする（RN-6）。
 * session は今の操作のセッション（どちらかが分からなければ success）。閉じた・閉じなかったことは warnings に入れる
 */
async function closePreviousFixRun(
  ctx: CommandContext,
  ticket: Ticket,
  input: { step: string; session: string | undefined; boundaryAt: string },
  warnings: string[],
): Promise<Run | undefined> {
  const stale = await findOpenedRun(ctx, ticket, "reclaim");
  if (!stale || input.boundaryAt < stale.data.started_at) return undefined;
  const pushedAt = ticket.branch
    ? await lastPushedAt(ctx.repo, ticket.branch, { fetch: true })
    : undefined;
  const { finishedAt, pushed } = fixRunFinishedAt({
    pushedAt,
    startedAt: stale.data.started_at,
    boundaryAt: input.boundaryAt,
  });
  const interrupted =
    input.step === stale.data.step && openedInOtherSession(stale.data, input.session);
  const closed = await closeOpenedRunAlone(ctx, stale, {
    opener: "reclaim",
    ...(interrupted
      ? { result: "interrupted" as const, error: STALE_SESSION_ERROR }
      : { result: "success" as const }),
    finishedAt,
  });
  // 別の文脈が先に閉じていたら、閉じずに警告だけ出す
  if (closed.run) {
    const when = pushed ? "the time of the last push" : "the start time, since there was no push";
    warnings.push(
      interrupted
        ? `${ticket.id}: the earlier fix Run ${stale.id} was still open in another session (${stale.data.session}), so it is treated as left over from a crashed session and closed as interrupted`
        : `${ticket.id}: closing the earlier fix Run ${stale.id} with the start of the next ${input.step} Run as the boundary, at ${when}`,
    );
  }
  warnings.push(...closed.warnings);
  return closed.run;
}

/** 空白・改行を含まない 1 語。step の語彙は openRun がチケットの Workflow の steps（WF-5）で確かめる。ticket claim の --agent も同じ形 */
export const token = z.string().regex(/^\S+$/, "One word with no spaces or line breaks");

export const runStart = defineCommand({
  name: "run.start",
  positionals: ["ticket", "step"],
  group: "run",
  summary:
    "Start a Run. The running record is kept only in deguboard-local/runs/ and is not put into Git. Rejected if a Run for the same ticket and step is running, or if the step is not in the ticket's Workflow steps. Warns and starts if a Run for the same agent is running on this machine. An agent name with no Adapter is recorded without rejection, with a warning. An open fix Run on the same ticket is closed with success at the last push after its start (or at this start's time if there is none), using this start as the boundary, and then this Run starts (when a fix step starts, an earlier fix Run from a different session is closed as interrupted). When this is rejected because a Run for the same ticket and step is running, the fix Run is not closed either. If --agent is omitted, the Adapter detects the agent calling dg from environment variables (if it cannot, it is a usage error)",
  input: z.object({
    ticket: ticketRef,
    step: token.describe("Step. An id from the ticket's Workflow steps (see dg workflow show)"),
    agent: token
      .optional()
      .describe(
        `Agent name. For ${agentNames().join(", ")}, finish imports usage from the conversation record (metrics.read_transcripts). If omitted, the agent calling dg is detected from environment variables; if that fails, it is a usage error`,
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model name (an alias is fine). If finish can get the official name from the conversation record, that is recorded; this name is used only when it cannot. If unknown, omit it (it stays null)",
      ),
    ...transcriptFields,
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    let agent = input.agent;
    if (!agent) {
      const detected = agentFromEnv(ctx.env ?? process.env);
      if (detected.agent === null) throw new UsageError(detected.reason);
      agent = detected.agent;
    }
    const ticket = ctx.store.require("ticket", input.ticket);
    const { run, warnings } = await openRun(ctx, ticket.data, {
      step: input.step,
      agent,
      model: input.model,
      session: input.session,
      transcript: input.transcript,
    });
    return ok(run, undefined, warnings);
  },
});

/**
 * 印で頼んだサブエージェントがまだ動いている Run（フックが付けた live の印。バックグラウンドの起動か再開の後、止まる前）を閉じるのを拒む（t638）。
 * 先に閉じると、その後の作業を使用量とツールの回数に数えず、見直し役の run review-result が書く先を失って保留になり、
 * 見直しの回が二重になった（t637）。止まればフックが閉じるか、止まって待っている印を付ける。
 * 返らないまま止まった Run は --result interrupted で閉じられる（呼び出し側が拒まない）
 */
async function rejectLiveSubagentRun(ctx: CommandContext, run: Run): Promise<void> {
  // 止まったフックは Run を閉じるか、止まって待っている印・書き終わり待ちの印を付ける。起動のフックが live を書く前に
  // 止まりのフックが結び付け直した（起動と止まりが重なった）ときは live が残るので、どちらかの印があれば止まったとみなす
  if (run.waiting_since !== null || run.settling_since !== null) return;
  if (!(await isLiveSubagent(ctx.repo, run.id))) return;
  throw new OperationError(
    "REJECTED",
    `Run ${run.id} is a Run of a subagent requested with a marker, and the subagent has not stopped yet. Wait for the subagent's end notice (the hook closes it once it stops). ` +
      "If it stopped without returning, close it with --result interrupted",
  );
}

export const runFinish = defineCommand({
  name: "run.finish",
  positionals: ["run"],
  group: "run",
  summary:
    "Close the running Run and write its completion totals to runs/ (commits per commit.mode). Close a stopped Run with --result interrupted. Usage and tool counts (tools) are not taken as self-reports; the agent's Adapter imports them from the conversation record. If usage cannot be read, it stays null with a warning. With an Adapter that does not count tools, tools is null. " +
    "A Run that is already closed (such as an implementation Run closed by a ticket operation) is returned unchanged with a warning. " +
    "A Run whose sub-agent was asked with the marker and is still running (after a background start or resume, before it stops) is rejected except with --result interrupted (the hook closes it when it stops)",
  input: z.object({
    run: z.string().min(1).describe("Run ID (r20261031-041500-3fa2)"),
    result: z.enum(RUN_RESULTS).describe("success, failure, or interrupted"),
    error: z.string().min(1).optional().describe("Reason for failure or interruption"),
    retries: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Number of retries. If omitted and reasons are given, the number of reasons"),
    retry_reasons: z
      .array(
        z
          .string()
          .regex(/^[^\r\n]+$/, "Write each reason on one line")
          .regex(/\S/, "The reason is only whitespace"),
      )
      .meta({ freeText: true })
      .optional()
      .describe(
        "Reasons for retrying. One-line summary of the findings fixed in a review or a person's review. Do not write secrets, command strings, or paths",
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model name. Used only when it cannot be read from the conversation record (preferred over the name given at start)",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (!isRunId(input.run))
      throw new UsageError(`${input.run} is not in the form of a Run ID (r20261031-041500-3fa2)`);
    // 空の配列は省いたのと同じに扱う
    const reasons = input.retry_reasons?.length ? input.retry_reasons : undefined;
    if (reasons && input.retries !== undefined && input.retries !== reasons.length) {
      throw new UsageError(
        `The retry count (${input.retries}) and the number of reasons (${reasons.length}) do not match. To use the number of reasons as the count, omit the count`,
      );
    }
    const now = ctx.now();
    const id = input.run as RunId;
    // 閉じた Run（ticket update --pr・sync・unclaim・move が閉じた実装の Run など。RN-6）は書き換えず（RN-4）、記録をそのまま返す
    const alreadyClosed = (doc: Doc<Run>) =>
      ok(doc.data, undefined, [
        `Run ${doc.id} is already closed with ${doc.data.result} (finished_at ${doc.data.finished_at}). The record is not changed`,
      ]);
    const local = (await readRunningRuns(ctx.repo)).runs;
    const running = local.find((r) => r.id === id);
    const closed = running ? undefined : ctx.store.runs.get(id);
    if (closed) return alreadyClosed(closed);
    // 実行中の記録がなければ取り込まず、finishRun が見つからない・終わっていると拒否する
    const usage = running ? await usageContext(ctx, local) : undefined;
    if (running && input.result !== "interrupted") await rejectLiveSubagentRun(ctx, running.data);
    const collected =
      running && usage
        ? await collectRunUsage(ctx.config, {
            run: running.data,
            finishedAt: toIsoDateTime(now),
            env: ctx.env ?? process.env,
            topLevel: ctx.repo.topLevel,
            others: usage.others,
            transcript: usage.transcriptOf(id),
          })
        : undefined;
    try {
      const { run, write } = await finishRun(ctx, id, {
        result: input.result,
        error: input.error,
        retries: input.retries ?? reasons?.length,
        retryReasons: reasons,
        // 会話記録のモデル名 > 明示したモデル名 > 実行中の記録のモデル名（別名でなく正式な ID を残す）
        model: collected?.model ?? input.model,
        usage: collected?.usage,
        tools: collected?.tools,
        now,
      });
      return ok(run, write, collected?.warnings ?? []);
    } catch (e) {
      // 上で見た後に別の操作（ticket update --pr・sync、別のプロセスの finish）が閉じたか、索引が古い（長く動く serve・mcp）。
      // 集計を読み直し、閉じていれば同じく記録を変えずに返す
      if (!(e instanceof OperationError) || e.code !== "REJECTED") throw e;
      await ctx.store.rescan();
      const summary = ctx.store.runs.get(id);
      if (!summary) throw e;
      return alreadyClosed(summary);
    }
  },
});

/** 書く先の見直しの Run がなく、結果を保留にしたときの返り値（RN-9） */
export interface PendingReviewView {
  ticket: string;
  review: RunReview;
  pending: true;
  at: string;
}

/** フックが見直しの Run を結果の記録なしに閉じたときの error（RN-4）。後から結果を書けば success に直す */
export const REVIEW_UNRECORDED =
  "見直し役が結果を記録せずに終わった（dg run review-result で書く）";

const findingCount = z.number().int().nonnegative();

/**
 * 指摘の一覧から見直しの結果を求める。重いのは severity が heavy か、category がリポジトリの重いとみなす種類（review.heavy_categories）のもの。
 * 通ったかは重い指摘が残っていないこと（見直し役の自己申告にしない）
 */
export function reviewOfFindings(
  findings: readonly ReviewFinding[],
  heavyCategories: readonly string[],
): RunReview {
  const heavy = findings.filter((f) => isHeavyFinding(f, heavyCategories)).length;
  return { heavy, light: findings.length - heavy, passed: heavy === 0 };
}

export const runReviewResult = defineCommand({
  name: "run.review-result",
  positionals: ["ticket"],
  group: "run",
  summary:
    "Write the review result (the counts of heavy and light findings, and whether it passed) to the Run of the ticket's review step. Call it once before the reviewer returns its list of findings. If a review Run is running on this machine, the result is written to it (calling again replaces it); otherwise it is written to the ticket's latest Run only when that is a closed review Run with no result yet (committed per commit.mode. If a later Run such as a fix has started, or a result already exists, it belongs to an earlier review and is not written). " +
    "A closed Run that closed with failure and no result record is changed to success. If neither applies (a reviewer started in the foreground), the result is held (pending: true), and the hook links it when it closes the review Run. " +
    "Findings are passed with --findings-file (a JSON or YAML array; each item has severity, category, file, line, reason, and fix). dg validates them against the schema (an error shows its location, as INVALID_INPUT); heavy is the findings with severity heavy or a category in review.heavy_categories, light is the rest, and passed means no heavy findings. The list is kept in deguboard-local, and only the counts are written to the Run in Git. " +
    "The form that passes only counts with --heavy, --light, and --passed remains for an earlier version of the reviewer, but counts are self-reported, so it warns. It cannot be used with --findings-file; giving --passed when there are heavy findings is a usage error",
  input: z.object({
    ticket: ticketRef,
    findings: z
      .array(reviewFindingSchema)
      .meta({ cliFile: "findings-file" })
      .optional()
      .describe("List of findings. An empty array if there are none"),
    heavy: findingCount
      .optional()
      .describe(
        "Earlier form: number of heavy findings (missed acceptance criteria, bugs, mismatches with the documents, rule violations)",
      ),
    light: findingCount
      .optional()
      .describe(
        "Earlier form: number of light findings (wording and preferences, including mismatches with the reference section)",
      ),
    passed: z
      .boolean()
      .optional()
      .describe("Earlier form: passed (no heavy findings remain). Omit if it did not pass"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const counted =
      input.heavy !== undefined || input.light !== undefined || input.passed !== undefined;
    const warnings: string[] = [];
    let review: RunReview;
    if (input.findings !== undefined) {
      if (counted)
        throw new UsageError(
          "--findings-file cannot be used with --heavy, --light, or --passed (the counts are taken from the list)",
        );
      review = reviewOfFindings(input.findings, ctx.config.review.heavy_categories);
    } else {
      if (input.heavy === undefined || input.light === undefined)
        throw new UsageError(
          "Pass the findings list with --findings-file (for the earlier form, use --heavy and --light)",
        );
      const passed = input.passed ?? false;
      if (passed && input.heavy > 0)
        throw new UsageError(`There are ${input.heavy} heavy findings, but --passed was given`);
      review = { heavy: input.heavy, light: input.light, passed };
      warnings.push(
        "A call with counts only makes the counts self-reported. If the findings list is passed with --findings-file, dg works out the counts and whether the review passed",
      );
    }
    const ticket = ctx.store.require("ticket", input.ticket).data;
    // 回の記録は書いた先の Run（保留なら null）と一緒に deguboard-local に置く（置き場所の理由は run/record.ts）。
    // 数だけの呼び方も回として置く（一覧は null）。前の回の一覧を最新として使わせないため
    const keep = async (run: Run | null) => {
      await putReviewRound(ctx.repo, ticket.id, {
        run: run?.id ?? null,
        at: toIsoDateTime(ctx.now()),
        review,
        findings: input.findings ?? null,
      });
      if (!run) return;
      // この Run の間に保留にした結果（Run を先に閉じられて書く先を失った回など）は、今書いた結果に置き換わる。
      // 保留と保留の回を残すと、同じ見直しが 2 回になる（t638）
      await takePendingReview(ctx.repo, ticket.id, run.started_at);
      await adoptPendingRounds(ctx.repo, ticket.id, run.id, run.started_at);
    };
    const local = (await readRunningRuns(ctx.repo)).runs;
    const running = local.find((r) => r.data.ticket === ticket.id && r.data.step === REVIEW_STEP);
    if (running) {
      try {
        const amended = await amendRunning(ctx.repo, running.data.id, { review });
        await keep(amended);
        return ok<Run | PendingReviewView>(amended, undefined, warnings);
      } catch (e) {
        // 読んだ後にフックが閉じた。閉じた Run に書く
        if (!(e instanceof OperationError) || (e.code !== "NOT_FOUND" && e.code !== "REJECTED"))
          throw e;
        await ctx.store.rescan();
      }
    }
    // フックが先に閉じたとき。チケットの最新の Run（実行中を含む。開始の順、同じ秒なら ID の順）が閉じた見直しの Run のときだけ書く。
    // 後に別の Run（手直しなど）が始まっていれば、それは前の回の見直しなので書かない
    const latest = async () => {
      // 集計のある Run は閉じたものとして数える（実行中の記録は消す前に残りうる）。書き込みの中では読み直す
      const local = (await readRunningRuns(ctx.repo)).runs;
      const runs = [
        ...local
          .filter((r) => !ctx.store.runs.has(r.data.id))
          .map((r) => ({ run: r.data, closed: false })),
        ...[...ctx.store.runs.values()].map((d) => ({ run: d.data, closed: true })),
      ].filter(({ run }) => run.ticket === ticket.id);
      const last = runs
        .sort(
          (a, b) =>
            a.run.started_at.localeCompare(b.run.started_at) || a.run.id.localeCompare(b.run.id),
        )
        .at(-1);
      return last?.closed && last.run.step === REVIEW_STEP
        ? ctx.store.runs.get(last.run.id)
        : undefined;
    };
    // 前景で起動した見直し役は、動いている間に Run がない。保留にして、フックが Run を閉じるときに結び付ける（RN-9）
    const hold = async () => {
      const at = toIsoDateTime(ctx.now());
      await putPendingReview(ctx.repo, ticket.id, { review, at });
      await keep(null);
      const view: PendingReviewView = { ticket: ticket.id, review, pending: true, at };
      return ok<Run | PendingReviewView>(view, undefined, [
        ...warnings,
        `There is no review Run for ${ticket.id} yet, so the result is held. The hook links it when it closes the review Run`,
      ]);
    };
    // 結果のある閉じた Run は前の回の見直し（間に手直しを挟まずに前景の見直しを続けたとき）。書き換えず（RN-4）、保留にする
    const found = await latest();
    if (!found || found.data.review !== null) return hold();
    const written = await withWrite(
      ctx,
      async () => {
        const doc = await latest();
        if (!doc)
          throw new OperationError(
            "REJECTED",
            `The closed review Run of ${ticket.id} is no longer the latest during the write. Call again`,
          );
        if (doc.data.review !== null)
          throw new OperationError(
            "REJECTED",
            `A result was written to the closed review Run ${doc.id} during the write (the result of a closed Run is not rewritten. RN-4)`,
          );
        const unrecorded = doc.data.result === "failure" && doc.data.error === REVIEW_UNRECORDED;
        return (
          await ctx.store.update("run", doc.id, {
            review,
            ...(unrecorded ? { result: "success", error: null } : {}),
          })
        ).data;
      },
      { message: (run) => `見直しの結果を記録: ${run.ticket} ${run.id}` },
    );
    await keep(written.value);
    return ok<Run | PendingReviewView>(written.value, written.write, warnings);
  },
});

/** 書き足す先の手直しの Run がなく、理由を保留にしたときの返り値（RN-8） */
export interface PendingRetryReasonsView {
  ticket: string;
  reasons: string[];
  pending: true;
  at: string;
}

export const runRetryReason = defineCommand({
  name: "run.retry-reason",
  positionals: ["ticket"],
  group: "run",
  summary:
    "Add the reason for a fix retry (a one-line summary of a finding that was fixed) to the retry_reasons of the ticket's open fix Run (the step with opens_on: reclaim, or else fix). A usage error for a ticket with no PR. The count becomes the number of reasons. A fix sub-agent started with the marker step=fix calls it before it starts fixing. " +
    "If a fix Run on this machine is running and started after the ticket's last review Run, the reason is added to it. Otherwise (a fix started in the foreground, or only an earlier fix Run is open), the reason is held (pending: true), and when the hook closes the fix Run, the reasons placed after that Run's start are linked to it",
  input: z.object({
    ticket: ticketRef,
    reasons: z
      .array(
        z
          .string()
          .regex(/^[^\r\n]+$/, "Write each reason on one line")
          .regex(/\S/, "The reason is only whitespace"),
      )
      .min(1)
      .meta({ freeText: true })
      .describe(
        "One-line summary of a fixed finding (from the reviewer or a person's review). One per item, repeated. Do not write that failing checks were fixed. Do not write secrets, command strings, or paths",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    // 手直しは PR のあるチケットの作業（RN-5 のもう一度の claim と同じ）。打ち間違いで要らない保留を残さない
    if (ticket.pr === undefined)
      throw new UsageError(`${ticket.id} has no PR, so fix reasons cannot be written`);
    const step = openedStepOf(ctx, ticket, "reclaim");
    const local = (await readRunningRuns(ctx.repo)).runs;
    // 最後の見直しより前に始まった手直しの Run は、その見直しの前の回のもの（sync がまだ閉じていない）。書き足さない（dg next の待つ手直しと同じ見方）。
    // 修正ループは手直しと見直しを交互に行うので、見直しの開始が回の区切りになる。見直しを挟まずに前景の手直しを続けて頼み、
    // その間に照合も走らないと、2 回目の理由が前の回の Run に入る
    const lastReviewAt = [
      ...local.map((r) => r.data),
      ...[...ctx.store.runs.values()].map((d) => d.data),
    ]
      .filter((r) => r.ticket === ticket.id && r.step === REVIEW_STEP)
      .reduce((max, r) => (r.started_at > max ? r.started_at : max), "");
    const running = local.find(
      (r) =>
        r.data.ticket === ticket.id && r.data.step === step && r.data.started_at >= lastReviewAt,
    );
    if (running) {
      try {
        return ok<Run | PendingRetryReasonsView>(
          await appendRetryReasons(ctx.repo, running.data.id, input.reasons),
        );
      } catch (e) {
        // 読んだ後に閉じた。保留にして、次に開く手直しの Run に回す
        if (!(e instanceof OperationError) || (e.code !== "NOT_FOUND" && e.code !== "REJECTED"))
          throw e;
      }
    }
    const at = toIsoDateTime(ctx.now());
    await putPendingRetryReasons(ctx.repo, ticket.id, input.reasons, at);
    const view: PendingRetryReasonsView = {
      ticket: ticket.id,
      reasons: input.reasons,
      pending: true,
      at,
    };
    return ok<Run | PendingRetryReasonsView>(view, undefined, [
      `There is no fix Run for ${ticket.id} yet, so the reasons are held. The hook links them when it closes the fix Run`,
    ]);
  },
});

/**
 * 親が手直しに渡す指摘を、作業ブランチの最新の見直しの回に記録する（t639）。渡した軽い指摘は、手直しの文の直す指摘に入り、
 * dg pr ready の「直さなかった軽い指摘」から外れる。一覧にない指摘は使い方の誤り（手直しの文と PR の本文を誤らせないため）
 */
export const runHandoff = defineCommand({
  name: "run.handoff",
  positionals: ["ticket"],
  group: "run",
  summary:
    "Record the findings that the parent hands to the fix on the latest review of the work branch (deguboard-local; not written to Git). The handed-over findings go into the findings to fix in the fix instructions (brief --role fix), and whether or not they were fixed, they drop out of the 'light findings not fixed' list that dg pr ready shows (the parent reports any it returned unfixed). A finding has the same form as one item in the review list (run review-result), and only findings in the latest review list are accepted (a finding that is not there, or no review list at all, is a usage error). Calling again replaces it",
  input: z.object({
    ticket: ticketRef,
    findings: z
      .array(reviewFindingSchema)
      .min(1)
      .meta({ cliFile: "findings-file" })
      .describe(
        "List of findings to hand to the fix. Copied from the latest review list (a JSON array; one item has the same form as in review-result)",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    const stored = await readReviewFindings(ctx.repo, ticket.id);
    const round = stored && latestRoundSince(stored.rounds, ticket.branch_at);
    if (!round?.findings)
      throw new OperationError(
        "VALIDATION_FAILED",
        `There is no review findings list for the work branch of ${ticket.id}`,
        "First record the review findings with dg run review-result --findings-file",
      );
    const { matched, unmatched } = matchFindings(round.findings, input.findings);
    if (unmatched.length > 0)
      throw new OperationError(
        "VALIDATION_FAILED",
        "Some findings passed to the fix are not in the latest review list",
        unmatched.map((f) => `- ${findingText(f)}`).join("\n"),
      );
    await setHandedFindings(ctx.repo, ticket.id, ticket.branch_at, matched);
    return ok({ ticket: ticket.id, handed: matched.length });
  },
});

export const runList = defineCommand({
  name: "run.list",
  group: "run",
  summary:
    "List Runs in start order. Also lists unfinished Runs (running: true, from deguboard-local/runs/ on this machine). Iteration and Project follow each ticket's current value (same as metrics.show). duration_seconds is the run time (null if unfinished)",
  input: z.object({
    ticket: ticketRef.optional().describe("Only Runs of this ticket"),
    iteration: iterationRef
      .optional()
      .describe(
        "Only Runs of tickets in this Iteration. An Iteration that does not exist now (a typo, or a document deleted directly) returns an empty list rather than an error. As with the ticket.list and metrics.show filters, existence is not checked",
      ),
    project: slugSchema.optional().describe("Only Runs of tickets in this Project"),
    running: z.boolean().optional().describe("Only unfinished Runs"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = input.ticket ? ctx.store.require("ticket", input.ticket).data.id : undefined;
    // ticket.list・metrics.show と同じく、今あるかは確かめず ID の形だけ整える（入力の説明を見る）
    const iteration = idShapeOf(input.iteration, "iteration");
    const local = await readRunningRuns(ctx.repo);
    const runs: Array<{ run: Run; running: boolean }> = [
      // runs/ に集計がある実行中の記録（記録を消す前に止まった finish の残り）は readRunningRuns が消す
      ...local.runs.map((d) => ({ run: d.data, running: true })),
      ...(input.running
        ? []
        : [...ctx.store.runs.values()].map((d) => ({ run: d.data, running: false }))),
    ];
    const placed = runs.map((r) => ({
      ...r,
      at: placeRun(r.run, ctx.store.tickets.get(r.run.ticket)?.data),
    }));
    const filter: MetricFilter = {
      ...(ticket ? { ticket } : {}),
      ...(iteration ? { iteration } : {}),
      ...(input.project ? { project: input.project } : {}),
    };
    const items: RunView[] = filterRuns(placed, filter)
      .map(({ run, running }) => ({ ...run, running, duration_seconds: runDurationSeconds(run) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const warnings = local.issues.map((i) => `deguboard-local/${i.path}: ${i.message}`);
    return ok(items, undefined, warnings);
  },
});

/** 取り直しで比べる値。usage の 4 つは usage.<キー> と書く。ツールの回数（tools）は取り直さない（RN-4） */
const REFRESH_FIELDS = ["model", "input", "output", "cache_read", "cache_write"] as const;
type RefreshField = (typeof REFRESH_FIELDS)[number];
type UsageKey = Exclude<RefreshField, "model">;
const fieldLabel = (f: RefreshField) => (f === "model" ? "model" : `usage.${f}`);

/** 取り直した 1 件。changes は書き換える（dry_run では書き換えることになる）値、kept は取れずに今の値を残した値 */
export interface RunRefreshItem {
  id: RunId;
  ticket: string;
  agent: string;
  /** to が null なのは値を消すとき（usage.estimated だけ） */
  changes: Array<{
    field: string;
    from: string | number | boolean | null;
    to: string | number | null;
  }>;
  kept: string[];
  updated: boolean;
}

/**
 * 会話記録から取れた値だけを今の記録に重ねる。取れなかった値（null）は今の値を残す。
 * 使用量の 4 つをすべて取り直せたら、推定の印（usage.estimated）は外す（RN-2）
 */
function refreshPlan(
  run: Run,
  collected: { model: string | null; usage: Partial<Record<UsageKey, number | null>> },
) {
  const changes: RunRefreshItem["changes"] = [];
  const kept: string[] = [];
  const usage: Partial<RunUsage> = {};
  let model: string | undefined;
  for (const field of REFRESH_FIELDS) {
    const now = field === "model" ? run.model : run.usage[field];
    const next = field === "model" ? collected.model : (collected.usage[field] ?? null);
    if (next === null) {
      kept.push(fieldLabel(field));
      continue;
    }
    if (next === now) continue;
    changes.push({ field: fieldLabel(field), from: now, to: next });
    if (field === "model") model = next as string;
    else usage[field] = next as number;
  }
  const allUsage = REFRESH_FIELDS.every((f) => f === "model" || collected.usage[f] != null);
  const dropEstimated = allUsage && run.usage.estimated !== undefined;
  if (dropEstimated)
    changes.push({ field: "usage.estimated", from: run.usage.estimated!, to: null });
  return { changes, kept, model, usage, dropEstimated };
}

/**
 * Adapter の警告の末尾の「null で残す」は finish の言い方なので外し、取り直しの末尾（今の値を残す）は呼ぶ側が付ける。
 * Adapter の文言が変わって外せなくても、末尾は必ず「今の値を残す」になる
 */
const keepWording = (warning: string) =>
  `${warning.replace(/\. (Usage is )?[Ll]eft as null$/, "")}. Keep the current value`;

export const runRefresh = defineCommand({
  name: "run.refresh",
  positionals: ["runs"],
  group: "run",
  summary: `Re-read the model name and usage of closed Runs from the conversation record through the agent's Adapter (same search as finish; follows metrics.read_transcripts and DEGUBOARD_NO_TRANSCRIPTS). Only values that are read are rewritten; values that cannot be read keep their current value and produce a warning. A Run more than ${TRANSCRIPT_RETENTION_DAYS} days past its finished_at has its conversation record location cleaned up (run prune-transcripts), so it is not re-read; its current values are kept and a warning is given. With --dry-run nothing is written; only the differences (changes) are returned`,
  input: z.object({
    runs: z
      .array(z.string().min(1))
      .min(1)
      .describe("ID of a closed Run (r20261031-041500-3fa2). Can be given more than once"),
    dry_run: z
      .boolean()
      .optional()
      .describe("Do not rewrite; return only the differences that would be written"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ids = [...new Set(input.runs)] as RunId[];
    const closed = (id: RunId) => {
      const doc = ctx.store.runs.get(id);
      if (!doc) throw new OperationError("NOT_FOUND", `Closed Run ${id} not found`);
      return doc;
    };
    const local = (await readRunningRuns(ctx.repo)).runs;
    const running = new Set(local.map((r) => r.id));
    for (const id of ids) {
      if (!isRunId(id))
        throw new UsageError(`${id} is not in the form of a Run ID (r20261031-041500-3fa2)`);
      if (running.has(id))
        throw new OperationError(
          "REJECTED",
          `Run ${id} is still running. If it is closed with dg run finish ${id}, finish takes in the values from the conversation record`,
        );
      closed(id);
    }
    const warnings: string[] = [];
    /** Adapter が理由を警告した Run。kept の警告を重ねて出さない */
    const explained = new Set<RunId>();
    const collected = new Map<string, Awaited<ReturnType<typeof collectRunUsage>>>();
    const { others, transcriptOf } = await usageContext(ctx, local);
    const now = ctx.now();
    for (const id of ids) {
      const run = closed(id).data;
      // 期間を過ぎた Run は場所を片付けうる。場所なしの探し方（セッション・推測）で別の記録を数えないよう、読まずに残す
      const got = transcriptExpired(run, now)
        ? {
            usage: { input: null, output: null, cache_read: null, cache_write: null },
            model: null,
            tools: null,
            warnings: [
              `A Run more than ${TRANSCRIPT_RETENTION_DAYS} days past its end time (finished_at) is not read again, because its conversation record location is cleaned up`,
            ],
          }
        : await collectRunUsage(ctx.config, {
            run,
            // 閉じた Run は終了日時で期間を区切る（finish と同じ範囲を読む）。会話記録の場所も finish と同じ
            finishedAt: run.finished_at ?? run.started_at,
            env: ctx.env ?? process.env,
            topLevel: ctx.repo.topLevel,
            others,
            transcript: transcriptOf(id),
          });
      collected.set(id, got);
      if (got.warnings.length > 0) explained.add(id);
      warnings.push(...got.warnings.map((w) => `Run ${id}: ${keepWording(w)}`));
    }
    // 書き込みのやり直し（push の拒否）で索引が読み直されても、その時の記録に重ねる
    const plan = (): RunRefreshItem[] =>
      ids.map((id) => {
        const run = closed(id).data;
        const { changes, kept } = refreshPlan(run, collected.get(id)!);
        return { id, ticket: run.ticket, agent: run.agent, changes, kept, updated: false };
      });
    const items = plan();
    for (const item of items) {
      if (item.kept.length > 0 && !explained.has(item.id))
        warnings.push(
          `Run ${item.id}: ${item.kept.join(", ")} could not be read from the conversation record, so the current values are kept`,
        );
    }
    if (input.dry_run || items.every((i) => i.changes.length === 0)) {
      return ok(items, undefined, warnings);
    }
    const written = await withWrite(
      ctx,
      async () => {
        const next = plan();
        for (const item of next) {
          if (item.changes.length === 0) continue;
          const doc = closed(item.id as RunId);
          const { model, usage, dropEstimated } = refreshPlan(doc.data, collected.get(item.id)!);
          const base = doc.raw;
          // usage の中の未知のキーは残す（DT-2）
          const nextUsage = { ...(base["usage"] as Record<string, unknown>), ...usage };
          if (dropEstimated) delete nextUsage["estimated"];
          await ctx.store.update("run", item.id, {
            ...(model === undefined ? {} : { model }),
            usage: nextUsage,
          });
          item.updated = true;
        }
        return next;
      },
      {
        message: (done) =>
          `Run を会話記録から取り直す: ${done
            .filter((i) => i.updated)
            .map((i) => i.id)
            .join(" ")}`,
      },
    );
    return ok(written.value, written.write, warnings);
  },
});

export interface RunPruneTranscriptsResult {
  /** 消した（--dry-run では消すことになる）会話記録のパスの Run の ID と理由 */
  removed: PrunedTranscript[];
  /** 残した数 */
  kept: number;
}

export const runPruneTranscripts = defineCommand({
  name: "run.prune-transcripts",
  group: "run",
  summary: `Delete the conversation record paths in deguboard-local/transcripts/ on this machine for Runs more than ${TRANSCRIPT_RETENTION_DAYS} days past their finished_at (expired), and for IDs that have neither a running record nor an aggregate in runs/ (orphan). Records that point to the same file as a Run in the window are kept. Runs deleted here are not re-read by run refresh. Nothing is written to Git. With --dry-run nothing is deleted; only what would be deleted is returned`,
  input: z.object({
    dry_run: z.boolean().optional().describe("Delete nothing; return only what would be deleted"),
  }),
  // Git には書かないが、このマシンのファイルを消すので書くコマンドにする（MCP で読むだけのツールに見せない。retry-reason と同じ）
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result: RunPruneTranscriptsResult = await pruneTranscripts(
      ctx.repo,
      (id) => ctx.store.runs.get(id as RunId)?.data,
      ctx.now(),
      input.dry_run ?? false,
    );
    return ok(result);
  },
});

export const runCommands = [
  runStart,
  runFinish,
  runReviewResult,
  runHandoff,
  runRetryReason,
  runList,
  runRefresh,
  runPruneTranscripts,
];
