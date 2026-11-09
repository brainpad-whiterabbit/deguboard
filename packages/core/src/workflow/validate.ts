// Workflow 定義の検証（WF-3）。読み込み時と dg workflow validate が同じ関数を使う

import { z } from "zod";
import { STATUSES } from "../model/common.js";
import { workflowDefinitionSchema, type WorkflowDefinition } from "../model/workflow.js";
import type { Issue } from "../storage/issue.js";
import { parseCondition } from "./conditions.js";
import { resolveWorkflow, type ResolvedWorkflow } from "./resolve.js";

export interface WorkflowValidation {
  workflow?: ResolvedWorkflow;
  definition?: WorkflowDefinition;
  issues: Issue[];
}

export interface WorkflowValidationOptions {
  /**
   * steps に書ける Action の名前（登録済みの Action の一覧）。workflow は actions に依存しないので、
   * 入口が core/actions の ACTION_NAMES を渡す（ADR-033）。省略すると Action の名前は形だけ見る
   */
  actions?: readonly string[] | undefined;
}

/** 生の値（YAML を読んだもの）を検証し、使える形にする。致命的でない指摘でも workflow は返す */
export function validateWorkflow(
  raw: unknown,
  path: string,
  options: WorkflowValidationOptions = {},
): WorkflowValidation {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: [
        {
          severity: "error",
          code: "workflow_schema",
          path,
          message: "Workflow 定義の形が違う",
          detail: z.prettifyError(parsed.error),
        },
      ],
    };
  }
  const def = parsed.data;
  const issues: Issue[] = [];
  const issue = (code: string, message: string, severity: Issue["severity"] = "error") =>
    issues.push({ severity, code, path, id: def.id, message });

  const seen = new Set<string>();
  def.transitions.forEach((t, i) => {
    for (const c of t.requires) {
      if (!parseCondition(c))
        issue("workflow_condition_unknown", `transitions[${i}]: 未知の条件 ${c}`);
    }
    if (t.from === t.to) {
      issue(
        "workflow_transition_self",
        `transitions[${i}]: ${t.from} → ${t.to} は意味がない。同じ Status への move は常に拒否される`,
      );
      return;
    }
    const key = `${t.from}>${t.to}`;
    if (seen.has(key)) {
      issue(
        "workflow_transition_duplicate",
        `transitions[${i}]: ${t.from} → ${t.to} が重複している。1 つにまとめる`,
      );
    }
    seen.add(key);
  });
  def.reconcile.forEach((r, i) => {
    for (const c of r.when) {
      if (!parseCondition(c))
        issue("workflow_condition_unknown", `reconcile[${i}]: 未知の条件 ${c}`);
    }
    if (r.status === "abandoned")
      issue("workflow_reconcile_abandoned", `reconcile[${i}]: 照合で abandoned にはできない`);
  });
  for (const s of Object.keys(def.labels ?? {})) {
    if (!(STATUSES as readonly string[]).includes(s))
      issue("workflow_status_unknown", `labels: 存在しない Status ${s}`);
  }
  const fieldIds = new Set<string>();
  def.fields.forEach((f, i) => {
    if (fieldIds.has(f.id))
      issue("workflow_field_duplicate", `fields[${i}]: ${f.id} が重複している`);
    fieldIds.add(f.id);
    if (f.type === "enum" && (!f.options || f.options.length === 0)) {
      issue("workflow_field_options", `fields[${i}]: enum の ${f.id} には options が要る`);
    }
  });
  const stepIds = new Set<string>();
  /** opens_on の操作ごとに、先に付けた step の名前。同じ操作が 2 つ以上の step を開くとどちらを開くか決まらない（RN-5） */
  const openers = new Map<string, string>();
  def.steps?.forEach((step, i) => {
    if (stepIds.has(step.id))
      issue("workflow_step_duplicate", `steps[${i}]: ${step.id} が重複している`);
    stepIds.add(step.id);
    if (step.opens_on) {
      const first = openers.get(step.opens_on);
      if (first) {
        issue(
          "workflow_opens_on_duplicate",
          `steps[${i}]: opens_on: ${step.opens_on} は ${first} にも付いている。1 つの step にだけ付ける`,
        );
      } else openers.set(step.opens_on, step.id);
    }
    // 未知の Action は警告にとどめ、Workflow を索引に残す。新しい版の dg で足した Action を書いた YAML を
    // 古い版で読んでも、遷移と照合を止めない
    for (const action of step.actions) {
      if (options.actions && !options.actions.includes(action))
        issue("workflow_action_unknown", `steps[${i}]: 未知の Action ${action}`, "warning");
    }
  });

  return { workflow: resolveWorkflow(def), definition: def, issues };
}
