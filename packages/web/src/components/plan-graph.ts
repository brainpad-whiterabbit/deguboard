// 実行計画の帯が使う計算：Plan の状態・並び・範囲と、after・depends_on から求める依存グラフの段と配置（ノードの位置と辺の経路）。画面に依存しない純粋な関数だけを置く。
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
 * plan.show の出力（Plan 詳細）を plan.list の 1 行の形にする。状態は core の status をそのまま使い、
 * Plan 全体の待ちは items[].waiting から組む（求め直さず並べ替えるだけ）。帯と同じ部品（planState・planGraph・planProgressLine）に渡すため
 */
export function planRowOf(detail: PlanDetail): PlanRow {
  const waiting: Record<string, string[]> = {};
  for (const t of detail.items) if (t.waiting.length > 0) waiting[t.id] = t.waiting;
  const { items: _items, ...plan } = detail;
  return { ...plan, waiting: waiting as PlanRow["waiting"] };
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

/** 依存グラフのノードの大きさ（px） */
export const GRAPH_NODE_W = 76;
export const GRAPH_NODE_H = 22;
/** 段の間。辺の S 字が急に曲がって絡まないよう広く取る */
const COL_GAP = 48;
/** 行の間。2 段以上離れた辺をこの溝に通すので、線が数本並べる幅を取る */
const ROW_GAP = 12;
/** 同じ溝を通る辺どうしの間隔。溝が詰まるときは溝の幅に収まるまで縮める */
const LANE_STEP = 3;
/** 溝の真ん中から、辺を寄せてよい幅（ノードの縁に線が触れないよう 2px 残す） */
const LANE_HALF = ROW_GAP / 2 - 2;
/** 段の中の並べ替え（重心法）の往復の回数 */
const SWEEPS = 4;

export interface GraphNode {
  id: string;
  /** 段（左から 0）。待ちの最も長い列の深さ */
  layer: number;
  /** 段の中の位置（上から 0）。前後の段と結ぶ辺の交差が少ない順。交差が減らなければ Plan の tickets の順 */
  row: number;
  /** 描く位置（左上、px） */
  x: number;
  y: number;
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
  /** 描く経路（SVG の path の d）。待たれる側の右の縁から、待つ側の左の縁に着く */
  path: string;
  /** 入口の位置（待つ側の左の縁の、経路が着く点）。入口の丸を置く */
  entry: { x: number; y: number };
}

export interface PlanGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
  rows: number;
  /** 描く大きさ（px） */
  width: number;
  height: number;
}

/**
 * after（Plan の中の待ち）と、Plan の中のチケット同士の depends_on から依存グラフを組む。段は両方から求める。消えたチケットと Plan の外への待ちは飛ばす。
 * 循環は plan.create（after だけと、after と depends_on をまたぐもの）と TK-2（depends_on だけ）が拒否する。
 * Plan を作った後の depends_on の書き換えでできたまたぐ循環は拒否されず、dg lint が指摘する。それや壊れたデータでも止まらないよう、たどっている途中の待ちは数えない。
 * 段の中の並び・ノードの位置・辺の経路もここで決め、PlanGraphView は返った座標で描くだけにする
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

  const layered: string[][] = [];
  for (const id of ids) (layered[layerOf(id)] ??= []).push(id);
  const links = ids.flatMap((to) => {
    const open = waitsOf(plan, to);
    const link = (kind: GraphEdge["kind"]) => (from: string) => ({
      from,
      to,
      done: !open.includes(from),
      kind,
    });
    return [...afterOf(to).map(link("after")), ...dependsOf(to).map(link("depends_on"))];
  });
  const rowOf = orderRows(layered, links, depth);
  const layout = layoutGraph(layered.length, rowOf, depth, links);
  const nodes = ids.map((id): GraphNode => ({
    id,
    layer: depth.get(id)!,
    row: rowOf.get(id)!,
    ...layout.at(id),
    status: byId.get(id)!.status,
    waiting: waitsOf(plan, id).length > 0,
  }));
  const edges = links.map((e, i): GraphEdge => ({
    ...e,
    path: layout.paths[i]!,
    entry: layout.entries[i]!,
  }));
  return {
    nodes,
    edges,
    layers: layered.length,
    rows: Math.max(0, ...layered.map((l) => l?.length ?? 0)),
    width: layout.width,
    height: layout.height,
  };
}

interface Link {
  from: string;
  to: string;
}

/**
 * 段の中の並びを、前後の段と結ぶ辺の交差が少ない順にする（重心法：繋がる相手の位置の平均で並べ替えるのを左右に往復する）。
 * 往復のたびに交差を数え、最も少ない並びを採る。減らなければ Plan の順のまま（同じ重心も Plan の順を保つ）。
 * 交差は (段, 行) の平面で辺を線分とみて、重なる段の区間の両端で上下が入れ替わる組を数える（2 段以上離れた辺も同じ物差しで数える）
 */
