// workflow.yaml の定義を、省いた項目を Core の既定で補った形にし、操作に当てる方針（越える条件と権限の値）を引く（ADR-003）

import { STATUSES, isForward, isTerminal, type Status } from "../model/common.js";
import {
  BOUNDARIES,
  EXCEPTION_MOVES,
  FLOW_DECIDED_STAGES,
  FLOW_SKIP_KEY,
  GOVERNANCE_OPERATIONS,
  type Condition,
  type CustomStageDefinition,
  type Decision,
  type ExceptionMove,
  type FlowDecidedStage,
  type GovernanceOperation,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from "../model/workflow.js";
import { judgeDecisions, type Permission } from "./conditions.js";

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

/** 省いた項目を Core の既定で補った Workflow */
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

// abandon と reopen は人の指示があるときだけ行う動き。指示を受けたエージェントが承認者を記録して行えるよう、
// human_only でなく always_ask にする
const DEFAULT_EXCEPTIONS: Record<ExceptionMove, Decision> = {
  abandon: "always_ask",
  back: "anyone",
  reopen: "always_ask",
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
 * wip は項目ごと替える（書けば書いた列だけに上限が付く）
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
  return {
    labels,
    boundaries,
    exceptions: withDefaults(EXCEPTION_MOVES, DEFAULT_EXCEPTIONS, def.exceptions),
    wip: def.wip ?? DEFAULT_WIP,
    flow: { stages, custom, skip },
    governance: withDefaults(GOVERNANCE_OPERATIONS, DEFAULT_GOVERNANCE, def.governance),
  };
}

/** 補った Workflow を workflow.yaml に書く形に戻す（どの項目も書いた形。dg workflow show の definition） */
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
  };
}

/** dg init が置く既定の workflow.yaml。6 つの項目を Core の既定の値で書く（書き換える場所が見えるように） */
export function defaultWorkflowFile(): WorkflowDefinitionInput {
  return writtenForm(DEFAULT_WORKFLOW);
}

/** workflow.yaml がないとき（どの項目も省いたとき）の Workflow */
export const DEFAULT_WORKFLOW: ResolvedWorkflow = resolveWorkflow({});

/** 操作に当てる方針がどこで決まったか（判定の順。operationPolicy） */
export type PolicySource = "core" | "exceptions" | "boundaries" | "flow" | "governance" | "none";

/** 操作に当てる方針：権限の値（いくつかあれば厳しいほうが効く）と、越える条件（AND） */
export interface OperationPolicy {
  source: PolicySource;
  /** 方針の名前（エラーの文に出す。例：exceptions.abandon、boundaries todo → in_progress） */
  name: string;
  decisions: readonly Decision[];
  requires: readonly Condition[];
}

/**
 * Core に固定の操作と権限の値。緩めると守りが崩れるので、workflow.yaml では変えられない（WF-7）。
 * - workflow_set：workflow.yaml の書き換え。エージェントが自分に許す範囲を聞かずに広げないように、いつも人の承認を求める
 * - hooks_uninstall：フックを外す。dg を経由しない書き込みと PR の操作を止める守り（AG-10）がなくなる
 * - lower_gate：チケットの品質ゲートの段を下げる。判定する条件が減る
 * - merge_over_gate：品質ゲートを満たさない PR のマージ。dg pr merge は主体によらず承認者（--approved-by）を求める（commands/pr.ts）
 */
export const CORE_FIXED = {
  workflow_set: "always_ask",
  hooks_uninstall: "human_only",
  lower_gate: "human_only",
  merge_over_gate: "always_ask",
} as const satisfies Record<string, Decision>;
export type CoreFixedOperation = keyof typeof CORE_FIXED;

/**
 * 権限を判定する操作。Status を変える操作は move を持つ（行き先はコマンドの名前と引数だけで決まる）。
 * fixed は Core に固定の操作、stage は流れの段階の操作、governs はカンバンの管理の操作。コマンドの名前だけで決まるものは
 * commandOperation が引き、入力とデータで決まるもの（チームの設定か・担当がほかのユーザか・段が下がるか・Iteration や Epic が変わるか）は
 * コマンドが自分で付ける
 */
