// 実行計画の帯が使う計算：Plan の状態・並び・範囲と、after から求める依存グラフの段。画面に依存しない純粋な関数だけを置く

import type { PlanRow, Status, Ticket, TicketRow } from "../types.js";

/** 帯に出す Plan の状態。core の status（pending・approved・closed）に、チケットの状態から求める進行中・完了を足す */
export type PlanState = "working" | "pending" | "approved" | "finished" | "closed";

export const PLAN_STATE_LABELS: Record<PlanState, string> = {
  working: "進行中",
  pending: "承認待ち",
  approved: "承認済み",
  finished: "完了",
  closed: "閉じた",
};

/** 帯の並び。手が動いているものを上に、終わったものを下に置く */
const STATE_ORDER: readonly PlanState[] = ["working", "pending", "approved", "finished", "closed"];

const FINISHED: ReadonlySet<Status> = new Set(["done", "abandoned"]);

function statusOf(id: string, byId: ReadonlyMap<string, Ticket>): Status | undefined {
  return byId.get(id)?.status;
}

/** 閉じた Plan は閉じた、すべて done・abandoned なら完了、承認待ちはそのまま、承認済みで in_progress・review があれば進行中 */
export function planState(plan: PlanRow, byId: ReadonlyMap<string, Ticket>): PlanState {
  if (plan.status === "closed") return "closed";
  const statuses = plan.tickets.flatMap((id) => statusOf(id, byId) ?? []);
  if (statuses.length > 0 && statuses.every((s) => FINISHED.has(s))) return "finished";
  if (plan.status === "pending") return "pending";
  return statuses.some((s) => s === "in_progress" || s === "review") ? "working" : "approved";
}

/** scope のチケットを 1 枚でも含む Plan を、状態の順（同じ状態は番号順のまま）に並べる */
export function plansInScope(
  plans: readonly PlanRow[],
  scope: readonly Ticket[],
  byId: ReadonlyMap<string, Ticket>,
): { plan: PlanRow; state: PlanState }[] {
  const ids = new Set(scope.map((t) => t.id));
  return plans
    .filter((p) => p.tickets.some((id) => ids.has(id)))
    .map((plan) => ({ plan, state: planState(plan, byId) }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
}

/** Plan の色の番号（p の番号を 5 色で回す） */
export function planColor(id: string): number {
  const n = Number(id.replace(/^\D+/, ""));
  return Number.isFinite(n) ? n % 5 : 0;
}

/** チケットが入っている開いた Plan の ID（PL-3 で高々 1 つ） */
export function openPlanByTicket(plans: readonly PlanRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of plans) {
    if (p.status === "closed") continue;
    for (const id of p.tickets) map.set(id, p.id);
  }
  return map;
}

export interface GraphNode {
  id: string;
  /** 段（左から 0）。待ちの最も長い列の深さ */
  layer: number;
  /** 段の中の位置（Plan の tickets の順） */
  row: number;
  status: Status;
  /** 待ちに done・abandoned でないものが残る */
  waiting: boolean;
  /** 残っている待ちの相手（after の順。waiting なら 1 件以上） */
  waitingOn: string[];
}

export interface GraphEdge {
  /** 待たれる側 */
  from: string;
  /** 待つ側 */
  to: string;
  /** 待たれる側が done・abandoned */
  done: boolean;
}

export interface PlanGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
  rows: number;
}

/**
 * after（Plan の中の待ち）から依存グラフを組む。消えたチケットと Plan の外への待ちは飛ばす。
 * 循環は plan.create が拒否するが、壊れたデータでも止まらないよう、たどっている途中の待ちは数えない
 */
