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
import { isHeavyFinding } from "../run/findings.js";
import {
  amendRunning,
  appendRetryReasons,
  closeRun,
  putPendingReview,
  putReviewRound,
  putPendingRetryReasons,
  dropRunning,
  finishRun,
  pruneTranscripts,
  readRunningRuns,
  readTranscriptPaths,
  startRun,
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
      ? `環境変数から ${matched.join("・")} のどれとも判定できる`
      : `環境変数から agent を判定できない（判定できるのは環境変数を付ける Adapter だけ）`;
  return { agent: null, reason: `${reason}。--agent でエージェント名を渡す` };
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
      `transcript は ${agent} の会話記録の置き場所の下のファイルだけを受け付ける`,
    );
  }
  const workflow = ctx.store.workflowFor(ticket);
  if (workflow) {
    const found = findStep(workflow.resolved, step);
    if (!found.ok) {
      throw new OperationError(
        "VALIDATION_FAILED",
        `step ${step} は Workflow ${workflow.resolved.id} の steps にない（${found.known.join("・")}）`,
      );
    }
  } else {
    warnings.push(
      `${ticket.id} の Workflow が見つからないか読めないので、step ${step} を確かめていない`,
    );
  }
  if (!agentNames().includes(agent)) {
    warnings.push(
      `agent ${agent} には Adapter がないので、finish は使用量とモデル名を取り込めない（Adapter のある名前: ${agentNames().join("・")}。サブエージェントも自分の Adapter の名前で始める）`,
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
      `このマシンで ${agent} の Run ${open.map((r) => `${r.id}（${r.data.ticket} ${r.data.step}）`).join("・")}が開いたまま。同じ会話記録なら、この後の応答は新しい Run にだけ数える。終わった Run は dg run finish で閉じる（並行する別のエージェントの Run や、自分が始めた覚えのない ID なら無視してよい）`,
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
      `${ticket.id} の前の手直しの Run を閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
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
    .regex(/^\S+$/, "空白・改行を含まない 1 語")
    .optional()
    .describe(
      "会話記録のセッション ID。Run に残し、finish と refresh はそのセッションの記録から数える。省けば環境の DEGUBOARD_SESSION（harness のフックが入れる）、なければ dg を呼んだエージェントが環境に付けるセッション ID（Adapter が読む。サブエージェントでは起動した親のセッション）、どれもなければ null",
    ),
  transcript: z
    .string()
    .min(1)
    .optional()
    .describe(
      "会話記録のファイルのパス。Git に入る Run には書かず、このマシンの deguboard-local/transcripts/ に置く。あれば finish と refresh はそのファイルから数える。harness のフックが渡す",
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
      `${run.ticket} の${openedRunLabel(input.opener)}の Run ${run.id} を ${run.result} で閉じた（finished_at ${run.finished_at}）`,
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
      `${running.data.ticket}: ${openedRunLabel(input.opener)}の Run ${running.id} は既に閉じていた（別の操作や別のマシンが先に閉じた）ので、${where}では閉じない`,
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
        const closed = await closeOpenedRunUnlessClosed(ctx, running, input, "この操作", rejected);
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
    const when = pushed ? "最後の push の時刻" : "、push がないので開始の時刻";
    warnings.push(
      interrupted
        ? `${ticket.id}: 前の手直しの Run ${stale.id} は別のセッション（${stale.data.session}）で開いたままだったので、落ちたセッションの残りとみなして interrupted で閉じる`
        : `${ticket.id}: 前の手直しの Run ${stale.id} を、次の ${input.step} の Run の開始を区切りとして${when}で閉じる`,
    );
  }
  warnings.push(...closed.warnings);
  return closed.run;
}

/** 空白・改行を含まない 1 語。step の語彙は openRun がチケットの Workflow の steps（WF-5）で確かめる。ticket claim の --agent も同じ形 */
export const token = z.string().regex(/^\S+$/, "空白・改行を含まない 1 語");

export const runStart = defineCommand({
  name: "run.start",
  positionals: ["ticket", "step"],
  group: "run",
  summary:
    "Run を始める。実行中の記録は deguboard-local/runs/ にだけ置き、Git には入れない。同じチケットと step の Run が実行中か、step がチケットの Workflow の steps にないなら拒否する。このマシンで同じ agent の Run が実行中なら警告して始める。Adapter のない agent 名でも拒まずに記録し、警告する。同じチケットの開いたままの手直しの Run は、この開始を区切りとして、その Run の開始より後の最後の push の時刻（なければこの開始の時刻）で success にしてから始める（手直しの step を始めるとき、前の手直しの Run が別のセッションのものなら interrupted）。同じチケットと step の Run が実行中で拒むときは、手直しの Run も閉じない。--agent を省けば、dg を呼んだエージェントを Adapter が環境変数から判定する（判定できなければ使い方の誤り）",
  input: z.object({
    ticket: ticketRef,
    step: token.describe("工程。チケットの Workflow の steps の id（dg workflow show で見る）"),
    agent: token
      .optional()
      .describe(
        `エージェント名。${agentNames().join("・")} なら finish が会話記録から使用量を取り込む（metrics.read_transcripts）。省けば dg を呼んだエージェントを環境変数から判定し、判定できなければ使い方の誤り`,
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "モデル名（別名でもよい）。finish が会話記録から正式な名前を取れればそちらを記録し、取れないときだけこの名前を使う。分からなければ省く（null で残す）",
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

export const runFinish = defineCommand({
  name: "run.finish",
  positionals: ["run"],
  group: "run",
  summary:
    "実行中の Run を閉じ、完了時の集計を runs/ に書く（commit.mode に従ってコミット）。止まった Run は --result interrupted で閉じる。使用量とツールの回数（tools）は自己申告を受けず、agent の Adapter が会話記録から取り込む。使用量が取れなければ null のまま警告する。ツールを数えない Adapter では tools は null。" +
    "既に閉じた Run（チケットの操作が閉じた実装の Run など）なら記録を変えずに警告して返す",
  input: z.object({
    run: z.string().min(1).describe("Run の ID（r20261031-041500-3fa2）"),
    result: z.enum(RUN_RESULTS).describe("success・failure・interrupted"),
    error: z.string().min(1).optional().describe("失敗・中断の理由"),
    retries: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("リトライの回数。省いて理由を渡せば理由の数"),
    retry_reasons: z
      .array(
        z
          .string()
          .regex(/^[^\r\n]+$/, "理由は 1 件 1 行で書く")
          .regex(/\S/, "理由が空白だけ"),
      )
      .meta({ freeText: true })
      .optional()
      .describe(
        "やり直しの理由。見直しや人のレビューで直した指摘の 1 行の要約。秘密・コマンドの文字列・パスは書かない",
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe("モデル名。会話記録から取れないときだけ使う（start の名前より先）"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (!isRunId(input.run))
      throw new UsageError(`${input.run} は Run の ID の形（r20261031-041500-3fa2）でない`);
    // 空の配列は省いたのと同じに扱う
    const reasons = input.retry_reasons?.length ? input.retry_reasons : undefined;
    if (reasons && input.retries !== undefined && input.retries !== reasons.length) {
      throw new UsageError(
        `リトライの回数（${input.retries}）と理由の数（${reasons.length}）が食い違う。回数を省けば理由の数を回数にする`,
      );
    }
    const now = ctx.now();
    const id = input.run as RunId;
    // 閉じた Run（ticket update --pr・sync・unclaim・move が閉じた実装の Run など。RN-6）は書き換えず（RN-4）、記録をそのまま返す
    const alreadyClosed = (doc: Doc<Run>) =>
      ok(doc.data, undefined, [
        `Run ${doc.id} は既に ${doc.data.result} で閉じている（finished_at ${doc.data.finished_at}）。記録は変えない`,
      ]);
    const local = (await readRunningRuns(ctx.repo)).runs;
    const running = local.find((r) => r.id === id);
    const closed = running ? undefined : ctx.store.runs.get(id);
    if (closed) return alreadyClosed(closed);
    // 実行中の記録がなければ取り込まず、finishRun が見つからない・終わっていると拒否する
    const usage = running ? await usageContext(ctx, local) : undefined;
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
    "見直しの結果（重い・軽い指摘の数と通ったか）を、チケットの見直し（review の step）の Run に書く。見直し役が指摘の一覧を返す前に 1 回呼ぶ。" +
    "このマシンで実行中の見直しの Run があればそれに書き（呼び直せば置き換える）、なければチケットの最新の Run が閉じた見直しの Run のときだけ、結果がまだなければそれに書く（commit.mode に従ってコミット。後に手直しなどの Run が始まっているか、もう結果があれば前の回の見直しなので書かない）。" +
    "閉じた Run が結果の記録なしに failure で閉じていたら success に直す。どちらもなければ（前景で起動した見直し役）結果を保留にし（pending: true）、フックが見直しの Run を閉じるときに結び付ける。" +
    "指摘は --findings-file（JSON か YAML の配列。1 件は severity・category・file・line・reason・fix）で渡す。dg がスキーマで検証し（誤りは場所を示して INVALID_INPUT）、heavy は severity が heavy か category が review.heavy_categories のもの、light は残り、passed は heavy が 0 のときとして求める。一覧は deguboard-local に置き、Git の Run には数だけを書く。" +
    "--heavy・--light・--passed で数だけを渡す呼び方は前の版の見直し役のために残すが、数は自己申告になるので警告する。--findings-file と一緒には使えず、重い指摘があるのに --passed なら使い方の誤り",
  input: z.object({
    ticket: ticketRef,
    findings: z
      .array(reviewFindingSchema)
      .meta({ cliFile: "findings-file" })
      .optional()
      .describe("指摘の一覧。指摘がなければ空の配列"),
    heavy: findingCount
      .optional()
      .describe(
        "前の版の呼び方：重い指摘の数（受け入れ条件の漏れ・不具合・文書との食い違い・規約の違反）",
      ),
    light: findingCount
      .optional()
      .describe("前の版の呼び方：軽い指摘の数（言い回し・好み。参考節との食い違いを含む）"),
    passed: z
      .boolean()
      .optional()
      .describe("前の版の呼び方：通った（重い指摘が残っていない）。省けば通っていない"),
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
          "--findings-file と --heavy・--light・--passed は一緒に使えない（数は一覧から求める）",
        );
      review = reviewOfFindings(input.findings, ctx.config.review.heavy_categories);
    } else {
      if (input.heavy === undefined || input.light === undefined)
        throw new UsageError(
          "指摘の一覧を --findings-file で渡す（前の版の呼び方なら --heavy と --light）",
        );
      const passed = input.passed ?? false;
      if (passed && input.heavy > 0)
        throw new UsageError(`重い指摘が ${input.heavy} 件あるのに --passed を付けた`);
      review = { heavy: input.heavy, light: input.light, passed };
      warnings.push(
        "数だけの呼び方は数が自己申告になる。指摘の一覧を --findings-file で渡せば dg が数と通ったかを求める",
      );
    }
    const ticket = ctx.store.require("ticket", input.ticket).data;
    // 回の記録は書いた先の Run（保留なら null）と一緒に deguboard-local に置く（置き場所の理由は run/record.ts）。
    // 数だけの呼び方も回として置く（一覧は null）。前の回の一覧を最新として使わせないため
    const keep = async (run: RunId | null) => {
      await putReviewRound(ctx.repo, ticket.id, {
        run,
        at: toIsoDateTime(ctx.now()),
        review,
        findings: input.findings ?? null,
      });
    };
    const local = (await readRunningRuns(ctx.repo)).runs;
    const running = local.find((r) => r.data.ticket === ticket.id && r.data.step === REVIEW_STEP);
    if (running) {
      try {
        const amended = await amendRunning(ctx.repo, running.data.id, { review });
        await keep(amended.id);
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
        `${ticket.id} の見直しの Run がまだないので、結果を保留にした。フックが見直しの Run を閉じるときに結び付ける`,
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
            `${ticket.id} の閉じた見直しの Run が、書き込みの間に最新でなくなった。もう一度呼ぶ`,
          );
        if (doc.data.review !== null)
          throw new OperationError(
            "REJECTED",
            `閉じた見直しの Run ${doc.id} に、書き込みの間に結果が書かれた（閉じた Run の結果は書き換えない。RN-4）`,
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
    await keep(written.value.id);
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
    "手直しのやり直しの理由（直した指摘の 1 行の要約）を、チケットの開いている手直しの Run（opens_on: reclaim の step、なければ fix）の retry_reasons に書き足す。PR のないチケットでは使い方の誤り。回数は理由の数になる。印 step=fix で起動した手直しのサブエージェントが、直し始める前に呼ぶ。" +
    "このマシンで実行中の手直しの Run が、そのチケットの最後の見直しの Run より後に始まっていれば、それに書き足す。なければ（前景で起動した手直し、前の回の手直しの Run だけが開いている）理由を保留にし（pending: true）、フックが手直しの Run を閉じるときに、その Run の開始より後に置いた理由を結び付ける",
  input: z.object({
    ticket: ticketRef,
    reasons: z
      .array(
        z
          .string()
          .regex(/^[^\r\n]+$/, "理由は 1 件 1 行で書く")
          .regex(/\S/, "理由が空白だけ"),
      )
      .min(1)
      .meta({ freeText: true })
      .describe(
        "直した指摘（見直し役・人のレビュー）の 1 行の要約。1 件に 1 つ繰り返す。検査の失敗を直したことは書かない。秘密・コマンドの文字列・パスは書かない",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    // 手直しは PR のあるチケットの作業（RN-5 のもう一度の claim と同じ）。打ち間違いで要らない保留を残さない
    if (ticket.pr === undefined)
      throw new UsageError(`${ticket.id} には PR がないので、手直しの理由は書けない`);
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
      `${ticket.id} の今回の手直しの Run がまだないので、理由を保留にした。フックが手直しの Run を閉じるときに結び付ける`,
    ]);
  },
});

export const runList = defineCommand({
  name: "run.list",
  group: "run",
  summary:
    "Run を開始の順に出す。終わっていない Run（running: true。このマシンの deguboard-local/runs/）も出す。Iteration・Project はチケットの今の値でたどる（metrics.show と同じ）。duration_seconds は実行時間（終わっていなければ null）",
  input: z.object({
    ticket: ticketRef.optional().describe("このチケットの Run だけ"),
    iteration: iterationRef
      .optional()
      .describe(
        "この Iteration のチケットの Run だけ。今ない Iteration（打ち間違い・文書を直接消したものなど）はエラーにせず空を返す。ticket.list・metrics.show の絞り込みと同じく、あるかは確かめない",
      ),
    project: slugSchema.optional().describe("この Project のチケットの Run だけ"),
    running: z.boolean().optional().describe("終わっていない Run だけ"),
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
  `${warning.replace(/。(使用量は )?null で残す$/, "")}。今の値を残す`;

export const runRefresh = defineCommand({
  name: "run.refresh",
  positionals: ["runs"],
  group: "run",
  summary: `閉じた Run のモデル名と使用量を、agent の Adapter で会話記録から取り直す（finish と同じ探し方。metrics.read_transcripts と DEGUBOARD_NO_TRANSCRIPTS に従う）。取れた値だけを書き換え、取れなかった値は今の値を残して警告する。終了の時刻（finished_at）から ${TRANSCRIPT_RETENTION_DAYS} 日を過ぎた Run は会話記録の場所を片付ける（run prune-transcripts）ので取り直さず、今の値を残して警告する。--dry-run では書かずに差分（changes）だけを返す`,
  input: z.object({
    runs: z
      .array(z.string().min(1))
      .min(1)
      .describe("閉じた Run の ID（r20261031-041500-3fa2）。複数指定できる"),
    dry_run: z.boolean().optional().describe("書き換えずに、書き換えることになる差分だけを返す"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ids = [...new Set(input.runs)] as RunId[];
    const closed = (id: RunId) => {
      const doc = ctx.store.runs.get(id);
      if (!doc) throw new OperationError("NOT_FOUND", `閉じた Run ${id} が見つからない`);
      return doc;
    };
    const local = (await readRunningRuns(ctx.repo)).runs;
    const running = new Set(local.map((r) => r.id));
    for (const id of ids) {
      if (!isRunId(id))
        throw new UsageError(`${id} は Run の ID の形（r20261031-041500-3fa2）でない`);
      if (running.has(id))
        throw new OperationError(
          "REJECTED",
          `Run ${id} は実行中。dg run finish ${id} で閉じれば finish が会話記録から取り込む`,
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
              `終了の時刻（finished_at）から ${TRANSCRIPT_RETENTION_DAYS} 日を過ぎた Run は、会話記録の場所を片付けるので取り直さない`,
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
          `Run ${item.id}: ${item.kept.join("・")} は会話記録から取れなかったので今の値を残す`,
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
  summary: `このマシンの deguboard-local/transcripts/ から、終了の時刻（finished_at）から ${TRANSCRIPT_RETENTION_DAYS} 日を過ぎた Run（expired）と、実行中の記録も runs/ の集計もない ID（orphan）の会話記録のパスを消す。期間の中の Run と同じファイルを指すものは残す。消した Run は run refresh が取り直さない。Git には書かない。--dry-run では消さずに消すものだけを返す`,
  input: z.object({
    dry_run: z.boolean().optional().describe("消さずに、消すことになるものだけを返す"),
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
  runRetryReason,
  runList,
  runRefresh,
  runPruneTranscripts,
];
