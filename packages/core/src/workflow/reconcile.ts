// 照合（ST-4・ST-5）。Git の事実から次の Status を導く純粋関数

import { isForward, isTerminal, type Status } from "../model/common.js";
import { evaluateAll, type Facts } from "./conditions.js";
import type { ReconcileRule, ResolvedWorkflow } from "./resolve.js";

export type ReconcileOutcome =
  /** 前進する */
  | { kind: "advance"; to: Status; rule: ReconcileRule }
  /** 当てはまる規則がない、または今と同じか手前を指す（書き換えない） */
  | { kind: "none" }
  /** done・abandoned には触れない */
  | { kind: "terminal" };

/**
 * 規則を上から評価し、最初に当てはまった規則で判定する。
 * 規則は進んだ状態から順に並ぶ前提なので、当てはまった規則が前進でなければそこで止める。
 * 境目の requires・decide はまだ見ない（今は手で越える操作とコマンドだけが判定する。workflow/resolve.ts の operationPolicy）。
 * 照合も requires を満たすときだけ進めるようにするのは t1031 が持つ（既定の branch_merged → done を
 * requires: [pr_merged] が止めないよう、照合の規則と一緒に決める）
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
    return { kind: "advance", to: rule.status, rule };
  }
  return { kind: "none" };
}

/** 後退を指す事実（消えたブランチ・閉じた PR）。書き換えずに警告する（ST-5） */
export function regressionWarnings(
  current: Status,
  facts: Facts,
  opts: { prMissing?: boolean | undefined } = {},
): string[] {
  if (isTerminal(current)) return [];
  const warnings: string[] = [];
  if (facts.branch_exists === false)
    warnings.push("The work branch was not found locally or on the remote");
  // PR がまだないだけなら閉じた PR ではない（gh は両方を pr_* がすべて偽の形で返す）
  if (
    !opts.prMissing &&
    facts.pr_open === false &&
    facts.pr_merged === false &&
    current === "review"
  ) {
    warnings.push("The PR was closed without being merged");
  }
  return warnings;
}
