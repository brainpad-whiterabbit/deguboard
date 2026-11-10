// 作業の実績の集計（requirements.md 6.6 MT-3、ADR-029）。runs/ の Run を読み、表示のたびに求める。何も書かない

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
    "Aggregate Runs. Filter by Run, ticket, Epic, Iteration, Project, Agent, Model, or Step (Epic, Iteration, and Project follow each ticket's current value). Values that could not be read are not added and are counted in missing; Runs with estimated values are counted in estimated_runs. Tool counts (tools) are also added up per kind, and Runs without them are counted in missing.tools. Aggregates are not stored",
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
