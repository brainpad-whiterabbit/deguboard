// カンバンに 1 つの Workflow（workflow.yaml）の参照・検証（WF-3）・書き換え

import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withWrite } from "../git/write.js";
import { RUN_STEPS } from "../model/run.js";
import { pathExists } from "../storage/exists.js";
import { formatIssue } from "../storage/issue.js";
import { RETIRED_WORKFLOWS_DIR, WORKFLOW_FILE } from "../storage/paths.js";
import { DEFAULT_WORKFLOW, movePermissions, writtenForm } from "../workflow/resolve.js";
import { defineCommand, ok } from "./define.js";

export const workflowShow = defineCommand({
  name: "workflow.show",
  group: "workflow",
  summary:
    "Show the board's Workflow (workflow.yaml). definition has every item with the items the file omits filled in from the defaults (states, boundaries, exceptions, wip, flow, governance, and reconcile), in the shape dg workflow set takes. exists is false when there is no workflow.yaml, and everything is then the default. moves gives, for every move from one Status to another, the policy that judges it (the boundaries it crosses, or exceptions.abandon, back, or reopen), its requires, and what the values mean for a person and for an agent: allow (goes ahead), approval (an agent needs a person's approval, --approved-by), override (a person needs --override), or reject (dg ticket move --help). default_labels are the Status labels when states is omitted, and steps are the Run steps, which dg fixes",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    const w = ctx.store.requireWorkflow();
    return ok({
      path: w.path,
      exists: w.exists,
      definition: writtenForm(w.resolved),
      labels: w.resolved.labels,
      moves: movePermissions(w.resolved),
      // 書き換えていなければ出る Status の表示名。画面が labels と比べて既定のままなら訳す（UI-11）。画面は既定の写しを持たない
      default_labels: DEFAULT_WORKFLOW.labels,
      // Run の step の語彙と表示名は Core が持つ（WF-5）。画面は表示名を訳して出す
      steps: RUN_STEPS,
    });
  },
});

export const workflowValidate = defineCommand({
  name: "workflow.validate",
  group: "workflow",
  summary:
    "Show problems in workflow.yaml (unknown items, values, conditions and stages, Statuses that do not exist, boundaries other than the three, duplicates). An unknown item is only a warning. It also warns when the workflows/ directory of earlier versions remains and there is no workflow.yaml",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    // 前の版の workflows/ が残る警告（storage/store.ts）も、Workflow の指摘としてここに出す
    const issues = ctx.store.issues.filter(
      (i) => i.path === WORKFLOW_FILE || i.path === RETIRED_WORKFLOWS_DIR,
    );
    return ok({
      ok: issues.every((i) => i.severity !== "error"),
      exists: ctx.store.workflow?.exists ?? true,
      issues,
    });
  },
});

/** 前と後で値が違う項目（states・boundaries など） */
function changedItems(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// 要件 WF-3（読み込みと同じ誤りなら書かない）
export const workflowSet = defineCommand({
  name: "workflow.set",
  group: "workflow",
  summary:
    "Write workflow.yaml (create it if missing, replace it if present) from a definition. Any item can be omitted, and an omitted item uses the default. If there is an error the same as on load, nothing is written (an unknown item is only a warning). before and after are the Workflows with the defaults filled in. It also removes the workflows/ directory of earlier versions, which is no longer read",
  input: z.object({
    definition: z
      .record(z.string(), z.unknown())
      .meta({ cliFile: "file" })
      .describe(
        "The Workflow definition. Its shape is the same as the definition from dg workflow show",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const created = !(await pathExists(path.join(ctx.store.root, WORKFLOW_FILE)));
        // 誤りがあって読めなかった前の定義は、既定と比べる
        const before = writtenForm(ctx.store.workflow?.resolved ?? DEFAULT_WORKFLOW);
        const entry = await ctx.store.writeWorkflow(input.definition);
        const after = writtenForm(entry.resolved);
        const retired = path.join(ctx.store.root, RETIRED_WORKFLOWS_DIR);
        const removed = await pathExists(retired);
        if (removed) await rm(retired, { recursive: true, force: true });
        return {
          path: WORKFLOW_FILE,
          created,
          changed: changedItems(before, after),
          before,
          after,
          ...(removed ? { removed: RETIRED_WORKFLOWS_DIR } : {}),
        };
      },
      { message: (v) => `${v.created ? "Create" : "Replace"} ${WORKFLOW_FILE}` },
    );
    const warnings = ctx.store.issues.filter((i) => i.path === WORKFLOW_FILE).map(formatIssue);
    return ok(result.value, result.write, warnings);
  },
});

export const workflowCommands = [workflowShow, workflowValidate, workflowSet];
