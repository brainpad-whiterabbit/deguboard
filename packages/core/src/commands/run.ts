// Run の操作（requirements.md 5.9 RN-4、6.6 MT-1・MT-2・MT-5、6.7 EX-2、ADR-005）。記録の置き場所とロックは run/record.ts、
// 使用量の取り込みは agents（Run の agent の値で Adapter を選ぶ。特定の AI 製品をここに書かない。AG-5）

import { z } from "zod";
import { agentNames, collectRunUsage } from "../agents/index.js";
import { slugSchema, toIsoDateTime } from "../model/common.js";
import { filterRuns, placeRun, runDurationSeconds, type MetricFilter } from "../model/metrics.js";
import { OperationError, UsageError } from "../errors.js";
import { isRunId, RUN_RESULTS, type Run, type RunId, type RunUsage } from "../model/run.js";
import { withWrite } from "../git/write.js";
import { finishRun, readRunningRuns, startRun } from "../run/record.js";
import { findStep } from "../workflow/resolve.js";
import { defineCommand, ok } from "./define.js";
import { idShapeOf, iterationRef, ticketRef } from "./helpers.js";

/**
 * 一覧の 1 件。running は deguboard-local/runs/ にだけある終わっていない Run。
 * duration_seconds は metrics.show の集計と同じ実行時間（終わっていなければ null）
 */
export type RunView = Run & { running: boolean; duration_seconds: number | null };

/** 空白・改行を含まない 1 語。step の語彙は run.start がチケットの Workflow の steps（WF-5）で確かめる */
const token = z.string().regex(/^\S+$/, "空白・改行を含まない 1 語");

export const runStart = defineCommand({
  name: "run.start",
  positionals: ["ticket", "step"],
  group: "run",
  summary:
    "Run を始める。実行中の記録は deguboard-local/runs/ にだけ置き、Git には入れない。同じチケットと step の Run が実行中か、step がチケットの Workflow の steps にないなら拒否する",
  input: z.object({
    ticket: ticketRef,
    step: token.describe("工程。チケットの Workflow の steps の id（dg workflow show で見る）"),
    agent: token.describe(
      `エージェント名。${agentNames().join("・")} なら finish が会話記録から使用量を取り込む（metrics.read_transcripts）`,
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
    const ticket = ctx.store.require("ticket", input.ticket);
    const warnings: string[] = [];
    const workflow = ctx.store.workflowFor(ticket.data);
    if (workflow) {
      const found = findStep(workflow.resolved, input.step);
      if (!found.ok) {
        throw new OperationError(
          "VALIDATION_FAILED",
          `step ${input.step} は Workflow ${workflow.resolved.id} の steps にない（${found.known.join("・")}）`,
        );
      }
    } else {
      warnings.push(
        `${ticket.data.id} の Workflow が見つからないか読めないので、step ${input.step} を確かめていない`,
      );
    }
    if (!agentNames().includes(input.agent)) {
      warnings.push(
        `agent ${input.agent} には Adapter がないので、finish は使用量とモデル名を取り込めない（Adapter のある名前: ${agentNames().join("・")}。サブエージェントも自分の Adapter の名前で始める）`,
      );
    }
    const run = await startRun(ctx.repo, {
      ticket: ticket.data.id,
      step: input.step,
      agent: input.agent,
      model: input.model,
      now: ctx.now(),
    });
    return ok(run, undefined, warnings);
  },
});

export const runFinish = defineCommand({
  name: "run.finish",
  positionals: ["run"],
  group: "run",
  summary:
    "実行中の Run を閉じ、完了時の集計を runs/ に書く（commit.mode に従ってコミット）。止まった Run は --result interrupted で閉じる。使用量は自己申告を受けず、agent の Adapter が会話記録から取り込む。取れなければ null のまま警告する",
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
    // 実行中の記録がなければ取り込まず、finishRun が見つからない・終わっていると拒否する
    const running = (await readRunningRuns(ctx.repo)).runs.find((r) => r.id === input.run);
    const collected = running
      ? await collectRunUsage(ctx.config, {
          run: running.data,
          finishedAt: toIsoDateTime(now),
          env: ctx.env ?? process.env,
          topLevel: ctx.repo.topLevel,
          commonDir: ctx.repo.commonDir,
        })
      : undefined;
    const { run, write } = await finishRun(ctx, input.run, {
      result: input.result,
      error: input.error,
      retries: input.retries ?? reasons?.length,
      retryReasons: reasons,
      // 会話記録のモデル名 > 明示したモデル名 > 実行中の記録のモデル名（別名でなく正式な ID を残す）
      model: collected?.model ?? input.model,
      usage: collected?.usage,
      now,
    });
    return ok(run, write, collected?.warnings ?? []);
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

/** 取り直しで比べる値。usage の 4 つは usage.<キー> と書く */
const REFRESH_FIELDS = ["model", "input", "output", "cache_read", "cache_write"] as const;
type RefreshField = (typeof REFRESH_FIELDS)[number];
type UsageKey = Exclude<RefreshField, "model">;
const fieldLabel = (f: RefreshField) => (f === "model" ? "model" : `usage.${f}`);

/** 取り直した 1 件。changes は書き換える（dry_run では書き換えることになる）値、kept は取れずに今の値を残した値 */
export interface RunRefreshItem {
  id: RunId;
  ticket: string;
  agent: string;
  changes: Array<{ field: string; from: string | number | null; to: string | number }>;
  kept: string[];
  updated: boolean;
}

/** 会話記録から取れた値だけを今の記録に重ねる。取れなかった値（null）は今の値を残す */
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
  return { changes, kept, model, usage };
}

/** Adapter の警告の「null で残す」は finish の言い方なので、取り直しでは今の値を残すと言い直す */
const keepWording = (warning: string) =>
  warning.replace(/。(使用量は )?null で残す$/, "。今の値を残す");

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
    const running = new Set((await readRunningRuns(ctx.repo)).runs.map((r) => r.id));
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
    const collected = new Map<string, Awaited<ReturnType<typeof collectRunUsage>>>();
    for (const id of ids) {
      const run = closed(id).data;
      const got = await collectRunUsage(ctx.config, {
        run,
        // 閉じた Run は終了日時で期間を区切る（finish と同じ範囲を読む）
        finishedAt: run.finished_at ?? run.started_at,
        env: ctx.env ?? process.env,
        topLevel: ctx.repo.topLevel,
        commonDir: ctx.repo.commonDir,
      });
      collected.set(id, got);
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
      if (item.kept.length > 0)
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
          const { model, usage } = refreshPlan(doc.data, collected.get(item.id)!);
          const base = doc.yaml.toJS() as Record<string, unknown>;
          await ctx.store.update("run", item.id, {
            ...(model === undefined ? {} : { model }),
            // usage の中の未知のキーは残す（DT-2）
            usage: { ...(base["usage"] as Record<string, unknown>), ...usage },
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
