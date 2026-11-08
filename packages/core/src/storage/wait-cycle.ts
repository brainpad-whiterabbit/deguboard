// 待ちの循環の検出。depends_on の循環（dg validate の integrity.ts）と、Plan の after の循環（plan.create と dg lint）が共有する

import { isTerminal } from "../model/common.js";
import { pendingDeps } from "../model/ticket.js";
import type { Store } from "./store.js";

/** 待ちの辺（from が to を待つ）。via は辺の出どころ */
export interface WaitEdge {
  to: string;
  via: "after" | "depends_on";
}

export interface WaitCycle {
  start: string;
  edges: WaitEdge[];
}

/**
 * ids から深さ優先でたどり、戻りの辺（たどっている途中のチケットへの辺）を見つけるたびに、その循環を onCycle に渡す。
 * onCycle が true を返せばそこでやめる。たどり終えたチケットは二度たどらないので、渡すのは戻りの辺ごとに 1 回で、すべての循環ではない
 */
export function eachCycle(
  ids: Iterable<string>,
  edgesOf: (id: string) => readonly WaitEdge[],
  onCycle: (cycle: WaitCycle) => boolean | void,
): void {
  const state = new Map<string, "visiting" | "done">();
  // たどっている途中のチケットと、そこから出た辺（path[i] は onPath[i] から出た辺）
  const onPath: string[] = [];
  const path: WaitEdge[] = [];
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === "done") return false;
    if (s === "visiting")
      return onCycle({ start: id, edges: path.slice(onPath.indexOf(id)) }) === true;
    state.set(id, "visiting");
    onPath.push(id);
    for (const next of edgesOf(id)) {
      path.push(next);
      const stop = visit(next.to);
      path.pop();
      if (stop) return true;
    }
    onPath.pop();
    state.set(id, "done");
    return false;
  };
  for (const id of ids) if (visit(id)) return;
}

/** 待ちが循環していれば、その一例（始まりのチケットと、たどった辺）を返す */
export function findCycle(
  ids: Iterable<string>,
  edgesOf: (id: string) => readonly WaitEdge[],
): WaitCycle | undefined {
  let found: WaitCycle | undefined;
  eachCycle(ids, edgesOf, (cycle) => {
    found = cycle;
    return true;
  });
  return found;
}

/** after の循環は ID だけを並べ、after と depends_on をまたぐ循環は辺ごとに出どころを添える */
export function cyclePath(cycle: WaitCycle, labeled: boolean): string {
  return [
    cycle.start,
    ...cycle.edges.map((e) => (labeled ? `→(${e.via}) ${e.to}` : `→ ${e.to}`)),
  ].join(" ");
}

/**
 * after と depends_on を合わせた待ちの循環のうち、after の辺を含むものを返す（なければ undefined）。
 * depends_on は Plan の外の終わっていないチケットもたどる（外を回って戻る待ちも止まる）。
 * after の辺を含まない循環（depends_on だけ）は TK-2 と validate の担当なので返さない
 */
export function findCrossingCycle(
  store: Store,
  tickets: readonly string[],
  after: Readonly<Record<string, readonly string[] | undefined>>,
): WaitCycle | undefined {
  if (Object.keys(after).length === 0) return undefined;
  // planReadiness（PL-6）と同じく、終わったチケットは待たず、終わったチケットからは辺を出さない。
  // after の向かう先は Plan に入っていて存在し、終わっていないものだけ
  const live = (id: string) => {
    const status = store.resolve("ticket", id)?.data.status;
    return status !== undefined && !isTerminal(status);
  };
  const crossing = findCycle(tickets, (id) => {
    const t = store.resolve("ticket", id)?.data;
    if (!t || !live(id)) return [];
    const afterEdges = (after[id] ?? [])
      .filter((to) => to !== id && tickets.includes(to) && live(to))
      .map((to): WaitEdge => ({ to, via: "after" }));
    const deps = pendingDeps(t, (dep) => store.resolve("ticket", dep)?.data.status);
    return [
      ...afterEdges,
      ...deps
        .filter((to) => to !== id && store.resolve("ticket", to) !== undefined)
        .map((to): WaitEdge => ({ to, via: "depends_on" })),
    ];
  });
  return crossing?.edges.some((e) => e.via === "after") ? crossing : undefined;
}
