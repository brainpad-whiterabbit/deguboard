// 作業の実績の集計（requirements.md 6.6 MT-3・MT-6、ADR-029）。metrics show は runs/ の Run とチケットの行数を読み、表示のたびに求める（何も書かない）。
// metrics lines は done のチケットに PR の行数を後から記録する

import { z } from "zod";
import { fetchMergedPrLines } from "../git/facts.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
import { idNumber, type TicketId } from "../model/id.js";
import {
  METRIC_UNITS,
  doneTicketsWithoutImplementRun,
  filterRuns,
  measureRuns,
  placeRun,
  type MetricFilter,
  type MetricUnit,
  type MetricsReport,
} from "../model/metrics.js";
import { runIdSchema } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import { defineCommand, ok } from "./define.js";
import { epicRef, idShapeOf, iterationRef, ticketRef } from "./helpers.js";
import { openedStepOf } from "./run.js";
import { describeLinesRecorded } from "./setup.js";

export interface MetricsView extends MetricsReport {
  filter: MetricFilter;
  by: MetricUnit | null;
  /** 絞り込みに合う done のチケットで、実装の Run が 1 件もない ID（MT-3） */
  no_runs: string[];
}

export const metricsShow = defineCommand({
  name: "metrics.show",
  group: "metrics",
  summary:
    "Aggregate Runs. Filter by Run, ticket, Epic, Iteration, Project, Agent, Model, or Step (Epic, Iteration, and Project follow each ticket's current value). Values that could not be read are not added and are counted in missing; Runs with estimated values are counted in estimated_runs. Tool counts (tools) are also added up per kind, and Runs without them are counted in missing.tools. Reviews recorded with no Run from a hook (capture: none) are counted as reviews only, and are left out of usage, time, and tools. lines gives the changed lines of the tickets of the Runs (additions and deletions of each ticket's merged PR, recorded on the ticket by dg sync or dg metrics lines; a ticket is counted once however many Runs it has) and the tokens per changed line (per_line), split into output and input_cache (input + cache_read + cache_write), not divided as one total because cache_read is most of the tokens. per_line divides the tokens of the Runs on tickets that have lines by the lines (additions + deletions) of those tickets with at least one Run that has the value, rounded to one decimal place; it is null when there is nothing to divide by. Tickets with no lines (work with no PR, a PR not merged yet) are left out of per_line and counted in lines.missing. Use --by iteration to compare Iterations, and --by step or --by ticket to see where the tokens per line are high. Done tickets claimed by an agent that match the ticket-level filters (ticket, epic, iteration, project) and have no implement Run are listed in no_runs. Aggregates are not stored",
  input: z.object({
    run: runIdSchema.optional().describe("Only this Run"),
    ticket: ticketRef.optional().describe("Only Runs of this ticket"),
    epic: epicRef.optional().describe("Only Runs of tickets in this Epic"),
    iteration: iterationRef.optional().describe("Only Runs of tickets in this Iteration"),
    project: slugSchema.optional().describe("Only Runs of tickets in this Project"),
    agent: z.string().min(1).optional().describe("Only Runs of this agent"),
    model: z.string().min(1).optional().describe("Only Runs of this model"),
    step: z
      .string()
      .min(1)
      .optional()
      .describe("Only Runs of this step (such as implement or review)"),
    by: z.enum(METRIC_UNITS).optional().describe("Also aggregate by this unit"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // 消えたチケットや Epic の Run も引けるよう、今あるかは確かめず ID の形だけ整える
    const filter: MetricFilter = Object.fromEntries(
      Object.entries({
        run: input.run,
        ticket: idShapeOf(input.ticket, "ticket"),
        epic: idShapeOf(input.epic, "epic"),
        iteration: idShapeOf(input.iteration, "iteration"),
        project: input.project,
        agent: input.agent,
        model: input.model,
        step: input.step,
      }).filter(([, v]) => v !== undefined),
    );
    const placed = [...ctx.store.runs.values()]
      .map((d) => d.data)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((run) => ({ run, at: placeRun(run, ctx.store.tickets.get(run.ticket)?.data) }));
    const report = measureRuns(
      placed,
      filter,
      input.by,
      (id) => ctx.store.tickets.get(id as TicketId)?.data.lines,
    );

    // 集計に入った Run のうち、チケットが見つからないもの
    const lost = [
      ...new Set(
        filterRuns(placed, filter)
          .map((p) => p.run.ticket)
          .filter((id) => !ctx.store.tickets.has(id)),
      ),
    ];
    const warnings =
      lost.length > 0 && (filter.epic || filter.iteration || filter.project || input.by)
        ? [
            `Tickets ${lost.join(", ")} not found, so the Epic, Iteration and Project of those Runs are unknown`,
          ]
        : [];
    // done なのに実装の Run がないチケットは、Run の集計には現れないので別に示す（MT-3）。
    // 実装の Run の step は Workflow の claim が開く step で決める（RN-5。lint の確かめと同じ）。
    // フックが結ばなかった見直し（capture: none、t702）のチケットも示す。MT-3 は環境を問わず
    // 「実装の Run が 1 件もない done」を示すと決めており、lint は環境のせいとして外すが、ここでは外さない
    const no_runs = doneTicketsWithoutImplementRun(
      [...ctx.store.tickets.values()].map((d) => d.data),
      [...ctx.store.runs.values()].map((d) => d.data),
      (t) => openedStepOf(ctx, t, "claim"),
      filter,
    );
    if (no_runs.length > 0)
      warnings.push(`Done tickets with no implement Run: ${no_runs.join(", ")}`);
    const view: MetricsView = { filter, by: input.by ?? null, ...report, no_runs };
    return ok(view, undefined, warnings);
  },
});

/** `metrics lines` が 1 回に gh で読む PR の数の既定と上限（gh は 1 件ずつ直列に呼ぶ） */
const LINES_DEFAULT_LIMIT = 100;
const LINES_MAX_LIMIT = 1000;

export interface MetricsLinesView {
  /** 行数を記録したチケット */
  recorded: Array<{ id: string; pr: number; additions: number; deletions: number }>;
  /** 行数を取れなかったチケットと理由（マージされていない PR・gh で読めない） */
  skipped: Array<{ id: string; pr: number; reason: string }>;
  /** limit で今回は読まなかった、行数のない done のチケットの数 */
  remaining: number;
}

/**
 * 行数のない done のチケットに、記録した PR の行数を後から記録する（MT-6）。
 * 普段は照合がマージを見たときに記録するので、要るのはこの記録ができる前に done になったチケットと、
 * gh のないマシンの照合で done になったチケットだけ。sync のたびに done のチケットを gh で引き直すと、
 * マージされなかった PR の done を毎回読み続けるので、照合には入れずに人が呼ぶコマンドにする
 */
export const metricsLines = defineCommand({
  name: "metrics.lines",
  group: "metrics",
  summary:
    "Record the changed lines (additions and deletions) of the merged PR on done tickets that have a PR number and no lines yet, so that dg metrics show can give the tokens per line for them. dg sync records the lines when it sees the PR merged; this fills tickets that became done before lines were recorded, or where gh was not available. It reads each PR with gh pr view, one call per ticket, newest ticket first, up to --limit tickets per call (the rest are counted in remaining; call again to continue). A PR that is not merged or cannot be read is listed in skipped with the reason and nothing is written for it; such a ticket is read again on every call and counts toward --limit, so when skipped tickets fill the limit, raise --limit or narrow with --iteration to reach the older tickets. Tickets that already have lines are not rewritten",
  input: z.object({
    iteration: iterationRef.optional().describe("Only tickets in this Iteration"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LINES_MAX_LIMIT)
      .optional()
      .describe(
        `Maximum number of PRs to read in this call (default ${LINES_DEFAULT_LIMIT}, at most ${LINES_MAX_LIMIT})`,
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const iteration = idShapeOf(input.iteration, "iteration");
    const lacking = (t: Ticket): t is Ticket & { pr: number } =>
      t.status === "done" && t.pr !== undefined && t.lines === undefined;
    const targets = [...ctx.store.tickets.values()]
      .map((d) => d.data)
      .filter(lacking)
      .filter((t) => iteration === undefined || t.iteration === iteration)
      .sort((a, b) => idNumber(b.id) - idNumber(a.id));
    const batch = targets.slice(0, input.limit ?? LINES_DEFAULT_LIMIT);
    // gh は待ちが長くなりうるので、書き込みのロックの外で先に読む（sync の照合と同じ）
    const found: MetricsLinesView["recorded"] = [];
    const skipped: MetricsLinesView["skipped"] = [];
    for (const t of batch) {
      const got = await fetchMergedPrLines(ctx.repo, t.pr);
      if (got.lines) found.push({ id: t.id, pr: t.pr, ...got.lines });
      else skipped.push({ id: t.id, pr: t.pr, reason: got.reason });
    }
    const warnings = skipped.map(
      (s) => `${s.id}: the changed lines were not recorded (${s.reason})`,
    );
    const remaining = targets.length - batch.length;
    // 取れなかったチケットは行数のないままなので、次の呼び出しでも新しい順の先頭で limit の枠を使う。
    // 枠が取れなかったチケットで埋まると古いチケットに届かないので、届かせ方を案内する
    if (remaining > 0)
      warnings.push(
        `${remaining} done tickets with no lines were not read in this call (limit). Call again to continue` +
          (skipped.length > 0
            ? `. The ${skipped.length} skipped tickets are read again on every call and count toward the limit; if the same tickets keep being skipped, raise --limit or narrow with --iteration to reach the older tickets`
            : ""),
      );
    if (found.length === 0) return ok({ recorded: [], skipped, remaining }, undefined, warnings);
    const result = await withWrite(
      ctx,
      async () => {
        // gh を読んでいた間のほかのプロセスの書き込みを読み直す（sync の照合と同じ）。withWrite は取り込みがリモートの変更を
        // 入れたときしか読み直さないので、読み直さないと古い内容で判定し、古いファイルの中身で書き戻して他の変更を消す
        await ctx.store.rescan();
        const recorded: MetricsLinesView["recorded"] = [];
        for (const f of found) {
          // 読み直した今の内容で確かめ、読んだ後に変わった（done でなくなった・PR が変わった・もう記録された）チケットには書かない。
          // updated_at は変えない（チケットの中身の変更ではなく、後から足す計測の値なので、更新順を乱さない）
          const now = ctx.store.tickets.get(f.id as TicketId)?.data;
          if (!now || !lacking(now) || now.pr !== f.pr) continue;
          await ctx.store.update("ticket", now.id, {
            lines: { additions: f.additions, deletions: f.deletions },
          });
          recorded.push(f);
        }
        return recorded;
      },
      {
        message: (recorded) =>
          recorded.length > 20
            ? `Record changed lines of merged PRs on ${recorded.length} tickets`
            : describeLinesRecorded(recorded),
      },
    );
    return ok({ recorded: result.value, skipped, remaining }, result.write, warnings);
  },
});

export const metricsCommands = [metricsShow, metricsLines];
