// 照合（ST-4・ST-5、ADR-003）。Git の事実から次の Status を導く純粋関数。
// きっかけ（どの事実で進めるか）は Core の固定で、進めてよいかは越える境目の requires と decide で判定する

import { isForward, isTerminal, type Status } from "../model/common.js";
import type { Condition } from "../model/workflow.js";
import { evaluateAll, judgeDecisions, type Facts } from "./conditions.js";
import { boundaryPolicy, crossedBoundaries, type ResolvedWorkflow } from "./resolve.js";

/** 照合のきっかけ：when の事実がすべて真なら、チケットを status へ進めようとする */
export interface ReconcileTrigger {
  when: readonly Condition[];
  status: Status;
}

/**
 * 照合のきっかけ。workflow.yaml には書けない。進んだ状態から順に並べ、上から見て最初に当てはまったものを使う。
 * PR の事実は gh があるときだけ取れ、PR を使わない進め方ではいつも偽なので、ブランチの事実（branch_merged）で done になる。
 * squash マージは祖先判定で取れないので PR のマージを先に見る
 */
export const RECONCILE_TRIGGERS: readonly ReconcileTrigger[] = [
  { when: ["pr_merged"], status: "done" },
  { when: ["branch_merged"], status: "done" },
  { when: ["pr_open", "!pr_draft"], status: "review" },
  { when: ["branch_exists"], status: "in_progress" },
];

export type ReconcileOutcome =
  /** 前進する */
  | { kind: "advance"; to: Status; trigger: ReconcileTrigger }
  /**
   * きっかけは当てはまったが、越える境目の方針が止めた（書き換えない）。policy は方針の名前、
   * unmet は満たさなかった requires、humanOnly は decide がエージェントの側を拒む値（human_only）だったか
   */
  | {
      kind: "blocked";
      to: Status;
      trigger: ReconcileTrigger;
      policy: string;
      unmet: Condition[];
      humanOnly: boolean;
    }
  /** 当てはまるきっかけがない、または今と同じか手前を指す（書き換えない） */
  | { kind: "none" }
  /** done・abandoned には触れない */
  | { kind: "terminal" };

/**
 * 照合で当てる越える条件。PR のないチケット（番号の記録がなく、ブランチ名でも見つからない）には PR の事実（pr_*）の条件を当てない。
 * PR を使わない進め方では PR の事実がいつも偽で、既定の review → done（requires: [pr_merged]）のままでは
 * ブランチのマージで done に進めなくなるため。手で越える操作には当てたままにする（workflow/resolve.ts の requiresForTicket）。
 * PR の番号があっても PR の事実を読めなかった（gh がない・失敗した。pr_* がどれも不明）チケットは、PR のないチケットと同じに扱う。
 * 不明を偽と読むと、gh のないマシンでマージ済みのブランチが done に進まず、照合が Git の事実だけで成り立たなくなるため（ST-6）。
 * 読めた PR がマージ済みでないなら、条件を当てて止める
 */
function requiresForReconcile(
  requires: readonly Condition[],
  pr: number | undefined,
  facts: Facts,
): readonly Condition[] {
  const prFactsRead =
    facts.pr_open !== undefined || facts.pr_draft !== undefined || facts.pr_merged !== undefined;
  if (pr !== undefined && prFactsRead) return requires;
  return requires.filter((c) => !c.replace(/^!/, "").startsWith("pr_"));
}

/**
 * きっかけを上から評価し、最初に当てはまったもので判定する。当てはまったきっかけが前進でなければそこで止める。
 * 前進なら、越える境目（飛ばす動きは間の境目をすべて）の requires と decide を、エージェントの側として判定する：
 *   - requires を満たさなければ進めない
 *   - decide がエージェントを拒む値（human_only）なら進めない。人の承認を求める値（always_ask・ask_unless_auto）は止めない。
 *     照合は聞けず、その判断は事実を作る操作（pr ready・pr merge）が decide で済ませているため
 * opts.pr はチケットの PR の番号（記録したものか、照合が見つけたもの）
 */
export function reconcileStatus(
  wf: ResolvedWorkflow,
  current: Status,
  facts: Facts,
  opts: { pr?: number | undefined } = {},
): ReconcileOutcome {
  if (isTerminal(current)) return { kind: "terminal" };
  for (const trigger of RECONCILE_TRIGGERS) {
    if (!evaluateAll(trigger.when, facts).ok) continue;
    if (!isForward(current, trigger.status)) return { kind: "none" };
    const policy = boundaryPolicy(crossedBoundaries(wf, current, trigger.status));
    const { unmet } = evaluateAll(requiresForReconcile(policy.requires, opts.pr, facts), facts);
    const humanOnly = judgeDecisions(policy.decisions, "reconcile") === "reject";
    if (unmet.length > 0 || humanOnly)
      return {
        kind: "blocked",
        to: trigger.status,
        trigger,
        policy: policy.name,
        unmet,
        humanOnly,
      };
    return { kind: "advance", to: trigger.status, trigger };
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
