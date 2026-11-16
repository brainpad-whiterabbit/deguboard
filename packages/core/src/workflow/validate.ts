// workflow.yaml の検証（WF-3）。読み込み時と dg workflow validate と dg workflow set が同じ関数を使う

import { z } from "zod";
import { STATUSES } from "../model/common.js";
import {
  BOUNDARIES,
  FLOW_BUNDLED_STAGES,
  FLOW_DECIDED_STAGES,
  FLOW_SKIP_KEY,
  WORKFLOW_ITEMS,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "../model/workflow.js";
import type { Issue } from "../storage/issue.js";
import { parseCondition } from "./conditions.js";
import { resolveWorkflow, type ResolvedWorkflow } from "./resolve.js";

export interface WorkflowValidation {
  workflow?: ResolvedWorkflow;
  definition?: WorkflowDefinition;
  issues: Issue[];
}

/** 独自の段階の名前。小文字・数字・`-` */
const STAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

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
          message: "The Workflow definition has the wrong shape",
          detail: z.prettifyError(parsed.error),
        },
      ],
    };
  }
  const def = parsed.data;
  const issues: Issue[] = [];
  const issue = (code: string, message: string, severity: Issue["severity"] = "error") =>
    issues.push({ severity, code, path, message });

  // 未知の項目は警告にとどめ、ほかの項目は読む。新しい版の dg が足した項目や、やめた項目（前の版の transitions）を書いた YAML を読んでも、判定と照合を止めない
  for (const key of Object.keys(def)) {
    if (WORKFLOW_ITEMS.includes(key)) continue;
    issue(
      "workflow_item_unknown",
      key === "transitions"
        ? "transitions is no longer read. Write the conditions (requires) and who decides (decide) of a move forward in boundaries, and the values of the moves back and to abandoned in exceptions (dg workflow show gives the shape)"
        : `Unknown item ${key}. It is not read`,
      "warning",
    );
  }
  for (const s of Object.keys(def.states ?? {})) {
    if (!(STATUSES as readonly string[]).includes(s))
      issue(
        "workflow_status_unknown",
        `states: Status ${s} does not exist. The Statuses are fixed (${STATUSES.join(", ")}); only their labels can be changed`,
      );
  }
  const boundaries = new Set<string>();
  def.boundaries?.forEach((b, i) => {
    for (const c of b.requires) {
      if (!parseCondition(c))
        issue("workflow_condition_unknown", `boundaries[${i}]: unknown condition ${c}`);
    }
    const key = `${b.from}>${b.to}`;
    if (!BOUNDARIES.some((known) => known.from === b.from && known.to === b.to)) {
      issue(
        "workflow_boundary_unknown",
        `boundaries[${i}]: ${b.from} → ${b.to} is not a boundary. The boundaries are ${BOUNDARIES.map((k) => `${k.from} → ${k.to}`).join(", ")}`,
      );
    } else if (boundaries.has(key)) {
      issue("workflow_boundary_duplicate", `boundaries[${i}]: ${b.from} → ${b.to} is duplicated`);
    }
    boundaries.add(key);
  });
  validateFlow(def, issue);

  def.reconcile?.forEach((r, i) => {
    for (const c of r.when) {
      if (!parseCondition(c))
        issue("workflow_condition_unknown", `reconcile[${i}]: unknown condition ${c}`);
    }
    if (r.status === "abandoned")
      issue("workflow_reconcile_abandoned", `reconcile[${i}]: reconcile cannot set abandoned`);
  });

  return { workflow: resolveWorkflow(def), definition: def, issues };
}

/**
 * flow の鍵ごとの検査。同梱の段階は権限の値、独自の段階は decide・after・guide、skip は段階の名前のリスト。
 * 独自の段階の guide の文書があるかは見ない（リポジトリの中のパスで、データの側からは読めない）
 */
function validateFlow(
  def: WorkflowDefinition,
  issue: (code: string, message: string) => void,
): void {
  const flow = def.flow ?? {};
  const bundled: readonly string[] = FLOW_BUNDLED_STAGES;
  const decided: readonly string[] = FLOW_DECIDED_STAGES;
  const custom = new Set<string>();
  for (const [key, value] of Object.entries(flow)) {
    if (key === FLOW_SKIP_KEY) {
      if (!Array.isArray(value)) issue("workflow_flow_skip", "flow.skip: write a list of stages");
    } else if (Array.isArray(value)) {
      issue(
        "workflow_flow_stage",
        `flow.${key}: a stage takes a value or decide, after, and guide`,
      );
    } else if (decided.includes(key)) {
      if (typeof value !== "string")
        issue(
          "workflow_flow_stage",
          `flow.${key}: a bundled stage takes only a value. after and guide are for your own stages`,
        );
    } else if (bundled.includes(key)) {
      issue("workflow_flow_stage", `flow.${key}: the ${key} stage has no value to set`);
    } else if (!STAGE_NAME.test(key)) {
      issue("workflow_flow_stage", `flow.${key}: a stage name is lowercase letters, digits and -`);
    } else if (typeof value === "string") {
      issue(
        "workflow_flow_stage",
        `flow.${key}: unknown stage. The bundled stages are ${decided.join(", ")}; your own stage needs decide, after, and guide`,
      );
    } else custom.add(key);
  }
  const skip = flow[FLOW_SKIP_KEY];
  if (Array.isArray(skip)) {
    for (const stage of skip) {
      if (!bundled.includes(stage) && !custom.has(stage))
        issue("workflow_flow_skip", `flow.skip: unknown stage ${stage}`);
    }
  }
}
