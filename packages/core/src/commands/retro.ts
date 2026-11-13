// 振り返りの観点と、承認した指標の定義（config.yaml の retro.perspectives。requirements.md 5.10、ADR-035）。
// 観点ごとの入れ子は config.set の 1 項目に収まらないので、ここのコマンドがスキーマで検査してチームの config.yaml に書く。
// 読むのは config show（retro.perspectives）。指標の数字は計算も保存もしない（エージェントが定義を読んで計算する）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
import type { RetroPerspective } from "../model/config.js";
import { defineCommand, ok, type CommandContext } from "./define.js";

type Perspectives = Record<string, RetroPerspective>;

/** チームの config.yaml の観点を書き換える。個人の設定では上書きできないので、元も書く先もチームの値 */
async function writePerspectives(
  ctx: CommandContext,
  message: string,
  change: (perspectives: Perspectives) => Perspectives,
) {
  return withWrite(
    ctx,
    async () => {
      const team = ctx.store.teamConfig;
      const written = await ctx.store.writeConfig({
        retro: { ...team.retro, perspectives: change({ ...team.retro.perspectives }) },
      });
      return written.retro.perspectives;
    },
    { message },
  );
}

function perspectiveOf(perspectives: Perspectives, id: string): RetroPerspective {
  const found = perspectives[id];
  if (!found)
    throw new OperationError(
      "NOT_FOUND",
      `No retrospective perspective ${id}`,
      `Perspectives: ${Object.keys(perspectives).join(", ") || "(none)"}. Add one with dg retro perspective <id> --name <name> --question <question>`,
    );
  return found;
}

export const retroPerspective = defineCommand({
  name: "retro.perspective",
  positionals: ["id"],
  group: "retro",
  summary:
    "Add a perspective of the retrospective to the team's config.yaml (retro.perspectives), or change the name or question of one that exists. A new perspective needs both --name and --question and starts with no metric definitions; an existing one keeps what is not given, and keeps its metric definitions. The first write puts the whole list (the defaults included) into config.yaml. Read the perspectives with dg config show; return to the default perspectives with dg config unset retro.perspectives",
  input: z.object({
    id: slugSchema.describe("ID of the perspective (a slug, such as outcome)"),
    name: z.string().min(1).optional().describe("Name of the perspective"),
    question: z.string().min(1).optional().describe("The question the perspective answers"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await writePerspectives(
      ctx,
      `Change retro perspective ${input.id}`,
      (perspectives) => {
        const current = perspectives[input.id];
        const name = input.name ?? current?.name;
        const question = input.question ?? current?.question;
        if (current && input.name === undefined && input.question === undefined)
          throw new OperationError(
            "VALIDATION_FAILED",
            `Give --name or --question to change perspective ${input.id}`,
          );
        if (name === undefined || question === undefined)
          throw new OperationError(
            "VALIDATION_FAILED",
            `A new perspective ${input.id} needs both --name and --question`,
          );
        return {
          ...perspectives,
          [input.id]: { ...current, name, question, metrics: current?.metrics ?? {} },
        };
      },
    );
    return ok({ perspectives: result.value }, result.write);
  },
});

export const retroMetric = defineCommand({
  name: "retro.metric",
  positionals: ["perspective", "id"],
  group: "retro",
  summary:
    "Record a metric definition that a person approved under a perspective of the retrospective, in the team's config.yaml (retro.perspectives.<perspective>.metrics.<id>). A definition is not a formula that dg runs: it is a sentence saying how to count (--definition) and the commands the numbers come from (--source, repeated), which the agent reads and computes from at each retrospective (dg guide retro). The results are not stored. An existing metric of the same ID is replaced as a whole. Remove one with dg retro remove",
  input: z.object({
    perspective: slugSchema.describe(
      "ID of the perspective (see dg config show, retro.perspectives)",
    ),
    id: slugSchema.describe("ID of the metric (a slug, such as first-pass-rate)"),
    definition: z
      .string()
      .min(1)
      .describe("How to count the metric: what is divided by what, over which tickets or Runs"),
    sources: z
      .array(z.string().min(1))
      .min(1)
      .meta({ freeText: true })
      .describe(
        "Command the numbers come from, with the fields to read (such as dg metrics show --iteration <S> --by ticket)",
      ),
    unmeasured: z
      .string()
      .min(1)
      .optional()
      .describe("The part of the perspective's question this metric cannot measure"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await writePerspectives(
      ctx,
      `Define retro metric ${input.perspective}.${input.id}`,
      (perspectives) => {
        const current = perspectiveOf(perspectives, input.perspective);
        const metric = {
          definition: input.definition,
          sources: input.sources,
          ...(input.unmeasured !== undefined ? { unmeasured: input.unmeasured } : {}),
        };
        return {
          ...perspectives,
          [input.perspective]: { ...current, metrics: { ...current.metrics, [input.id]: metric } },
        };
      },
    );
    return ok({ perspectives: result.value }, result.write);
  },
});

export const retroRemove = defineCommand({
  name: "retro.remove",
  positionals: ["perspective", "metric"],
  group: "retro",
  summary:
    "Remove a metric definition from a perspective of the retrospective, or, when no metric is given, the perspective itself with its definitions (the team's config.yaml, retro.perspectives). Return to the default perspectives with dg config unset retro.perspectives",
  input: z.object({
    perspective: slugSchema.describe("ID of the perspective"),
    metric: slugSchema
      .optional()
      .describe("ID of the metric to remove. Omit to remove the perspective"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const target =
      input.metric === undefined ? input.perspective : `${input.perspective}.${input.metric}`;
    const result = await writePerspectives(
      ctx,
      `Remove retro ${input.metric === undefined ? "perspective" : "metric"} ${target}`,
      (perspectives) => {
        const current = perspectiveOf(perspectives, input.perspective);
        const next = { ...perspectives };
        if (input.metric === undefined) {
          delete next[input.perspective];
          return next;
        }
        if (!(input.metric in current.metrics))
          throw new OperationError(
            "NOT_FOUND",
            `Perspective ${input.perspective} has no metric ${input.metric}`,
            `Metrics: ${Object.keys(current.metrics).join(", ") || "(none)"}`,
          );
        const metrics = { ...current.metrics };
        delete metrics[input.metric];
        next[input.perspective] = { ...current, metrics };
        return next;
      },
    );
    return ok({ perspectives: result.value }, result.write);
  },
});

export const retroCommands = [retroPerspective, retroMetric, retroRemove];
