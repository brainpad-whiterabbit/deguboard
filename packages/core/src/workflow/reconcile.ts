// 照合（ST-4・ST-5）。Git の事実から次の Status を導く純粋関数

import { isForward, isTerminal, type Status } from "../model/common.js";
import { evaluateAll, type Facts } from "./conditions.js";
import {
  canTransition,
  type ReconcileRule,
  type ResolvedWorkflow,
  type TransitionCheck,
} from "./resolve.js";

export type ReconcileOutcome =
  /** 前進する */
  | { kind: "advance"; to: Status; rule: ReconcileRule }
  /** 前進を指すが Workflow の transitions が reconcile に許していない。書かずに警告 */
  | { kind: "blocked"; to: Status; rule: ReconcileRule; check: TransitionCheck }
  /** 当てはまる規則がない、または今と同じか手前を指す（書き換えない） */
  | { kind: "none" }
  /** done・abandoned には触れない */
  | { kind: "terminal" };

/**
 * 規則を上から評価し、最初に当てはまった規則で判定する。
 * 規則は進んだ状態から順に並ぶ前提なので、当てはまった規則が前進でなければそこで止める
 */
export function reconcileStatus(
  wf: ResolvedWorkflow,
  current: Status,
  facts: Facts,
): ReconcileOutcome {
  if (isTerminal(current)) return { kind: "terminal" };
  for (const rule of wf.reconcile) {
    if (!evaluateAll(rule.when, facts).ok) continue;
    if (!isForward(current, rule.status)) return { kind: "none" };
    const check = canTransition(wf, current, rule.status, "reconcile", facts);
    if (!check.ok) return { kind: "blocked", to: rule.status, rule, check };
    return { kind: "advance", to: rule.status, rule };
  }
  return { kind: "none" };
}

/** 後退を指す事実（消えたブランチ・閉じた PR）。書き換えずに警告する（ST-5） */
export function regressionWarnings(current: Status, facts: Facts): string[] {
  if (isTerminal(current)) return [];
  const warnings: string[] = [];
  if (facts.branch_exists === false)
    warnings.push("作業ブランチがローカルにもリモートにも見つからない");
  if (facts.pr_open === false && facts.pr_merged === false && current === "review") {
    warnings.push("PR がマージされずに閉じている");
  }
  return warnings;
}
