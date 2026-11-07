// Run の操作（requirements.md 5.9 RN-4〜RN-6、6.6 MT-1・MT-2・MT-5、6.7 EX-2、ADR-005）。記録の置き場所とロックは run/record.ts、
// 使用量の取り込みは agents（Run の agent の値で Adapter を選ぶ。特定の AI 製品をここに書かない。AG-5）

import { z } from "zod";
import { agentNames, collectRunUsage, detectAgent, type RunSpan } from "../agents/index.js";
import { slugSchema, toIsoDateTime } from "../model/common.js";
import { filterRuns, placeRun, runDurationSeconds, type MetricFilter } from "../model/metrics.js";
import { OperationError, UsageError } from "../errors.js";
import {
  isRunId,
  RUN_RESULTS,
  type Run,
  type RunId,
  type RunResult,
  type RunUsage,
} from "../model/run.js";
import { withWrite } from "../git/write.js";
import { closeRun, dropRunning, finishRun, readRunningRuns, startRun } from "../run/record.js";
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

/** Adapter が期間の重なる Run と応答を分けるための、閉じた Run とこのマシンで実行中の Run の期間 */
function runSpans(closed: Iterable<{ data: Run }>, running: Iterable<{ data: Run }>) {
  const spans = new Map<string, RunSpan>();
  for (const { data } of [...closed, ...running]) {
    spans.set(data.id, {
      started_at: data.started_at,
      finished_at: data.finished_at,
      agent: data.agent,
    });
  }
  return spans;
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
 * retryReasons はもう一度の claim が開く手直しの Run に、直す指摘を最初から残すためのもの
 */
export async function openRun(
  ctx: CommandContext,
  ticket: Ticket,
  input: {
    step: string;
    agent: string;
    model?: string | undefined;
    retryReasons?: readonly string[] | undefined;
  },
): Promise<{ run: Run; warnings: string[] }> {
  const { step, agent } = input;
  const warnings: string[] = [];
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
  // 同じ会話記録で期間が重なると、応答は後に始めた Run にだけ数える（ADR-005）。閉じ忘れに気づけるように知らせる
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
    now: ctx.now(),
  });
  return { run, warnings };
}

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
  const collected = await collectRunUsage(ctx.config, {
    run: running.data,
    finishedAt,
    env: ctx.env ?? process.env,
    topLevel: ctx.repo.topLevel,
    others: runSpans(ctx.store.runs.values(), local),
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

/**
 * 操作が開いた Run を、それだけの書き込み（commit.mode に従ってコミット）で閉じる。
 * もう一度の claim が、開いたままの前の手直しの Run を次の Run の開始の区切りとして閉じるのに使う（RN-6）
 */
export async function closeOpenedRunAlone(
  ctx: CommandContext,
  running: Doc<Run>,
  input: Parameters<typeof closeOpenedRun>[2],
): Promise<ClosedOpenedRun> {
  const written = await withWrite(ctx, () => closeOpenedRun(ctx, running, input), {
    message: ({ run }) =>
      `${openedRunLabel(input.opener)}の Run を記録: ${run.ticket} ${run.id} ${run.result ?? ""}`,
  });
  await dropRunning(ctx.repo, running.data.id);
  return {
    run: written.value.run,
    warnings: [...written.write.warnings, ...written.value.warnings],
  };
}

/** 空白・改行を含まない 1 語。step の語彙は openRun がチケットの Workflow の steps（WF-5）で確かめる。ticket claim の --agent も同じ形 */
export const token = z.string().regex(/^\S+$/, "空白・改行を含まない 1 語");

export const runStart = defineCommand({
  name: "run.start",
  positionals: ["ticket", "step"],
  group: "run",
  summary:
    "Run を始める。実行中の記録は deguboard-local/runs/ にだけ置き、Git には入れない。同じチケットと step の Run が実行中か、step がチケットの Workflow の steps にないなら拒否する。このマシンで同じ agent の Run が実行中なら警告して始める。Adapter のない agent 名でも拒まずに記録し、警告する。--agent を省けば、dg を呼んだエージェントを Adapter が環境変数から判定する（判定できなければ使い方の誤り）",
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
    const collected = running
      ? await collectRunUsage(ctx.config, {
          run: running.data,
          finishedAt: toIsoDateTime(now),
          env: ctx.env ?? process.env,
          topLevel: ctx.repo.topLevel,
          others: runSpans(ctx.store.runs.values(), local),
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
  summary:
    "閉じた Run のモデル名と使用量を、agent の Adapter で会話記録から取り直す（finish と同じ探し方。metrics.read_transcripts と DEGUBOARD_NO_TRANSCRIPTS に従う）。取れた値だけを書き換え、取れなかった値は今の値を残して警告する。--dry-run では書かずに差分（changes）だけを返す",
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
    const others = runSpans(ctx.store.runs.values(), local);
    for (const id of ids) {
      const run = closed(id).data;
      const got = await collectRunUsage(ctx.config, {
        run,
        // 閉じた Run は終了日時で期間を区切る（finish と同じ範囲を読む）
        finishedAt: run.finished_at ?? run.started_at,
        env: ctx.env ?? process.env,
        topLevel: ctx.repo.topLevel,
        others,
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
          const base = doc.yaml.toJS() as Record<string, unknown>;
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

export const runCommands = [runStart, runFinish, runList, runRefresh];
