// 組み込みの事実と条件の評価（WF-2、ST-5）と、権限の 5 つの値の判定（WF-1、ADR-003）。
// 事実は true / false / 不明（undefined）の 3 値。不明は否定でも偽と読む（前進の判定で安全側に倒す）

import {
  FACT_NAMES,
  type Actor,
  type Condition,
  type Decision,
  type FactName,
} from "../model/workflow.js";

export type Facts = Partial<Record<FactName, boolean>>;

const factNameSet: ReadonlySet<string> = new Set(FACT_NAMES);

function isFactName(name: string): name is FactName {
  return factNameSet.has(name);
}

/** 文字列を条件として読む。未知の事実なら undefined */
export function parseCondition(text: string): Condition | undefined {
  const negated = text.startsWith("!");
  const name = negated ? text.slice(1) : text;
  if (!isFactName(name)) return undefined;
  return text as Condition;
}

function conditionFact(condition: Condition): { name: FactName; negated: boolean } {
  const negated = condition.startsWith("!");
  return { name: (negated ? condition.slice(1) : condition) as FactName, negated };
}

/** 1 つの条件を評価する。事実が不明なら否定でも false */
export function evaluateCondition(condition: Condition, facts: Facts): boolean {
  const { name, negated } = conditionFact(condition);
  const value = facts[name];
  if (value === undefined) return false;
  return negated ? !value : value;
}

/** すべての条件を評価し、満たさなかった条件を返す */
export function evaluateAll(
  conditions: readonly Condition[],
  facts: Facts,
): { ok: boolean; unmet: Condition[] } {
  const unmet = conditions.filter((c) => !evaluateCondition(c, facts));
  return { ok: unmet.length === 0, unmet };
}

/**
 * 権限の値を主体に当てた結果。allow は聞かずにできる、approval は人の承認（--approved-by）があればできる、
 * override は人が理由を付けた強制（--override）のときだけできる、reject はできない
 */
export type Permission = "allow" | "approval" | "override" | "reject";

/** 人の側の表。agent_only だけが人の誤操作を止める */
const HUMAN_PERMISSION: Record<Decision, Permission> = {
  human_only: "allow",
  always_ask: "allow",
  ask_unless_auto: "allow",
  anyone: "allow",
  agent_only: "override",
};

/** エージェントの側の表（聞かずに進める流れでないとき） */
const AGENT_PERMISSION: Record<Decision, Permission> = {
  human_only: "reject",
  always_ask: "approval",
  ask_unless_auto: "approval",
  anyone: "allow",
  agent_only: "allow",
};

/**
 * 権限の値を主体に当てる。照合（reconcile）はエージェントと同じ側に数える。
 * auto は聞かずに進める流れのとき（ask_unless_auto だけが変わり、聞かずにできる）
 */
export function judgeDecision(decision: Decision, actor: Actor, auto = false): Permission {
  if (actor === "human") return HUMAN_PERMISSION[decision];
  if (auto && decision === "ask_unless_auto") return "allow";
  return AGENT_PERMISSION[decision];
}

const PERMISSION_RANK: Record<Permission, number> = {
  allow: 0,
  approval: 1,
  override: 2,
  reject: 3,
};

/** いくつかの値を同じ主体に当て、厳しいほうの結果を返す（境目を飛ばす動き。値がなければ allow） */
export function judgeDecisions(
  decisions: readonly Decision[],
  actor: Actor,
  auto = false,
): Permission {
  let worst: Permission = "allow";
  for (const d of decisions) {
    const p = judgeDecision(d, actor, auto);
    if (PERMISSION_RANK[p] > PERMISSION_RANK[worst]) worst = p;
  }
  return worst;
}