export interface Operation {
  /** コマンドの名前（ticket.move など） */
  command: string;
  move?: { from: Status; to: Status } | undefined;
  fixed?: CoreFixedOperation | undefined;
  stage?: FlowDecidedStage | undefined;
  governs?: GovernanceOperation | undefined;
}

/**
 * コマンドの名前だけで決まる、Core に固定の操作・流れの段階の操作・カンバンの管理の操作（runCommand が実行の前に判定する）。
 * 流れの段階の値のうち dg がコマンドで止められるのは、割り当て（Iteration・Epic への出し入れ）・計画（Plan の承認）・
 * リリース（Iteration を閉じる/再開する）。点検・見直し・振り返りの値は、dg flow next が承認の要否として返す
 */
const COMMAND_OPERATIONS: Record<string, Pick<Operation, "fixed" | "stage" | "governs">> = {
  "workflow.set": { fixed: "workflow_set" },
  "iteration.add": { stage: "assign" },
  "iteration.remove": { stage: "assign" },
  "epic.add": { stage: "assign" },
  "epic.remove": { stage: "assign" },
  "plan.approve": { stage: "plan" },
  "iteration.close": { stage: "release" },
  "iteration.reopen": { stage: "release" },
  "ticket.delete": { governs: "delete" },
  "ticket.create": { governs: "create" },
  "ticket.import": { governs: "create" },
  "epic.close": { governs: "epic" },
  "epic.reopen": { governs: "epic" },
};

/** コマンドの名前だけで決まる操作。なければ undefined（入力とデータで決まる操作は、コマンドの中で判定する） */
export function commandOperation(command: string): Operation | undefined {
  const found = COMMAND_OPERATIONS[command];
  return found ? { command, ...found } : undefined;
}

/**
 * 名前だけで操作が決まるコマンドのうち、エージェントには拒む（権限の値が human_only の）もの。
 * 人の承認で進められるものは入れない（エージェントが --approved-by を付けて進める）
 */
export function commandsRejectedForAgent(wf: ResolvedWorkflow): string[] {
  return Object.keys(COMMAND_OPERATIONS).filter(
    (command) =>
      judgeDecisions(operationPolicy(wf, commandOperation(command)!).decisions, "agent") ===
      "reject",
  );
}

/**
 * 例外の動きの名前。abandoned へ動かすのは abandon、終わった Status（done・abandoned）から戻すのは reopen、
 * それ以外で前へ進まない動き（review → in_progress、unclaim など）は back。前へ進む動きと同じ Status は undefined
 */
export function exceptionMoveOf(from: Status, to: Status): ExceptionMove | undefined {
  if (from === to) return undefined;
  if (to === "abandoned") return "abandon";
  if (isTerminal(from)) return "reopen";
  return isForward(from, to) ? undefined : "back";
}

/** from から to へ前へ進むときに越える境目（飛ばす動きは間の境目をすべて）。前へ進まなければ空 */
export function crossedBoundaries(wf: ResolvedWorkflow, from: Status, to: Status): Boundary[] {
  if (!isForward(from, to)) return [];
  return wf.boundaries.filter(
    (b) => (b.from === from || isForward(from, b.from)) && (b.to === to || isForward(b.to, to)),
  );
}

/** 境目の並びを 1 つの方針にまとめる。条件は和（AND）、権限の値は並べて厳しいほうを効かせる */
export function boundaryPolicy(boundaries: readonly Boundary[]): OperationPolicy {
  return {
    source: "boundaries",
    name: `boundaries ${boundaries.map((b) => `${b.from} → ${b.to}`).join(", ")}`,
    decisions: boundaries.map((b) => b.decide),
    requires: [...new Set(boundaries.flatMap((b) => b.requires))],
  };
}

/**
 * チケットに当てる越える条件。ブランチなしで着手したチケット（claim --without-branch。in_progress・review で branch の記録がない）には、
 * ブランチと PR の事実の条件を当てない。PR の要らない作業ではどれも満たせず、既定の review → done（pr_merged）を
 * 人の強制なしに越えられなくなるため（ST-10）。着手していない todo には当てたままにする（着手を飛ばす誤操作を止める）
 */
