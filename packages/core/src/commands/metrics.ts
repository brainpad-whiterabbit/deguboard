// 作業の実績の集計（requirements.md 6.6 MT-3、ADR-005）。runs/ の Run を読み、表示のたびに求める。何も書かない

import { z } from "zod";
import { slugSchema } from "../model/common.js";
import {
  METRIC_UNITS,
  filterRuns,
  measureRuns,
  placeRun,
  type MetricFilter,
  type MetricUnit,
  type MetricsReport,
} from "../model/metrics.js";
import { runIdSchema } from "../model/run.js";
import { defineCommand, ok } from "./define.js";
import { epicRef, idShapeOf, iterationRef, ticketRef } from "./helpers.js";

export interface MetricsView extends MetricsReport {
  filter: MetricFilter;
  by: MetricUnit | null;
}

export const metricsShow = defineCommand({
  name: "metrics.show",
  group: "metrics",
  summary:
    "Run を集計する。絞り込みは Run・チケット・Epic・Iteration・Project・Agent・Model・Step（Epic・Iteration・Project はチケットの今の値でたどる）。取れなかった値は足さず missing に数え、推定を含む Run は estimated_runs に数える。ツールの回数（tools）も種類ごとに足し、ない Run は missing.tools に数える。集計値は保存しない",
  input: z.object({
    run: runIdSchema.optional().describe("この Run だけ"),
    ticket: ticketRef.optional().describe("このチケットの Run だけ"),
    epic: epicRef.optional().describe("この Epic のチケットの Run だけ"),
    iteration: iterationRef.optional().describe("この Iteration のチケットの Run だけ"),
    project: slugSchema.optional().describe("この Project のチケットの Run だけ"),
    agent: z.string().min(1).optional().describe("このエージェントの Run だけ"),
    model: z.string().min(1).optional().describe("このモデルの Run だけ"),
    step: z.string().min(1).optional().describe("この step（implement・review など）の Run だけ"),
    by: z.enum(METRIC_UNITS).optional().describe("この単位ごとにも集計する"),
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
    const report = measureRuns(placed, filter, input.by);

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
            `チケット ${lost.join(", ")} が見つからないので、その Run の Epic・Iteration・Project は分からない`,
          ]
        : [];
    const view: MetricsView = { filter, by: input.by ?? null, ...report };
    return ok(view, undefined, warnings);
  },
});

export const metricsCommands = [metricsShow];
