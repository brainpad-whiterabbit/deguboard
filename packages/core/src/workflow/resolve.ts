// workflow.yaml の定義を、省いた項目を Core の既定で補った形にし、遷移を検査する。
// 制約のない遷移は誰でも条件なしで行える（ADR-003）

import { STATUSES, type Status } from "../model/common.js";
import {
  BOUNDARIES,
  EXCEPTION_MOVES,
  FLOW_DECIDED_STAGES,
  FLOW_SKIP_KEY,
  GOVERNANCE_OPERATIONS,
  type Actor,
  type Condition,
  type CustomStageDefinition,
  type Decision,
  type ExceptionMove,
  type FlowDecidedStage,
  type GovernanceOperation,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
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

/** 境目：越える条件（AND）と、決める人の権限の値 */
export interface Boundary {
  from: Status;
  to: Status;
  requires: readonly Condition[];
  decide: Decision;
}

export interface CustomStage extends CustomStageDefinition {
  id: string;
}

/** 省いた項目を Core の既定で補った Workflow。transitions は制約だけで、書かれていない遷移は自由 */
export interface ResolvedWorkflow {
  /** Status の表示名 */
  labels: Record<Status, string>;
  /** 3 つの境目（BOUNDARIES の順） */
  boundaries: readonly Boundary[];
  exceptions: Record<ExceptionMove, Decision>;
  /** 列ごとの上限。ない列は上限なし */
  wip: Partial<Record<Status, number>>;
  flow: {
    stages: Record<FlowDecidedStage, Decision>;
    custom: readonly CustomStage[];
    skip: readonly string[];
  };
  governance: Record<GovernanceOperation, Decision>;
  transitions: readonly TransitionConstraint[];
  reconcile: readonly ReconcileRule[];
}

// ---- Core の既定（省いた項目の値。dg init が置く既定の workflow.yaml も同じ値を書く） ----

const DEFAULT_LABELS: Record<Status, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  abandoned: "Abandoned",
};

const DEFAULT_BOUNDARIES: readonly Boundary[] = [
  { ...BOUNDARIES[0], requires: ["deps_done"], decide: "anyone" },
  { ...BOUNDARIES[1], requires: [], decide: "anyone" },
  { ...BOUNDARIES[2], requires: ["pr_merged"], decide: "ask_unless_auto" },
];

const DEFAULT_EXCEPTIONS: Record<ExceptionMove, Decision> = {
  abandon: "human_only",
  back: "anyone",
  reopen: "human_only",
};

const DEFAULT_WIP: Partial<Record<Status, number>> = { in_progress: 5, review: 3 };

const DEFAULT_FLOW_STAGES: Record<FlowDecidedStage, Decision> = {
  assign: "ask_unless_auto",
  check: "ask_unless_auto",
  plan: "ask_unless_auto",
  audit: "always_ask",
  release: "human_only",
  retro: "always_ask",
};

const DEFAULT_GOVERNANCE: Record<GovernanceOperation, Decision> = {
  delete: "human_only",
  config: "always_ask",
  reassign: "always_ask",
  epic: "human_only",
  create: "anyone",
};

/**
 * 照合の規則の既定。PR の事実は gh があるときだけ使われ、なくても branch_merged で done になる。
 * squash マージは祖先判定で取れないので PR のマージを先に見る
 */
const DEFAULT_RECONCILE: readonly ReconcileRule[] = [
  { when: ["pr_merged"], status: "done" },
  { when: ["branch_merged"], status: "done" },
  { when: ["pr_open", "!pr_draft"], status: "review" },
  { when: ["branch_exists"], status: "in_progress" },
];

