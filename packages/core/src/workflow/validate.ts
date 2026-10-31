// Workflow 定義の検証（WF-3）。読み込み時と dg workflow validate が同じ関数を使う

import { z } from "zod";
import { STATUSES } from "../model/common.js";
import { workflowDefinitionSchema, type WorkflowDefinition } from "../model/workflow.js";
import type { Issue } from "../storage/issue.js";
import { parseCondition } from "./conditions.js";
import { resolveWorkflow, type ResolvedWorkflow } from "./resolve.js";
import { findBuiltinTransition } from "./transitions.js";

export interface WorkflowValidation {
  workflow?: ResolvedWorkflow;
  definition?: WorkflowDefinition;
  issues: Issue[];
}

/** 生の値（YAML を読んだもの）を検証し、使える形にする。致命的でない指摘でも workflow は返す */
export function validateWorkflow(raw: unknown, path: string): WorkflowValidation {
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
  const issue = (code: string, message: string) =>
    issues.push({ severity: "error", code, path, id: def.id, message });

  def.transitions.forEach((t, i) => {
    const builtin = findBuiltinTransition(t.from, t.to);
    if (!builtin) {
      issue(
        "workflow_transition_unknown",
        `transitions[${i}]: ${t.from} → ${t.to} は遷移表にない遷移`,
      );
      return;
    }
    for (const c of t.requires) {
      if (!parseCondition(c))
        issue("workflow_condition_unknown", `transitions[${i}]: 未知の条件 ${c}`);
    }
    for (const actor of t.by ?? []) {
      if (!builtin.by.includes(actor)) {
        issue(
          "workflow_actor_widened",
          `transitions[${i}]: ${t.from} → ${t.to} を ${actor} に広げることはできない`,
        );
      }
    }
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

  return { workflow: resolveWorkflow(def), definition: def, issues };
}
