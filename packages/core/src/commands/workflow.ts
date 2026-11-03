// Workflow の参照・検証（WF-3）・書き換え

import path from "node:path";
import { z } from "zod";
import { OperationError, UsageError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
import type { WorkflowDefinition } from "../model/workflow.js";
import { pathExists } from "../storage/exists.js";
import { formatIssue } from "../storage/issue.js";
import { DIRS, workflowPath } from "../storage/paths.js";
import { WORKFLOW_TEMPLATES, findWorkflowTemplate } from "../workflow/templates/index.js";
import { defineCommand, ok } from "./define.js";

const TEMPLATE_IDS = WORKFLOW_TEMPLATES.map((t) => t.id) as [string, ...string[]];

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
  input: z.object({ workflow: slugSchema.describe("出す Workflow の ID（workflows/<id>.yaml）") }),
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
  summary:
    "Workflow 定義の指摘（存在しない Status、未知の条件・Action、同じ遷移・step の重複）を出す",
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

/** 前と後で値が違う最上位の項目（id・name・transitions など）。前がなければ後のすべての項目 */
function changedKeys(before: WorkflowDefinition | null, after: WorkflowDefinition): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter(
    (k) =>
      JSON.stringify((before as Record<string, unknown> | null)?.[k]) !==
      JSON.stringify((after as Record<string, unknown>)[k]),
  );
}

export const workflowSet = defineCommand({
  name: "workflow.set",
  positionals: ["workflow"],
  group: "workflow",
  summary:
    "Workflow の定義を書く（なければ作り、あれば置き換える）。定義か同梱のテンプレートのどちらか一方を渡す。読み込み時と同じ検証（WF-3）に通らなければ何も書かない",
  input: z.object({
    workflow: slugSchema.describe("書く Workflow の ID（workflows/<id>.yaml）"),
    definition: z
      .record(z.string(), z.unknown())
      .meta({ cliFile: "file" })
      .optional()
      .describe(
        "Workflow の定義。形は dg workflow show の definition と同じで、中の id は workflow と同じにする",
      ),
    template: z
      .enum(TEMPLATE_IDS)
      .optional()
      .describe("同梱のテンプレートの名前。id は workflow に置き換えて書く"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if ((input.definition === undefined) === (input.template === undefined)) {
      throw new UsageError("定義（CLI では --file）か --template のどちらか一方を指定する");
    }
    let definition: Record<string, unknown>;
    let comment: string | undefined;
    if (input.template !== undefined) {
      const t = findWorkflowTemplate(input.template)!;
      definition = { ...(t as Record<string, unknown>), id: input.workflow };
      comment = `${t.name} のワークフロー。dg workflow set が同梱のテンプレート ${t.id} から置いた`;
    } else {
      definition = input.definition!;
      if (definition["id"] !== input.workflow) {
        throw new OperationError(
          "VALIDATION_FAILED",
          `定義の id（${String(definition["id"])}）が ${input.workflow} と違う`,
        );
      }
    }
    const relPath = workflowPath(input.workflow);
    const result = await withWrite(
      ctx,
      async () => {
        const created = !(await pathExists(path.join(ctx.store.root, relPath)));
        const before = ctx.store.workflows.get(input.workflow)?.definition ?? null;
        const entry = await ctx.store.writeWorkflow(definition, comment);
        return {
          workflow: input.workflow,
          path: relPath,
          created,
          changed: changedKeys(before, entry.definition),
          before,
          after: entry.definition,
        };
      },
      {
        message: (v) =>
          `Workflow ${input.workflow} を${v.created ? "作成" : "置き換え"}${
            input.template !== undefined ? `（テンプレート ${input.template}）` : ""
          }`,
      },
    );
    const warnings = ctx.store.issues.filter((i) => i.path === relPath).map(formatIssue);
    return ok(result.value, result.write, warnings);
  },
});

export const workflowCommands = [workflowList, workflowShow, workflowValidate, workflowSet];
