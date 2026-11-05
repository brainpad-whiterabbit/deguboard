// 待ちの循環の検出。Plan の作成（plan.create）と dg lint が共有する

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

/** 待ちが循環していれば、その一例（始まりのチケットと、たどった辺）を返す */
export function findCycle(
  ids: readonly string[],
  edgesOf: (id: string) => readonly WaitEdge[],
): WaitCycle | undefined {
  const state = new Map<string, "visiting" | "done">();
  // たどっている途中のチケットと、そこから出た辺（path[i] は onPath[i] から出た辺）
  const onPath: string[] = [];
  const path: WaitEdge[] = [];
  const visit = (id: string): WaitCycle | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return { start: id, edges: path.slice(onPath.indexOf(id)) };
    state.set(id, "visiting");
    onPath.push(id);
    for (const next of edgesOf(id)) {
      path.push(next);
      const found = visit(next.to);
      if (found) return found;
      path.pop();
    }
    onPath.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of ids) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
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
