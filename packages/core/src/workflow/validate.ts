// workflow.yaml の検証（WF-3）。読み込み時と dg workflow validate と dg workflow set が同じ関数を使う

import { z } from "zod";
import { STATUSES } from "../model/common.js";
import {
  BOUNDARIES,
  DECISIONS,
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

/** 独自の段階の名前。小文字・数字・`-`。先頭の `-` は受けない（dg checkpoint <名前> でオプションと読まれる） */
const STAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 独自の段階に使えない名前。dg flow next が同梱の段階のほかに返す名前（終わった Plan を閉じる close と、止まる stop）で、
 * 独自の段階に使うと、流れを回す側（guide all）が止まる手と見分けられない
 */
const RESERVED_STAGE_NAMES: readonly string[] = ["close", "stop"];

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
        ...customStageProblems(raw).map((message): Issue => ({
          severity: "error",
          code: "workflow_flow_stage",
          path,
          message,
        })),
      ],
    };
  }
  const def = parsed.data;
  const issues: Issue[] = [];
  const issue = (code: string, message: string, severity: Issue["severity"] = "error") =>
    issues.push({ severity, code, path, message });

  // 未知の項目は警告にとどめ、ほかの項目は読む。新しい版の dg が足した項目や、やめた項目（前の版の transitions・reconcile）を書いた YAML を読んでも、判定と照合を止めない
  for (const key of Object.keys(def)) {
    if (WORKFLOW_ITEMS.includes(key)) continue;
    issue(
      "workflow_item_unknown",
      key === "transitions"
        ? "transitions is no longer read. Write the conditions (requires) and who decides (decide) of a move forward in boundaries, and the values of the moves back and to abandoned in exceptions (dg workflow show gives the shape)"
        : key === "reconcile"
          ? "reconcile is no longer read. The triggers of reconcile are fixed (a work branch exists → in_progress, a PR that is not a draft is open → review, the PR or the branch is merged → done), and reconcile advances a ticket only when the requires of the boundaries it crosses are met. Delete the item"
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

  return { workflow: resolveWorkflow(def), definition: def, issues };
}

/**
 * 形の誤りのうち、独自の段階（flow の中の、decide・after・guide を持つ項目）の誤りを名指しで返す。
 * 形の検査（workflow_schema）は flow の値を 3 つの形の和で見るので、どの鍵が違うかを言えない（「Invalid input at flow.<名前>」になる）。
 * after に書けるのは同梱の段階（work を含む）だけで、独自の段階の名前は書けない
 */
function customStageProblems(raw: unknown): string[] {
  const flow = (raw as { flow?: unknown } | null)?.flow;
  if (flow === null || typeof flow !== "object" || Array.isArray(flow)) return [];
  const bundled: readonly string[] = FLOW_BUNDLED_STAGES;
  const decisions: readonly string[] = DECISIONS;
  const problems: string[] = [];
  for (const [key, value] of Object.entries(flow)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const stage = value as Record<string, unknown>;
    const missing = ["decide", "after", "guide"].filter((k) => stage[k] === undefined);
    if (missing.length > 0)
      problems.push(`flow.${key}: your own stage needs ${missing.join(", ")}`);
    if (stage.decide !== undefined && !decisions.includes(stage.decide as string))
      problems.push(`flow.${key}.decide: write one of ${decisions.join(", ")}`);
    if (stage.after !== undefined && !bundled.includes(stage.after as string))
      problems.push(
        `flow.${key}.after: write one of the bundled stages (${bundled.join(", ")}). A stage of your own cannot come after another stage of your own; stages with the same after run in the order written`,
      );
    if (stage.guide !== undefined && (typeof stage.guide !== "string" || stage.guide === ""))
      problems.push(
        `flow.${key}.guide: write the path of the document of the stage's steps, relative to the repository`,
      );
  }
  return problems;
}

/**
 * flow の鍵ごとの検査。同梱の段階は権限の値、独自の段階は decide・after・guide、skip は段階の名前のリスト。
 * 独自の段階の decide・after・guide の形（after が同梱の段階か）は形の検査が見て、customStageProblems が名指しで返す。
 * 独自の段階の guide の文書があるかは見ない（リポジトリの中のパスで、データの側からは読めない。読めなければ dg flow next が警告する）
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
    } else if (RESERVED_STAGE_NAMES.includes(key)) {
      issue(
        "workflow_flow_stage",
        `flow.${key}: ${key} is a stage name that dg flow next returns itself, so your own stage cannot use it`,
      );
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
