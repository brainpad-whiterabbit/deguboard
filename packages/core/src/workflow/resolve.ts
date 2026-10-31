// Workflow 定義と組み込みの遷移表の合成、遷移の検査

import { STATUSES, type Status } from "../model/common.js";
import type { Actor, Condition, FieldDefinition, WorkflowDefinition } from "../model/workflow.js";
import { evaluateAll, type Facts } from "./conditions.js";
import { BUILTIN_TRANSITIONS, type Transition } from "./transitions.js";

export interface ReconcileRule {
  when: readonly Condition[];
  status: Status;
}

/** 組み込みの表と合成した、検査に使う形の Workflow */
export interface ResolvedWorkflow {
  id: string;
  name: string;
  labels: Record<Status, string>;
  transitions: readonly Transition[];
  reconcile: readonly ReconcileRule[];
  fields: readonly FieldDefinition[];
}

const DEFAULT_LABELS: Record<Status, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  abandoned: "Abandoned",
};

/**
 * 定義の transitions を組み込みの表に重ねる。requires は和、by は積（狭めるだけ）。
 * 表にない遷移や未知の条件は validate.ts が先に指摘する前提で、ここでは無視する
 */
export function resolveWorkflow(def: WorkflowDefinition): ResolvedWorkflow {
  const transitions = BUILTIN_TRANSITIONS.map((builtin) => {
    const overrides = def.transitions.filter((t) => t.from === builtin.from && t.to === builtin.to);
    let by = builtin.by;
    const requires = new Set<Condition>(builtin.requires);
    for (const o of overrides) {
      for (const r of o.requires) requires.add(r as Condition);
      if (o.by) by = by.filter((a) => (o.by as Actor[]).includes(a));
    }
    return { ...builtin, by, requires: [...requires] };
  });
  const labels = { ...DEFAULT_LABELS };
  for (const s of STATUSES) {
    const label = def.labels?.[s];
    if (label) labels[s] = label;
  }
  return {
    id: def.id,
    name: def.name,
    labels,
    transitions,
    reconcile: def.reconcile.map((r) => ({ when: r.when as Condition[], status: r.status })),
    fields: def.fields,
  };
}

export type TransitionCheck =
  | { ok: true; transition: Transition }
  | {
      ok: false;
      reason: "no_transition" | "actor_not_allowed" | "requires_unmet";
      unmet: Condition[];
    };

/** from → to を actor が行えるか。事実が不明の条件は満たさないと読む */
export function canTransition(
  wf: ResolvedWorkflow,
  from: Status,
  to: Status,
  actor: Actor,
  facts: Facts,
): TransitionCheck {
  const transition = wf.transitions.find((t) => t.from === from && t.to === to);
  if (!transition) return { ok: false, reason: "no_transition", unmet: [] };
  if (!transition.by.includes(actor)) return { ok: false, reason: "actor_not_allowed", unmet: [] };
  const result = evaluateAll(transition.requires, facts);
  if (!result.ok) return { ok: false, reason: "requires_unmet", unmet: result.unmet };
  return { ok: true, transition };
}

/** 遷移が拒否された理由を人向けの文にする */
export function describeRejection(
  check: Extract<TransitionCheck, { ok: false }>,
  from: Status,
  to: Status,
): string {
  switch (check.reason) {
    case "no_transition":
      return `${from} から ${to} への遷移は遷移表にない`;
    case "actor_not_allowed":
      return `${from} から ${to} への遷移はこの主体には許されていない`;
    case "requires_unmet":
      return `${from} から ${to} への遷移の条件を満たしていない: ${check.unmet.join(", ")}`;
  }
}