function orderRows(
  layered: readonly (readonly string[] | undefined)[],
  links: readonly Link[],
  depth: ReadonlyMap<string, number>,
): Map<string, number> {
  const layers = layered.map((l) => [...(l ?? [])]);
  const rowOf = new Map<string, number>();
  const place = () => {
    for (const l of layers) l.forEach((id, i) => rowOf.set(id, i));
  };
  place();
  // 左から右へ向かう辺だけで並べる（壊れたデータの逆向きの辺は並びに効かせない）
  const forward = links.filter((e) => depth.get(e.from)! < depth.get(e.to)!);
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of forward) {
    (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
    (succs.get(e.from) ?? succs.set(e.from, []).get(e.from)!).push(e.to);
  }
  const rowAt = (e: Link, layer: number) => {
    const [l1, l2] = [depth.get(e.from)!, depth.get(e.to)!];
    const [r1, r2] = [rowOf.get(e.from)!, rowOf.get(e.to)!];
    return r1 + ((r2 - r1) * (layer - l1)) / (l2 - l1);
  };
  const crossings = () => {
    let n = 0;
    for (let i = 0; i < forward.length; i++) {
      for (let j = i + 1; j < forward.length; j++) {
        const a = forward[i]!;
        const b = forward[j]!;
        if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
        const lo = Math.max(depth.get(a.from)!, depth.get(b.from)!);
        const hi = Math.min(depth.get(a.to)!, depth.get(b.to)!);
        if (lo >= hi) continue;
        if ((rowAt(a, lo) - rowAt(b, lo)) * (rowAt(a, hi) - rowAt(b, hi)) < 0) n++;
      }
    }
    return n;
  };
  const sortBy = (l: number, near: ReadonlyMap<string, string[]>) => {
    const key = (id: string) => {
      const ns = near.get(id);
      if (!ns) return rowOf.get(id)!;
      return ns.reduce((s, x) => s + rowOf.get(x)!, 0) / ns.length;
    };
    const keyed = layers[l]!.map((id) => ({ id, k: key(id), r: rowOf.get(id)! }));
    keyed.sort((a, b) => a.k - b.k || a.r - b.r);
    layers[l] = keyed.map((x) => x.id);
    place();
  };
  let best = new Map(rowOf);
  let fewest = crossings();
  for (let k = 0; k < SWEEPS && fewest > 0; k++) {
    for (let l = 1; l < layers.length; l++) sortBy(l, preds);
    for (let l = layers.length - 2; l >= 0; l--) sortBy(l, succs);
    const c = crossings();
    if (c < fewest) {
      fewest = c;
      best = new Map(rowOf);
    }
  }
  return best;
}

/** 座標を小数 2 桁に丸める（path の d を読みやすく、テストで比べやすくする） */
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 2 点を水平に出て水平に着く S 字の続き（M の後に足す） */
const curveTo = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = r2((x1 + x2) / 2);
  return ` C${mx},${r2(y1)} ${mx},${r2(y2)} ${r2(x2)},${r2(y2)}`;
};

/**
 * ノードの位置と辺の経路を決める。
 * - 1 つのノードに入る（出る）辺が 2 本以上あれば、着く（出る）高さをノードの縦の縁に等間隔に散らし、相手の高さの順に割り当てる（矢じりが 1 点に重ならないよう）
 * - 2 段以上離れた辺は、両端の高さに近い行の間の溝を水平に通し、間の段のノードの上を通らない。同じ溝の辺は少しずつずらす
 * - いちばん上・下の外の溝を使うときだけ、その分の余白を足す
 */
