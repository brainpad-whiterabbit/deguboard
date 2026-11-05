import { DetailLink } from "./parts.js";
import { PLAN_STATE_LABELS } from "./plan-graph.js";
import type { IterationDetail } from "../types.js";
import { tr } from "../l10n.js";

export function IterationPlans({ plans }: { plans: IterationDetail["plans"] }) {
  if (plans.length === 0) return null;
  return (
    <section className="iteration-plans" aria-label="Plan">
      <h2>Plan</h2>
      <ul>
        {plans.map((p) => (
          <li key={p.id}>
            <DetailLink route={{ page: "plans", id: p.id }} title={tr("{0} の詳細を開く", p.id)}>
              <code>{p.id}</code>
            </DetailLink>
            <span className="plan-state">{tr(PLAN_STATE_LABELS[p.status])}</span>
            <span className="iteration-plan-count">
              {p.progress.done}/{p.progress.total} done
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