export function requiresForTicket(
  requires: readonly Condition[],
  ticket: { status: Status; branch?: string | undefined },
): readonly Condition[] {
  const startedWithoutBranch =
    !ticket.branch && (ticket.status === "in_progress" || ticket.status === "review");
  if (!startedWithoutBranch) return requires;
  return requires.filter((c) => c.replace(/^!/, "") === "deps_done");
}

/** Core に固定の操作。Workflow を読まないので、workflow.yaml の値では変わらない */
export function coreFixedPolicy(op: Operation): OperationPolicy | undefined {
  if (!op.fixed) return undefined;
  return {
    source: "core",
    name: `fixed in Core, ${op.fixed}`,
    decisions: [CORE_FIXED[op.fixed]],
    requires: [],
  };
}

function flowPolicy(wf: ResolvedWorkflow, op: Operation): OperationPolicy | undefined {
  if (!op.stage) return undefined;
  return {
    source: "flow",
    name: `flow.${op.stage}`,
    decisions: [wf.flow.stages[op.stage]],
    requires: [],
  };
}

function governancePolicy(wf: ResolvedWorkflow, op: Operation): OperationPolicy | undefined {
  if (!op.governs) return undefined;
  return {
    source: "governance",
    name: `governance.${op.governs}`,
    decisions: [wf.governance[op.governs]],
    requires: [],
  };
}

function exceptionPolicy(wf: ResolvedWorkflow, op: Operation): OperationPolicy | undefined {
  const move = op.move && exceptionMoveOf(op.move.from, op.move.to);
  if (!move) return undefined;
  return {
    source: "exceptions",
    name: `exceptions.${move}`,
    decisions: [wf.exceptions[move]],
    requires: [],
  };
}

function crossingPolicy(wf: ResolvedWorkflow, op: Operation): OperationPolicy | undefined {
  const crossed = op.move ? crossedBoundaries(wf, op.move.from, op.move.to) : [];
  return crossed.length > 0 ? boundaryPolicy(crossed) : undefined;
}

/** どれにも当たらない操作（題や本文の編集など）は誰でもできる */
const ANYONE_POLICY: OperationPolicy = {
  source: "none",
  name: "none",
  decisions: ["anyone"],
  requires: [],
};

/**
 * 書き込みの操作に当てる方針を引く。Core の固定 → exceptions → boundaries → flow → governance の順に見て、
 * 最初に当てはまったものを使う。どれにも当たらなければ誰でもできる
 */
export function operationPolicy(wf: ResolvedWorkflow, op: Operation): OperationPolicy {
  return (
    coreFixedPolicy(op) ??
    exceptionPolicy(wf, op) ??
    crossingPolicy(wf, op) ??
    flowPolicy(wf, op) ??
    governancePolicy(wf, op) ??
    ANYONE_POLICY
  );
}

/** Status の動き 1 つと、人とエージェントに当てた権限（dg workflow show の moves。画面と ask が行き先を絞る） */
export interface MovePermission {
  from: Status;
  to: Status;
  /** 当てはまった方針の名前（OperationPolicy の name） */
  policy: string;
  /** 越える条件。事実は操作のときに調べるので、ここでは満たすかを見ない */
  requires: readonly Condition[];
  human: Permission;
  agent: Permission;
}

/** from と to が違うすべての動きの権限（STATUSES の順） */
export function movePermissions(wf: ResolvedWorkflow): MovePermission[] {
  return STATUSES.flatMap((from) =>
    STATUSES.filter((to) => to !== from).map((to) => {
      const policy = operationPolicy(wf, { command: "ticket.move", move: { from, to } });
      return {
        from,
        to,
        policy: policy.name,
        requires: policy.requires,
        human: judgeDecisions(policy.decisions, "human"),
        agent: judgeDecisions(policy.decisions, "agent"),
      };
    }),
  );
}