export function planGraph(plan: PlanRow, byId: ReadonlyMap<string, Ticket>): PlanGraph {
  const ids = plan.tickets.filter((id) => byId.has(id));
  const inPlan = new Set<string>(ids);
  // after のキーは TicketId（t の番号）の型なので、文字列で引けるよう広げる
  const after: Record<string, readonly string[]> = plan.after;
  const waitsOf = (id: string) => (after[id] ?? []).filter((dep) => dep !== id && inPlan.has(dep));

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let d = 0;
    for (const dep of waitsOf(id)) {
      if (!visiting.has(dep)) d = Math.max(d, layerOf(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const counts: number[] = [];
  const nodes = ids.map((id): GraphNode => {
    const layer = layerOf(id);
    const row = counts[layer] ?? 0;
    counts[layer] = row + 1;
    const waitingOn = waitsOf(id).filter((dep) => !FINISHED.has(byId.get(dep)!.status));
    return {
      id,
      layer,
      row,
      status: byId.get(id)!.status,
      waiting: waitingOn.length > 0,
      waitingOn,
    };
  });
  const edges = ids.flatMap((to) =>
    waitsOf(to).map((from) => ({ from, to, done: FINISHED.has(byId.get(from)!.status) })),
  );
  return { nodes, edges, layers: counts.length, rows: Math.max(0, ...counts) };
}

/** 帯の行の「次」：着手できる先頭のチケット、待っている先頭の todo とその待ちの相手、承認待ちのどれか */
export type PlanNext =
  | { kind: "ready"; id: string }
  | { kind: "blocked"; id: string; waitFor: string[] }
  | { kind: "approval" };

export interface PlanProgressLine {
  /** in_progress のチケット（依存グラフの段・段の中の位置の順） */
  working: string[];
  /** 出すものがなければ null（終わった Plan、todo の残らない Plan） */
  next: PlanNext | null;
}

/**
 * チケットに残っている待ちの相手。空なら（todo のチケットは）着手できる。実行計画の帯の「次」とカンバンの行の「着手可・待ち」はこれで決める。
 * Plan の after の待ち（planGraph の waitingOn）を先に、depends_on の待ちを重ねずに後に並べる。depends_on が終わったかは core の deps_done（WF-2。別の Project の依存先も見る）で決め、
 * 偽のときだけ依存先を相手に出す：画面が読めている依存先に終わっていないものがあればそれだけ、なければ読めていない依存先（別の Project のものなど。どれかが終わっていないはず）、
 * それもなければ（読み直しの前など）依存先をそのまま出し、着手可とは出さない
 */
export function remainingWaits(
  ticket: TicketRow,
  waitingOn: readonly string[],
  byId: ReadonlyMap<string, Ticket>,
): string[] {
  if (ticket.deps_done) return [...waitingOn];
  const deps = ticket.depends_on;
  const open = deps.filter((dep) => {
    const status = statusOf(dep, byId);
    return status !== undefined && !FINISHED.has(status);
  });
  const unknown = deps.filter((dep) => !byId.has(dep));
  const chosen = open.length > 0 ? open : unknown.length > 0 ? unknown : deps;
  return [...waitingOn, ...chosen.filter((dep) => !waitingOn.includes(dep))];
}

/**
 * 帯の行に出す作業中と次。順は依存グラフの段・段の中の位置。選んだ Iteration の外のチケットも、Plan に入っていれば数える（Plan 全体の進み）。
 * 承認待ちは次の代わりに承認待ち。着手できるのは todo で、待ちの相手（remainingWaits）が残らないもの。なければ先頭の todo とその待ちの相手を出す。閉じた・完了の Plan は何も出さない
 */
export function planProgressLine(
  plan: PlanRow,
  state: PlanState,
  byId: ReadonlyMap<string, TicketRow>,
): PlanProgressLine {
  if (state === "closed" || state === "finished") return { working: [], next: null };
  const graph = planGraph(plan, byId);
  const ordered = [...graph.nodes].sort((a, b) => a.layer - b.layer || a.row - b.row);
  const working = ordered.filter((n) => n.status === "in_progress").map((n) => n.id);
  if (state === "pending") return { working, next: { kind: "approval" } };
  const waitsOf = (n: GraphNode) => remainingWaits(byId.get(n.id)!, n.waitingOn, byId);
  const todo = ordered.filter((n) => n.status === "todo");
  const ready = todo.find((n) => waitsOf(n).length === 0);
  if (ready) return { working, next: { kind: "ready", id: ready.id } };
  const first = todo[0];
  if (!first) return { working, next: null };
  return { working, next: { kind: "blocked", id: first.id, waitFor: waitsOf(first) } };
}
