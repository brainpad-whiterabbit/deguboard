// Workflow の参照と検証（WF-3）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { slugSchema } from "../model/common.js";
import { DIRS } from "../storage/paths.js";
import { defineCommand, ok } from "./define.js";

export const workflowList = defineCommand({
  name: "workflow.list",
  group: "workflow",
  summary: "読めた Workflow を出す。読めなかったものは workflow.validate で見る",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    const items = [...ctx.store.workflows.values()]
      .map((w) => ({
        id: w.resolved.id,
        name: w.resolved.name,
        path: w.path,
        fields: w.resolved.fields.map((f) => f.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return ok(items);
  },
});

export const workflowShow = defineCommand({
  name: "workflow.show",
  positionals: ["workflow"],
  group: "workflow",
  summary:
    "Workflow の定義と、from→to ごとに合成した遷移の制約を出す。書かれていない遷移は誰でも条件なしで行える",
  input: z.object({ workflow: slugSchema }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const w = ctx.store.workflows.get(input.workflow);
    if (!w)
      throw new OperationError("NOT_FOUND", `Workflow ${input.workflow} が見つからないか読めない`);
    return ok({
      definition: w.definition,
      labels: w.resolved.labels,
      transitions: w.resolved.transitions,
      path: w.path,
    });
  },
});

export const workflowValidate = defineCommand({
  name: "workflow.validate",
  positionals: ["workflow"],
  group: "workflow",
  summary: "Workflow 定義の指摘（存在しない Status、未知の条件、同じ遷移の重複）を出す",
  input: z.object({ workflow: slugSchema.optional().describe("1 つだけ検査する") }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const prefix = `${DIRS.workflows}/`;
    const issues = ctx.store.issues.filter(
      (i) =>
        i.path.startsWith(prefix) &&
        (!input.workflow || i.path === `${prefix}${input.workflow}.yaml`),
    );
    const valid = [...ctx.store.workflows.keys()]
      .filter((id) => !input.workflow || id === input.workflow)
      .sort();
    if (input.workflow && issues.length === 0 && valid.length === 0) {
      throw new OperationError("NOT_FOUND", `Workflow ${input.workflow} が見つからない`);
    }
    return ok({ ok: issues.every((i) => i.severity !== "error"), valid, issues });
  },
});

export const workflowCommands = [workflowList, workflowShow, workflowValidate];
