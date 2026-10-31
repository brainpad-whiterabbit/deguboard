// バックログ（UI-3）。done と abandoned 以外を優先度と番号で出し、番号・タイトル・ラベルで検索、Status・優先度・Iteration・Epic・ラベル・担当者で絞り込む

import { useMemo, useState } from "react";
import { TicketTable } from "../components/parts.js";
import { useStore } from "../store.js";
import {
  BOARD_STATUSES,
  PRIORITIES,
  actorLabel,
  byPriorityThenNumber,
  claimOptions,
  matchesClaim,
  NO_CLAIM,
  type Ticket,
} from "../types.js";

export interface BacklogFilter {
  query: string;
  status: string;
  priority: string;
  iteration: string;
  epic: string;
  label: string;
  /** 担当者（assignee）。NO_CLAIM は担当者のないもの */
  assignee: string;
}

export const EMPTY_FILTER: BacklogFilter = {
  query: "",
  status: "",
  priority: "",
  iteration: "",
  epic: "",
  label: "",
  assignee: "",
};

/** 絞り込みの規則。表示の正本はここ（requirements 6.4） */
export function filterBacklog(tickets: readonly Ticket[], f: BacklogFilter): Ticket[] {
  const q = f.query.trim().toLowerCase();
  return tickets
    .filter((t) => t.status !== "done" && t.status !== "abandoned")
    .filter((t) => !f.status || t.status === f.status)
    .filter((t) => !f.priority || t.priority === f.priority)
    .filter((t) => !f.iteration || t.iteration === f.iteration)
    .filter((t) => !f.epic || t.epic === f.epic)
    .filter((t) => !f.label || t.labels.includes(f.label))
    .filter((t) => matchesClaim(t, f.assignee))
    .filter(
      (t) =>
        !q ||
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.labels.some((l) => l.toLowerCase().includes(q)),
    )
    .sort(byPriorityThenNumber);
}

export function BacklogPage() {
  const store = useStore();
  const [filter, setFilter] = useState<BacklogFilter>(EMPTY_FILTER);
  const set = (patch: Partial<BacklogFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const labels = useMemo(
    () => [...new Set(store.tickets.flatMap((t) => t.labels))].sort(),
    [store.tickets],
  );
  const claims = useMemo(
    () =>
      claimOptions(store.tickets.filter((t) => t.status !== "done" && t.status !== "abandoned")),
    [store.tickets],
  );
  const rows = useMemo(() => filterBacklog(store.tickets, filter), [store.tickets, filter]);
  const statuses = BOARD_STATUSES.filter((s) => s !== "done");

  return (
    <section>
      <div className="toolbar">
        <h1>バックログ</h1>
        <input
          type="search"
          placeholder="番号・タイトル・ラベルで検索"
          value={filter.query}
          onChange={(e) => set({ query: e.target.value })}
          aria-label="検索"
        />
        <label>
          Status
          <select value={filter.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">すべて</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {store.labelOf(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          優先度
          <select value={filter.priority} onChange={(e) => set({ priority: e.target.value })}>
            <option value="">すべて</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Iteration
          <select value={filter.iteration} onChange={(e) => set({ iteration: e.target.value })}>
            <option value="">すべて</option>
            {store.iterations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} {i.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Epic
          <select value={filter.epic} onChange={(e) => set({ epic: e.target.value })}>
            <option value="">すべて</option>
            {store.epics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} {e.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          ラベル
          <select value={filter.label} onChange={(e) => set({ label: e.target.value })}>
            <option value="">すべて</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {claims.length > 0 ? (
          <label>
            担当
            <select value={filter.assignee} onChange={(e) => set({ assignee: e.target.value })}>
              <option value="">すべて</option>
              {claims.map((c) => (
                <option key={c} value={c} title={c}>
                  {c === NO_CLAIM ? "なし" : actorLabel(c)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" onClick={() => setFilter(EMPTY_FILTER)}>
          絞り込みを消す
        </button>
        <span className="muted">{rows.length} 件</span>
      </div>
      <TicketTable tickets={rows} />
    </section>
  );
}
