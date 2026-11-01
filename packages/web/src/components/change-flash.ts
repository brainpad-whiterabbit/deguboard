// 左パネルのカンバンで、前回の描画から変化したチケットの行を短く点滅させる（UI-2）。KanbanForge の SP-10 と同じ形。
// 比べる処理は DOM に依存しない関数にして vitest で確かめる。要約は host.state に置き、VS Code を開き直しても続けて比べる。
// 左パネルは隠れている間も描き直されるので（retainContextWhenHidden）、見えていない間に見つけた変化はためておき、見えたときに点滅を始める

import { useCallback, useEffect, useRef, useState } from "react";
import type { UiState } from "../ui-state.js";
import type { Ticket } from "../types.js";

/** チケットごとの、比べる内容（Status と Iteration） */
export interface TicketSnapshot {
  status: string;
  iteration: string | null;
}

/** 前回の描画の要約。チケットの ID → 比べる内容 */
export type TicketSummary = Record<string, TicketSnapshot>;

/** 点滅させているチケット。チケットの ID → 点滅を始めた時刻（ミリ秒） */
export type FlashState = Record<string, number>;

/** 点滅の長さ（ミリ秒）。styles.css の .row.changed のアニメーション（0.5 秒 × 2）と合わせる */
export const FLASH_DURATION_MS = 1000;

/** 要約を置く host.state の鍵 */
const SUMMARY_KEY = "board.summary";

export function summarizeTickets(
  tickets: readonly Pick<Ticket, "id" | "status" | "iteration">[],
): TicketSummary {
  const summary: TicketSummary = {};
  for (const t of tickets) summary[t.id] = { status: t.status, iteration: t.iteration ?? null };
  return summary;
}

/**
 * 前回の要約と比べて、Status か Iteration が変わったチケットと、新しく現れたチケットの ID。
 * 比べる相手がない（初めての描画）ときは何も返さない。消えたチケットは返さない
 */
export function changedTickets(
  previous: TicketSummary | undefined,
  current: TicketSummary,
): string[] {
  if (previous === undefined) return [];
  return Object.entries(current)
    .filter(([id, now]) => {
      const before = previous[id];
      return (
        before === undefined || before.status !== now.status || before.iteration !== now.iteration
      );
    })
    .map(([id]) => id);
}

/**
 * 次の点滅の状態。終わった点滅を外し、変化したチケットを now から点滅させる。
 * 時間内の描き直しでは続きのまま（始めた時刻を変えない）、終わった後は再生しない
 */
export function nextFlash(
  previous: FlashState,
  changed: readonly string[],
  now: number,
): FlashState {
  const next: FlashState = {};
  for (const [id, at] of Object.entries(previous)) if (now - at < FLASH_DURATION_MS) next[id] = at;
  for (const id of changed) next[id] = now;
  return next;
}

/** 画面が見えているか。document がない（テストの一部）ときは見えているとみなす */
function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * tickets（Project のすべてのチケット）の変化を見て、点滅させるチケットの ID の集合を返す。enabled が false なら何もしない。
 * ignore(id) で、画面から自分で動かすチケットの次の 1 回の変化を点滅させない（自分のドラッグ）。書き込みが失敗したら release(id) で戻す。
 * 比べるのは Iteration で絞る前のすべてのチケットなので、絞り込みを変えただけでは点滅しない
 */
export function useChangeFlash(
  tickets: readonly Ticket[],
  state: UiState,
  enabled: boolean,
): { flashing: ReadonlySet<string>; ignore: (id: string) => void; release: (id: string) => void } {
  const [flash, setFlash] = useState<FlashState>({});
  const pending = useRef<string[]>([]);
  const ignored = useRef(new Set<string>());

  const start = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setFlash((prev) => nextFlash(prev, ids, Date.now()));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const current = summarizeTickets(tickets);
    const changed = changedTickets(state.get<TicketSummary>(SUMMARY_KEY), current).filter(
      (id) => !ignored.current.delete(id),
    );
    state.set(SUMMARY_KEY, current);
    if (isVisible()) start(changed);
    else pending.current.push(...changed);
  }, [tickets, state, enabled, start]);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onVisible = () => {
      if (!isVisible() || pending.current.length === 0) return;
      const ids = pending.current;
      pending.current = [];
      start(ids);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, start]);

  // 点滅が終わったら class を外す（残すと次の描き直しで再生しないが、DOM に残り続ける）
  useEffect(() => {
    const ats = Object.values(flash);
    if (ats.length === 0) return;
    const wait = Math.max(0, Math.min(...ats) + FLASH_DURATION_MS - Date.now());
    const timer = setTimeout(() => setFlash((prev) => nextFlash(prev, [], Date.now())), wait);
    return () => clearTimeout(timer);
  }, [flash]);

  return {
    flashing: new Set(Object.keys(flash)),
    ignore: useCallback((id: string) => void ignored.current.add(id), []),
    release: useCallback((id: string) => void ignored.current.delete(id), []),
  };
}
