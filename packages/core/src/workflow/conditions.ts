// 組み込みの事実と条件の評価（WF-2、ST-5）。
// 事実は true / false / 不明（undefined）の 3 値。不明は否定でも偽と読む（前進の判定で安全側に倒す）

import { FACT_NAMES, type Condition, type FactName } from "../model/workflow.js";

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
