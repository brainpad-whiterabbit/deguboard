import { useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { useHost, useUiState } from "../host.js";
import { useStore } from "../store.js";
import { actorLabel, type PlanRow, type Ticket, type TicketRow } from "../types.js";
import { ASK_SECTIONS, useAskSpot } from "./ask-menu.js";
import { DetailLink, ProgressBar, StatusDot, TicketLink } from "./parts.js";
import {
  PLAN_STATE_LABELS,
  planColor,
  planGraph,
  planProgressLine,
  plansInScope,
  type GraphNode,
  type BandNext,
  type PlanState,
} from "./plan-graph.js";
import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 前の版の帯全体の開閉の鍵。使わなくなったので消す */
const OLD_KEYS = ["board.plansExpanded"];

/** scope（カンバンで選んだ Iteration のチケット）を含む Plan の帯。Plan がなければ出さない */
export function PlanBand({ scope }: { scope: readonly Ticket[] }) {
  const store = useStore();
  const host = useHost();
  const [closedOpen, setClosedOpen] = useUiState("board.plansClosed", false);
  useEffect(() => {
    for (const key of OLD_KEYS) host.state.remove(key);
  }, [host]);
  const byId = useMemo(() => new Map(store.tickets.map((t) => [t.id, t])), [store.tickets]);
  const items = useMemo(() => plansInScope(store.plans, scope), [store.plans, scope]);
  if (items.length === 0) return null;
  const open = items.filter((i) => i.state !== "closed");
  const closed = items.filter((i) => i.state === "closed");
  return (
    <section className="plan-band" aria-label={tr("実行計画")}>
      <h2 className="plan-band-head">
        {trNode("実行計画 {0}", <span className="plan-band-count">{open.length}</span>)}
      </h2>
      {open.map(({ plan, state }) => (
        <PlanItem key={plan.id} plan={plan} state={state} byId={byId} />
      ))}
      {closed.length > 0 ? (
        <details
          className="fold plan-closed"
          open={closedOpen}
          onToggle={(e) => setClosedOpen(e.currentTarget.open)}
        >
          <summary>
            {trNode("閉じた計画 {0}", <span className="muted">{closed.length}</span>)}
          </summary>
          {closed.map(({ plan, state }) => (
            <PlanItem key={plan.id} plan={plan} state={state} byId={byId} />
          ))}
        </details>
      ) : null}
    </section>
  );
}

interface ItemProps {
  plan: PlanRow;
  state: PlanState;
  byId: ReadonlyMap<string, TicketRow>;
}

/**
 * Plan の行：1 行目に色の線・開閉の印・番号・状態・進み、2 行目に作業中と次（閉じた Plan は 1 行目だけ）。
 * 行を押すと下に依存グラフを開閉する。Plan の番号（リンク）を押したときは Plan 詳細を、チケットの番号を押したときはチケットを開き、開閉しない。
 * 開閉のボタンは開閉の印だけを持つ（リンクをボタンの中に入れられないので）。
 * 開いた Plan だけを見た目の状態に覚え、閉じたら鍵を消す（閉じた Plan の鍵が溜まらないよう）
 */
function PlanItem({ plan, state, byId }: ItemProps) {
  const host = useHost();
  const key = `board.planGraph.${plan.id}`;
  const [open, setOpen] = useState(() => host.state.get<boolean>(key) === true);
  const detailId = useId();
  const closed = state === "closed";
  // 左パネルでは Plan の行をエージェントに頼める場所にする（吹き出し・Shift+F10。UI-15）
  const spot = useAskSpot(
    host.surface === "sidebar"
      ? {
          targets: [plan.id],
          label: tr("Plan の帯 {0}", plan.id),
          section: ASK_SECTIONS.boardHeading,
        }
      : null,
  );
  const onRowClick = (e: MouseEvent) => {
    if ((e.target as Element).closest("a")) return;
    setOpen(!open);
    if (open) host.state.remove(key);
    else host.state.set(key, true);
  };
  return (
    <div
      className={`plan-item plan-color-${planColor(plan.id)}${closed ? " plan-item-closed" : ""}`}
    >
      <div className="plan-row" onClick={onRowClick} {...(spot.overlay ? spot.props : {})}>
        <div className="plan-line">
          <button
            type="button"
            className="plan-toggle"
            aria-label={tr("{0} の依存グラフ", plan.id)}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
          />
          <DetailLink
            route={{ page: "plans", id: plan.id }}
            className="plan-id"
            title={tr("{0} の詳細を開く", plan.id)}
          >
            <code>{plan.id}</code>
          </DetailLink>
          <span className={`plan-state plan-state-${state}`}>{tr(PLAN_STATE_LABELS[state])}</span>
          <ProgressBar progress={plan.progress} short />
        </div>
        {closed ? null : <PlanSub plan={plan} state={state} byId={byId} />}
        {spot.overlay}
      </div>
      {open ? (
        <div className="plan-detail" id={detailId}>
          {plan.approved_by ? (
            <span className="plan-approver muted" title={plan.approved_by}>
              {trNode("承認 {0}", actorLabel(plan.approved_by))}
            </span>
          ) : null}
          <PlanGraphView plan={plan} byId={byId} />
        </div>
      ) : null}
    </div>
  );
}

/** 2 行目：作業中の番号と、次に着手するチケット（待ちがあれば「t3 待ち」）。承認待ちは承認を待っていること。出すものがなければ出さない */
function PlanSub({ plan, state, byId }: ItemProps) {
  const { working, next } = planProgressLine(plan, state, byId);
  if (working.length === 0 && !next) return null;
  return (
    <div className="plan-sub">
      {working.length > 0 ? (
        <span className="plan-working">
          <span className="plan-sub-label">{tr("作業中")}</span>
          <Ids ids={working} byId={byId} />
        </span>
      ) : null}
      {next ? <BandNextText next={next} byId={byId} /> : null}
    </div>
  );
}

function Ids({ ids, byId }: { ids: readonly string[]; byId: ReadonlyMap<string, Ticket> }) {
  return (
    <span className="plan-sub-ids">
      {ids.map((id) => (
        <TicketLink key={id} id={id}>
          <code title={byId.get(id)?.title}>{id}</code>
        </TicketLink>
      ))}
    </span>
  );
}

function BandNextText({ next, byId }: { next: BandNext; byId: ReadonlyMap<string, Ticket> }) {
  if (next.kind === "approval") {
    return <span className="plan-next muted">{tr("人の承認を待っている")}</span>;
  }
  const title = byId.get(next.id)?.title ?? "";
  return (
    <span className="plan-next">
      <span className="plan-sub-label">{tr("次")}</span>
      <TicketLink
        id={next.id}
        className={`plan-next-ticket${next.kind === "ready" ? " plan-next-ready" : ""}`}
      >
        <code title={title}>{next.id}</code>
        {next.kind === "ready" ? (
          <span className="plan-next-title" title={title}>
            {title}
          </span>
        ) : null}
      </TicketLink>
      {next.kind === "blocked" ? (
        <span className="plan-wait">
          <Ids ids={next.waitFor} byId={byId} />
          <span>{tr("待ち")}</span>
        </span>
      ) : null}
    </span>
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
 * 待ち終わった辺は実線、待ち中は破線。depends_on の辺は点線（待ち中は間を空けた太い点）で after と見分ける。ノードにホバー・フォーカスすると繋がるノードと辺を強調する
 */
export function PlanGraphView({
  plan,
  byId,
}: {
  plan: PlanRow;
  byId: ReadonlyMap<string, Ticket>;
}) {
  const host = useHost();
  const graph = useMemo(() => planGraph(plan, byId), [plan, byId]);
  const [focus, setFocus] = useState<string | null>(null);
  if (graph.nodes.length === 0) return <p className="empty">{tr("チケットはない")}</p>;
  if (host.surface === "sidebar" && graph.edges.length === 0) {
    return <PlanChips nodes={graph.nodes} byId={byId} />;
  }
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
  const hasDepends = graph.edges.some((e) => e.kind === "depends_on");
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
              markerUnits="userSpaceOnUse"
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
                className={`plan-graph-edge${e.done ? "" : " plan-graph-edge-pending"}${e.kind === "depends_on" ? " plan-graph-edge-depends" : ""}${lit ? " related" : ""}`}
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
            {trNode(
              "{0}{1}待ち終わり",
              <svg width="20" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="20" y2="3" className="plan-graph-edge" />
              </svg>,
              hasDepends ? "after " : "",
            )}
          </span>
          <span>
            {trNode(
              "{0}{1}待ち中",
              <svg width="20" height="6" aria-hidden="true">
                <line
                  x1="0"
                  y1="3"
                  x2="20"
                  y2="3"
                  className="plan-graph-edge plan-graph-edge-pending"
                />
              </svg>,
              hasDepends ? "after " : "",
            )}
          </span>
          {hasDepends
            ? [
                { label: tr("depends_on 待ち終わり"), cls: "" },
                { label: tr("depends_on 待ち中"), cls: " plan-graph-edge-pending" },
              ].map(({ label, cls }) => (
                <span key={label}>
                  <svg width="20" height="6" aria-hidden="true">
                    <line
                      x1="0"
                      y1="3"
                      x2="20"
                      y2="3"
                      className={`plan-graph-edge plan-graph-edge-depends${cls}`}
                    />
                  </svg>
                  {label}
                </span>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

/** 待ちの辺のない Plan のチケット（サイドバー）。Plan の順に、状態の丸印・番号・タイトルの頭のチップを横に折り返す。全文はツールチップ */
function PlanChips({
  nodes,
  byId,
}: {
  nodes: readonly GraphNode[];
  byId: ReadonlyMap<string, Ticket>;
}) {
  const ordered = [...nodes].sort((a, b) => a.layer - b.layer || a.row - b.row);
  return (
    <div className="plan-chips">
      {ordered.map((n) => {
        const title = byId.get(n.id)?.title;
        return (
          <TicketLink key={n.id} id={n.id} className={`plan-chip status-${n.status}`}>
            <StatusDot status={n.status} />
            <code>{n.id}</code>
            {title ? (
              <span className="plan-chip-title" title={title}>
                {title}
              </span>
            ) : null}
          </TicketLink>
        );
      })}
    </div>
  );
}