/** 書いた値に、書いていない鍵の既定を足す */
function withDefaults<K extends string, V>(
  keys: readonly K[],
  defaults: Record<K, V>,
  written: { [P in K]?: V | undefined } | undefined,
): Record<K, V> {
  const out: Record<K, V> = { ...defaults };
  for (const k of keys) {
    const v = written?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 定義を、省いた項目を Core の既定で補った形にする。states・boundaries・exceptions・flow・governance は書いた鍵だけを替え、
 * wip は項目ごと替える（書けば書いた列だけに上限が付く）。transitions は from→to ごとに 1 件にまとめる：同じ組が複数あれば
 * requires は和、by は両方にあれば積（狭い方に倒す）。重複は validate.ts が指摘する前提で、ここでは安全側に合成する
 */
export function resolveWorkflow(def: WorkflowDefinition): ResolvedWorkflow {
  const labels = { ...DEFAULT_LABELS };
  for (const s of STATUSES) {
    const label = def.states?.[s]?.label;
    if (label) labels[s] = label;
  }
  const boundaries = DEFAULT_BOUNDARIES.map((d) => {
    const written = def.boundaries?.find((b) => b.from === d.from && b.to === d.to);
    return written
      ? { ...d, requires: written.requires as Condition[], decide: written.decide ?? d.decide }
      : d;
  });
  const stages = { ...DEFAULT_FLOW_STAGES };
  const custom: CustomStage[] = [];
  let skip: string[] = [];
  for (const [key, value] of Object.entries(def.flow ?? {})) {
    if (Array.isArray(value)) {
      if (key === FLOW_SKIP_KEY) skip = value;
    } else if (typeof value === "string") {
      if ((FLOW_DECIDED_STAGES as readonly string[]).includes(key))
        stages[key as FlowDecidedStage] = value;
    } else custom.push({ id: key, ...value });
  }
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
  return {
    labels,
    boundaries,
    exceptions: withDefaults(EXCEPTION_MOVES, DEFAULT_EXCEPTIONS, def.exceptions),
    wip: def.wip ?? DEFAULT_WIP,
    flow: { stages, custom, skip },
    governance: withDefaults(GOVERNANCE_OPERATIONS, DEFAULT_GOVERNANCE, def.governance),
    transitions: [...merged.values()],
    reconcile:
      def.reconcile?.map((r) => ({ when: r.when as Condition[], status: r.status })) ??
      DEFAULT_RECONCILE,
  };
}

/**
 * 補った Workflow を workflow.yaml に書く形に戻す（どの項目も書いた形。dg workflow show の definition）。
 * 前の形のまま読む 2 つ（transitions・reconcile）も入れる
 */
export function writtenForm(wf: ResolvedWorkflow): WorkflowDefinitionInput {
  return {
    states: Object.fromEntries(STATUSES.map((s) => [s, { label: wf.labels[s] }])),
    boundaries: wf.boundaries.map((b) => ({ ...b, requires: [...b.requires] })),
    exceptions: wf.exceptions,
    wip: wf.wip,
    flow: {
      ...wf.flow.stages,
      ...Object.fromEntries(wf.flow.custom.map(({ id, ...stage }) => [id, stage])),
      [FLOW_SKIP_KEY]: [...wf.flow.skip],
    },
    governance: wf.governance,
    transitions: wf.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      requires: [...t.requires],
      ...(t.by ? { by: [...t.by] } : {}),
    })),
    reconcile: wf.reconcile.map((r) => ({ when: [...r.when], status: r.status })),
  };
}

/**
 * dg init が置く既定の workflow.yaml。6 つの項目を Core の既定の値で書く（書き換える場所が見えるように）。
 * 前の形のまま読む 2 つは書かない（省けば既定）
 */
export function defaultWorkflowFile(): WorkflowDefinitionInput {
  const { transitions: _t, reconcile: _r, ...items } = writtenForm(DEFAULT_WORKFLOW);
  return items;
}

/** workflow.yaml がないとき（どの項目も省いたとき）の Workflow */
export const DEFAULT_WORKFLOW: ResolvedWorkflow = resolveWorkflow({ transitions: [] });

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
