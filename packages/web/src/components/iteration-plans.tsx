// Iteration 詳細の「Plan」の節（UI-5）。中のチケットを含む Plan の抽出と状態・進捗は core（iteration.show の plans）が求めるので、ここは出すだけ。
// 該当する Plan がなければ節を出さない。書き込まない

import { PLAN_STATE_LABELS } from "./plan-graph.js";
import type { IterationDetail } from "../types.js";

export function IterationPlans({ plans }: { plans: IterationDetail["plans"] }) {
  if (plans.length === 0) return null;
  return (
    <section className="iteration-plans" aria-label="Plan">
      <h2>Plan</h2>
      <ul>
        {plans.map((p) => (
          <li key={p.id}>
            <code>{p.id}</code>
            <span className="plan-state">{PLAN_STATE_LABELS[p.status]}</span>
            <span className="iteration-plan-count">
              {p.progress.done}/{p.progress.total} done
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
