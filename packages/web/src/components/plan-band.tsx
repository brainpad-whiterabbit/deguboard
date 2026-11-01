// カンバンの上の「実行計画」の帯。表示だけで書き込まない。畳めば Plan ごとに 1 行、開けば Plan ごとに依存グラフを出す

import { useMemo, useState } from "react";
import { useUiState } from "../host.js";
import { useStore } from "../store.js";
import { actorLabel, type PlanRow, type Ticket } from "../types.js";
import { ProgressBar, StatusDot, TicketLink } from "./parts.js";
import {
  PLAN_STATE_LABELS,
  planColor,
  planGraph,
  plansInScope,
  type GraphNode,
  type PlanState,
} from "./plan-graph.js";

/** scope（カンバンで選んだ Iteration のチケット）を含む Plan の帯。Plan がなければ出さない */
export function PlanBand({ scope }: { scope: readonly Ticket[] }) {
  const store = useStore();
  const [expanded, setExpanded] = useUiState("board.plansExpanded", false);
  const byId = useMemo(() => new Map(store.tickets.map((t) => [t.id, t])), [store.tickets]);
  const items = useMemo(() => plansInScope(store.plans, scope, byId), [store.plans, scope, byId]);
  if (items.length === 0) return null;
  const open = items.filter((i) => i.state !== "closed");
  const closed = items.filter((i) => i.state === "closed");
  const Item = expanded ? PlanCard : PlanLine;
  return (
    <section className="plan-band" aria-label="実行計画">
      <button
        type="button"
        className="plan-band-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        実行計画 <span className="muted">{open.length}</span>
      </button>
      {open.map(({ plan, state }) => (
        <Item key={plan.id} plan={plan} state={state} byId={byId} />
      ))}
      {closed.length > 0 ? (
        <details className="fold plan-closed">
          <summary>
            閉じた計画 <span className="muted">{closed.length}</span>
          </summary>
          {closed.map(({ plan, state }) => (
            <Item key={plan.id} plan={plan} state={state} byId={byId} />
          ))}
        </details>
      ) : null}
    </section>
  );
}

interface ItemProps {
  plan: PlanRow;
  state: PlanState;
  byId: ReadonlyMap<string, Ticket>;
}

/** 畳んだときの 1 行：色の線・ID・状態・進捗 */
function PlanLine({ plan, state }: ItemProps) {
  return (
    <div className={`plan-line plan-color-${planColor(plan.id)}`}>
      <code>{plan.id}</code>
      <span className={`plan-state plan-state-${state}`}>{PLAN_STATE_LABELS[state]}</span>
      <ProgressBar progress={plan.progress} />
    </div>
  );
}

/** 開いたときのカード：1 行目に ID・状態・承認者・進捗、その下に依存グラフ */
function PlanCard({ plan, state, byId }: ItemProps) {
  return (
    <article className={`plan-card plan-color-${planColor(plan.id)}`}>
      <div className="plan-card-head">
        <code>{plan.id}</code>
        <span className={`plan-state plan-state-${state}`}>{PLAN_STATE_LABELS[state]}</span>
        {plan.approved_by ? (
          <span className="muted" title={plan.approved_by}>
            承認 {actorLabel(plan.approved_by)}
          </span>
        ) : null}
        <ProgressBar progress={plan.progress} />
      </div>
      <PlanGraphView plan={plan} byId={byId} />
    </article>
  );
}

const NODE_W = 76;
const NODE_H = 22;
const COL_GAP = 32;
const ROW_GAP = 6;

const xOf = (n: GraphNode) => n.layer * (NODE_W + COL_GAP);
const yOf = (n: GraphNode) => n.row * (NODE_H + ROW_GAP);

/**
 * 依存グラフ。段を左から右に並べ、段の中は Plan の順。辺は SVG で描き、ノードはチケットへのリンクを上に重ねる。
 * 待ち終わった辺は実線、待ち中は破線。ノードにホバー・フォーカスすると繋がるノードと辺を強調する
 */
function PlanGraphView({ plan, byId }: { plan: PlanRow; byId: ReadonlyMap<string, Ticket> }) {
  const graph = useMemo(() => planGraph(plan, byId), [plan, byId]);
  const [focus, setFocus] = useState<string | null>(null);
  if (graph.nodes.length === 0) return <p className="empty">チケットはない</p>;
  const at = new Map(graph.nodes.map((n) => [n.id, n]));
  const related = new Set<string>();
  if (focus) {
    related.add(focus);
    for (const e of graph.edges) {
      if (e.from === focus) related.add(e.to);
      if (e.to === focus) related.add(e.from);
    }
  }
  const width = graph.layers * NODE_W + (graph.layers - 1) * COL_GAP;
  const height = graph.rows * NODE_H + (graph.rows - 1) * ROW_GAP;
  const arrow = `plan-arrow-${plan.id}`;
  return (
    <div className={`plan-graph${focus ? " plan-graph-tracing" : ""}`}>
      <div className="plan-graph-canvas" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker
              id={arrow}
              viewBox="0 0 6 6"
              refX="6"
              refY="3"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 z" className="plan-graph-arrow" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const a = at.get(e.from)!;
            const b = at.get(e.to)!;
            const x1 = xOf(a) + NODE_W;
            const y1 = yOf(a) + NODE_H / 2;
            const x2 = xOf(b);
            const y2 = yOf(b) + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const lit = focus !== null && (e.from === focus || e.to === focus);
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                className={`plan-graph-edge${e.done ? "" : " plan-graph-edge-pending"}${lit ? " related" : ""}`}
                markerEnd={`url(#${arrow})`}
              />
            );
          })}
        </svg>
        {graph.nodes.map((n) => (
          <TicketLink
            key={n.id}
            id={n.id}
            className={`plan-node status-${n.status}${n.waiting ? " plan-node-waiting" : ""}${related.has(n.id) ? " related" : ""}`}
            style={{ left: xOf(n), top: yOf(n), width: NODE_W, height: NODE_H }}
            onMouseEnter={() => setFocus(n.id)}
            onMouseLeave={() => setFocus(null)}
            onFocus={() => setFocus(n.id)}
            onBlur={() => setFocus(null)}
          >
            <StatusDot status={n.status} />
            <code title={byId.get(n.id)?.title}>{n.id}</code>
          </TicketLink>
        ))}
      </div>
      {graph.edges.length > 0 ? (
        <div className="plan-graph-legend muted">
          <span>
            <svg width="20" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="20" y2="3" className="plan-graph-edge" />
            </svg>
            待ち終わり
          </span>
          <span>
            <svg width="20" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="20"
                y2="3"
                className="plan-graph-edge plan-graph-edge-pending"
              />
            </svg>
            待ち中
          </span>
        </div>
      ) : null}
    </div>
  );
}
