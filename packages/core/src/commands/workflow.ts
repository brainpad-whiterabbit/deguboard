// カンバンに 1 つの Workflow（workflow.yaml）の参照・検証（WF-3）・書き換え

import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withWrite } from "../git/write.js";
import { RUN_STEPS } from "../model/run.js";
import { pathExists } from "../storage/exists.js";
import { formatIssue } from "../storage/issue.js";
import { RETIRED_WORKFLOWS_DIR, WORKFLOW_FILE } from "../storage/paths.js";
import { CORE_FIXED, DEFAULT_WORKFLOW, movePermissions, writtenForm } from "../workflow/resolve.js";
import { defineCommand, ok } from "./define.js";
import { permissionFields, recordNote } from "./permission.js";

export const workflowShow = defineCommand({
  name: "workflow.show",
  group: "workflow",
  summary:
    "Show the board's Workflow (workflow.yaml). definition has every item with the items the file omits filled in from the defaults (states, boundaries, exceptions, wip, flow, and governance), in the shape dg workflow set takes. exists is false when there is no workflow.yaml, and everything is then the default. moves gives, for every move from one Status to another, the policy that judges it (the boundaries it crosses, or exceptions.abandon, back, or reopen), its requires, and what the values mean for a person and for an agent: allow (goes ahead), approval (an agent needs a person's approval, --approved-by), override (a person needs --override), or reject (dg ticket move --help). The values under governance judge the operations that manage the board in the same way: delete (dg ticket delete), config (dg config set and unset on the team's config.yaml), reassign (changing or removing another user's assignee or claim: dg ticket update --assignee, claim, unclaim --force), epic (dg epic close and reopen), and create (dg ticket create and import); ask_unless_auto asks like always_ask here. fixed are the operations fixed in Core, which workflow.yaml cannot change: workflow_set (dg workflow set: always a person's approval), hooks_uninstall (dg hooks uninstall: a person only), lower_gate (dg ticket update --gate to a lower level: a person only), and merge_over_gate (dg pr merge of a PR that does not meet the quality gate: always --approved-by). default_labels are the Status labels when states is omitted, and steps are the Run steps, which dg fixes",
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
      // Core に固定の操作と値（workflow.yaml では変えられない。エージェントと画面が、設定で緩められない操作を知る）
      fixed: CORE_FIXED,
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
    "Write workflow.yaml (create it if missing, replace it if present) from a definition. Any item can be omitted, and an omitted item uses the default. If there is an error the same as on load, nothing is written (an unknown item is only a warning). before and after are the Workflows with the defaults filled in. It also removes the workflows/ directory of earlier versions, which is no longer read. Fixed in Core, and workflow.yaml cannot change it: an agent's call always needs a person's approval (--approved-by; without it the call returns TRANSITION_REJECTED and writes nothing), also in a flow that goes ahead without asking (--auto), because the Workflow decides what an agent may do without asking. Before asking, show the person the items that would change, before and after (compare the definition of dg workflow show with the file to write). The approver is recorded in the commit message (dg history shows it), and the change is committed at once",
  input: z.object({
    definition: z
      .record(z.string(), z.unknown())
      .meta({ cliFile: "file" })
      .describe(
        "The Workflow definition. Its shape is the same as the definition from dg workflow show",
      ),
    approved_by: permissionFields.approved_by,
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
      {
        message: (v) =>
          `${v.created ? "Create" : "Replace"} ${WORKFLOW_FILE}${recordNote(ctx, input)}`,
        // 誰の承認で権限の値を変えたかを、この操作のコミットに残す（まとめ待ちにしない）
        immediate: true,
      },
    );
    const warnings = ctx.store.issues.filter((i) => i.path === WORKFLOW_FILE).map(formatIssue);
    return ok(result.value, result.write, warnings);
  },
});

export const workflowCommands = [workflowShow, workflowValidate, workflowSet];
