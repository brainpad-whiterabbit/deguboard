// Workflow 定義の transitions を from→to ごとの制約に合成し、遷移を検査する。
// 制約のない遷移は誰でも条件なしで行える（ADR-003）

import { STATUSES, type Status } from "../model/common.js";
import type {
  Actor,
  Condition,
  FieldDefinition,
  StepDefinition,
  StepOpener,
  WorkflowDefinition,
} from "../model/workflow.js";
import { evaluateAll, type Facts } from "./conditions.js";

export interface ReconcileRule {
  when: readonly Condition[];
  status: Status;
}

/** YAML の transitions を from→to ごとに合成した制約 */
export interface TransitionConstraint {
  from: Status;
  to: Status;
  /** 行える主体。省略なら誰でも、[] なら誰も行えない */
  by?: readonly Actor[];
  /** 満たすべき条件（AND） */
  requires: readonly Condition[];
}

/** 検査に使う形の Workflow。transitions は制約だけで、書かれていない遷移は自由 */
export interface ResolvedWorkflow {
  id: string;
  name: string;
  labels: Record<Status, string>;
  transitions: readonly TransitionConstraint[];
  reconcile: readonly ReconcileRule[];
  fields: readonly FieldDefinition[];
  /** Run の step の語彙。undefined なら step を縛らない */
  steps: readonly StepDefinition[] | undefined;
}

const DEFAULT_LABELS: Record<Status, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  abandoned: "Abandoned",
};

/**
 * 定義の transitions を from→to ごとに 1 件にまとめる。同じ組が複数あれば requires は和、
 * by は両方にあれば積（狭い方に倒す）。重複は validate.ts が指摘する前提で、ここでは安全側に合成する
 */
export function resolveWorkflow(def: WorkflowDefinition): ResolvedWorkflow {
  const merged = new Map<string, TransitionConstraint>();
  for (const t of def.transitions) {
    const key = `${t.from}>${t.to}`;
    const prev = merged.get(key);
    const requires = new Set<Condition>(prev?.requires ?? []);
    for (const r of t.requires) requires.add(r as Condition);
    let by = prev?.by;
    if (t.by) by = by ? by.filter((a) => (t.by as Actor[]).includes(a)) : (t.by as Actor[]);
    merged.set(key, { from: t.from, to: t.to, ...(by ? { by } : {}), requires: [...requires] });
  }
  const labels = { ...DEFAULT_LABELS };
  for (const s of STATUSES) {
    const label = def.labels?.[s];
    if (label) labels[s] = label;
  }
  return {
    id: def.id,
    name: def.name,
    labels,
    transitions: [...merged.values()],
    reconcile: def.reconcile.map((r) => ({ when: r.when as Condition[], status: r.status })),
    fields: def.fields,
    steps: def.steps,
  };
}

/** from → to に Workflow が書いた制約。なければ undefined（自由な遷移） */
export function findConstraint(
  wf: ResolvedWorkflow,
  from: Status,
  to: Status,
): TransitionConstraint | undefined {
  return wf.transitions.find((t) => t.from === from && t.to === to);
}

export type TransitionCheck =
  | { ok: true; constraint?: TransitionConstraint }
  | {
      ok: false;
      reason: "actor_not_allowed" | "requires_unmet";
      unmet: Condition[];
    };

/** from → to を actor が行えるか。制約がなければ通す。事実が不明の条件は満たさないと読む */
export function canTransition(
  wf: ResolvedWorkflow,
  from: Status,
  to: Status,
  actor: Actor,
  facts: Facts,
): TransitionCheck {
  const constraint = findConstraint(wf, from, to);
  if (!constraint) return { ok: true };
  if (constraint.by && !constraint.by.includes(actor)) {
    return { ok: false, reason: "actor_not_allowed", unmet: [] };
  }
  const result = evaluateAll(constraint.requires, facts);
  if (!result.ok) return { ok: false, reason: "requires_unmet", unmet: result.unmet };
  return { ok: true, constraint };
}

/** 遷移が拒否された理由を人向けの文にする */
export function describeRejection(
  check: Extract<TransitionCheck, { ok: false }>,
  from: Status,
  to: Status,
): string {
  switch (check.reason) {
    case "actor_not_allowed":
      return `The Workflow does not allow this actor to move from ${from} to ${to}`;
    case "requires_unmet":
      return `The conditions for moving from ${from} to ${to} are not met: ${check.unmet.join(", ")}`;
  }
}

/** step が Workflow の語彙にあるか。steps のない Workflow はどの step も受ける（DT-2） */
export function findStep(
  wf: ResolvedWorkflow,
  step: string,
): { ok: true; step?: StepDefinition } | { ok: false; known: string[] } {
  if (!wf.steps) return { ok: true };
  const found = wf.steps.find((s) => s.id === step);
  return found ? { ok: true, step: found } : { ok: false, known: wf.steps.map((s) => s.id) };
}

/**
 * opens_on が無いときに開く step。同梱のテンプレートの実装（claim）と手直し（reclaim）の step の名前（RN-5）。
 * 閉じる側（findOpenedRun）も同じ step を探す
 */
export const DEFAULT_OPENED_STEPS: Readonly<Record<StepOpener, string>> = {
  claim: "implement",
  reclaim: "fix",
};

/**
 * チケットの操作（claim・reclaim）が開く Run の step（RN-5）。`opens_on` にその操作を書いた step、なければ既定の名前。
 * steps のない Workflow も既定の名前（縛らないので開ける）。語彙にあるかは呼ぶ側が findStep で確かめる
 */
export function stepOpenedOn(wf: ResolvedWorkflow, opener: StepOpener): string {
  return wf.steps?.find((s) => s.opens_on === opener)?.id ?? DEFAULT_OPENED_STEPS[opener];
}