function layoutGraph(
  layerCount: number,
  rowOf: ReadonlyMap<string, number>,
  depth: ReadonlyMap<string, number>,
  links: readonly Link[],
) {
  const rows = Math.max(0, ...rowOf.values()) + 1;
  const pitch = GRAPH_NODE_H + ROW_GAP;
  const top0 = (id: string) => rowOf.get(id)! * pitch;
  const mid0 = (id: string) => top0(id) + GRAPH_NODE_H / 2;
  // 溝 g はノードの行 g の上（g = rows はいちばん下の外）
  const gutterY = (g: number) => g * pitch - ROW_GAP / 2;
  const gutterOf = new Map<number, number>();
  links.forEach((e, i) => {
    if (depth.get(e.to)! - depth.get(e.from)! < 2) return;
    let best = 0;
    let cost = Infinity;
    for (let g = 0; g <= rows; g++) {
      const c = Math.abs(gutterY(g) - mid0(e.from)) + Math.abs(gutterY(g) - mid0(e.to));
      if (c < cost) [best, cost] = [g, c];
    }
    gutterOf.set(i, best);
  });
  const usedGutters = new Set(gutterOf.values());
  const shift = usedGutters.has(0) ? ROW_GAP : 0;
  const bottom = usedGutters.has(rows) ? ROW_GAP : 0;
  // 同じ溝の辺を、溝の真ん中を中心に並べる
  const laneY = new Map<number, number>();
  for (const g of usedGutters) {
    const members = [...gutterOf].filter(([, x]) => x === g).map(([i]) => i);
    const step =
      members.length > 1 ? Math.min(LANE_STEP, (2 * LANE_HALF) / (members.length - 1)) : 0;
    members.forEach((i, k) => {
      laneY.set(i, shift + gutterY(g) + (k - (members.length - 1) / 2) * step);
    });
  }
  const xOf = (id: string) => depth.get(id)! * (GRAPH_NODE_W + COL_GAP);
  const yOf = (id: string) => shift + top0(id);
  // 入口・出口の高さ：相手側の高さ（溝を通る辺は溝の高さ）の順に、ノードの縁を等分した位置へ
  const toward = (i: number, other: string) => laneY.get(i) ?? shift + mid0(other);
  const inY = new Map<number, number>();
  const outY = new Map<number, number>();
  const spread = (side: Map<number, number>, end: "from" | "to", other: "from" | "to") => {
    const byNode = new Map<string, number[]>();
    links.forEach((e, i) => (byNode.get(e[end]) ?? byNode.set(e[end], []).get(e[end])!).push(i));
    for (const [id, list] of byNode) {
      const sorted = [...list].sort(
        (a, b) => toward(a, links[a]![other]) - toward(b, links[b]![other]) || a - b,
      );
      sorted.forEach((i, k) => {
        side.set(i, yOf(id) + (GRAPH_NODE_H * (k + 1)) / (sorted.length + 1));
      });
    }
  };
  spread(inY, "to", "from");
  spread(outY, "from", "to");
  const paths = links.map((e, i) => {
    const x1 = xOf(e.from) + GRAPH_NODE_W;
    const y1 = outY.get(i)!;
    const x2 = xOf(e.to);
    const y2 = inY.get(i)!;
    const lane = laneY.get(i);
    const start = `M${r2(x1)},${r2(y1)}`;
    if (lane === undefined) return start + curveTo(x1, y1, x2, y2);
    const xa = x1 + COL_GAP;
    const xb = x2 - COL_GAP;
    return (
      start + curveTo(x1, y1, xa, lane) + ` L${r2(xb)},${r2(lane)}` + curveTo(xb, lane, x2, y2)
    );
  });
  const entries = links.map((e, i) => ({ x: r2(xOf(e.to)), y: r2(inY.get(i)!) }));
  return {
    at: (id: string) => ({ x: xOf(id), y: yOf(id) }),
    paths,
    entries,
    width: layerCount > 0 ? layerCount * GRAPH_NODE_W + (layerCount - 1) * COL_GAP : 0,
    height: rowOf.size > 0 ? shift + rows * GRAPH_NODE_H + (rows - 1) * ROW_GAP + bottom : 0,
  };
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
