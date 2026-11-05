// 実行計画の帯が使う計算：Plan の状態・並び・範囲と、after・depends_on から求める依存グラフの段。画面に依存しない純粋な関数だけを置く。
// 着手できるか・待ちの相手・次は core の plan.list（PL-6）が求めた値を読むだけで、ここでは求め直さない

import type { PlanDetail, PlanRow, Status, Ticket } from "../types.js";
import { msg } from "../l10n.js";

/** 帯に出す Plan の状態。core の status（pending・approved・closed）に、チケットの状態から求める進行中・完了を足す */
export type PlanState = "working" | "pending" | "approved" | "finished" | "closed";

export const PLAN_STATE_LABELS: Record<PlanState, string> = {
  working: msg("進行中"),
  pending: msg("承認待ち"),
  approved: msg("承認済み"),
  finished: msg("完了"),
  closed: msg("閉じた"),
};

/**
 * plan.show の出力（Plan 詳細）を plan.list の 1 行の形にする。状態は core と同じく closed_at と pending_approval から、
 * Plan 全体の待ちは items[].waiting から組む（求め直さず並べ替えるだけ）。帯と同じ部品（planState・planGraph・planProgressLine）に渡すため
 */
export function planRowOf(detail: PlanDetail): PlanRow {
  const waiting: Record<string, string[]> = {};
  for (const t of detail.items) if (t.waiting.length > 0) waiting[t.id] = t.waiting;
  const { items: _items, ...plan } = detail;
  return {
    ...plan,
    status:
      detail.closed_at !== undefined ? "closed" : detail.pending_approval ? "pending" : "approved",
    waiting: waiting as PlanRow["waiting"],
  };
}

/** 帯の並び。手が動いているものを上に、終わったものを下に置く */
const STATE_ORDER: readonly PlanState[] = ["working", "pending", "approved", "finished", "closed"];

/** 閉じた Plan は閉じた、Plan の progress で終わっていないチケットがなければ完了、承認待ちはそのまま、承認済みで in_progress・review があれば進行中 */
export function planState(plan: PlanRow): PlanState {
  if (plan.status === "closed") return "closed";
  const { todo, in_progress, review, done, abandoned } = plan.progress.by_status;
  if (todo + in_progress + review === 0 && done + abandoned > 0) return "finished";
  if (plan.status === "pending") return "pending";
  return in_progress + review > 0 ? "working" : "approved";
}

/** scope のチケットを 1 枚でも含む Plan を、状態の順（同じ状態は番号順のまま）に並べる */
export function plansInScope(
  plans: readonly PlanRow[],
  scope: readonly Ticket[],
): { plan: PlanRow; state: PlanState }[] {
  const ids = new Set(scope.map((t) => t.id));
  return plans
    .filter((p) => p.tickets.some((id) => ids.has(id)))
    .map((plan) => ({ plan, state: planState(plan) }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
}

/** Plan のチケットの残りの待ちの相手（core の plan.list の waiting。after が先、depends_on が後）。空なら（todo のチケットは）着手できる */
export function waitsOf(plan: PlanRow, id: string): string[] {
  // waiting のキーは TicketId（t の番号）の型なので、文字列で引けるよう広げる
  const waiting: Record<string, readonly string[] | undefined> = plan.waiting;
  return [...(waiting[id] ?? [])];
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
  /** 待ちの相手が残る（core の waiting。depends_on の待ちも含む） */
  waiting: boolean;
}

export interface GraphEdge {
  /** 待たれる側 */
  from: string;
  /** 待つ側 */
  to: string;
  /** 待ち終わった（待つ側の core の waiting に待たれる側がない） */
  done: boolean;
  /** 辺の由来。Plan の after か、チケットの depends_on だけ（同じ組に両方あれば after） */
  kind: "after" | "depends_on";
}

export interface PlanGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
  rows: number;
}

/**
 * after（Plan の中の待ち）と、Plan の中のチケット同士の depends_on から依存グラフを組む。段は両方から求める。消えたチケットと Plan の外への待ちは飛ばす。
 * 循環は plan.create（after だけと、after と depends_on をまたぐもの）と TK-2（depends_on だけ）が拒否する。
 * Plan を作った後の depends_on の書き換えでできたまたぐ循環は拒否されず、dg lint が指摘する。それや壊れたデータでも止まらないよう、たどっている途中の待ちは数えない
 */
export function planGraph(plan: PlanRow, byId: ReadonlyMap<string, Ticket>): PlanGraph {
  const ids = plan.tickets.filter((id) => byId.has(id));
  const inPlan = new Set<string>(ids);
  // after のキーは TicketId（t の番号）の型なので、文字列で引けるよう広げる
  const after: Record<string, readonly string[]> = plan.after;
  const afterOf = (id: string) => (after[id] ?? []).filter((dep) => dep !== id && inPlan.has(dep));
  // depends_on は after にない相手だけを足す（同じ組は after の辺 1 本にまとめる）
  const dependsOf = (id: string) => {
    const viaAfter = new Set(afterOf(id));
    return (byId.get(id)?.depends_on ?? []).filter(
      (dep) => dep !== id && inPlan.has(dep) && !viaAfter.has(dep),
    );
  };
  const waitsFor = (id: string) => [...afterOf(id), ...dependsOf(id)];

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let d = 0;
    for (const dep of waitsFor(id)) {
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
    return {
      id,
      layer,
      row,
      status: byId.get(id)!.status,
      waiting: waitsOf(plan, id).length > 0,
    };
  });
  const edges = ids.flatMap((to) => {
    const open = waitsOf(plan, to);
    const edge = (kind: GraphEdge["kind"]) => (from: string) => ({
      from,
      to,
      done: !open.includes(from),
      kind,
    });
    return [...afterOf(to).map(edge("after")), ...dependsOf(to).map(edge("depends_on"))];
  });
  return { nodes, edges, layers: counts.length, rows: Math.max(0, ...counts) };
}

/** 帯の行の「次」：着手できるチケット、待っている todo とその待ちの相手、承認待ちのどれか */
export type BandNext =
  | { kind: "ready"; id: string }
  | { kind: "blocked"; id: string; waitFor: string[] }
  | { kind: "approval" };

export interface PlanProgressLine {
  /** in_progress のチケット（Plan の順） */
  working: string[];
  /** 出すものがなければ null（終わった Plan、todo の残らない Plan） */
  next: BandNext | null;
}

/**
 * 帯の行に出す作業中と次。選んだ Iteration の外のチケットも、Plan に入っていれば数える（Plan 全体の進み）。
 * 承認待ちは次の代わりに承認待ち。次は core の plan.list の next（PL-6。手順が選ぶ次と同じ）をそのまま出す。閉じた・完了の Plan は何も出さない
 */
export function planProgressLine(
  plan: PlanRow,
  state: PlanState,
  byId: ReadonlyMap<string, Ticket>,
): PlanProgressLine {
  if (state === "closed" || state === "finished") return { working: [], next: null };
  const working = plan.tickets.filter((id) => byId.get(id)?.status === "in_progress");
  if (state === "pending") return { working, next: { kind: "approval" } };
  const next = plan.next;
  if (!next) return { working, next: null };
  if (next.waiting.length === 0) return { working, next: { kind: "ready", id: next.id } };
  return { working, next: { kind: "blocked", id: next.id, waitFor: [...next.waiting] } };
}
