// バックログ（UI-3）。done と abandoned 以外を優先度と番号で出し、番号・タイトル・ラベルで検索、Status・優先度・Iteration・ラベル・担当者で絞り込む。
// open の Epic は進捗つきの欄に並べ（UI-10）、押すとその Epic のチケットに絞る（もう一度押すと解除）。Epic の作成も欄から行う。
// サイドバーでは検索と件数だけ常に出し、絞り込みと Epic の欄は畳む（効いている条件は見出しに出す。開閉は host.state に残す）

import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ProgressBar, TicketTable } from "../components/parts.js";
import { useHost, useUiState } from "../host.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import {
  BOARD_STATUSES,
  PRIORITIES,
  actorLabel,
  byNumber,
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
  /** Epic の ID。NO_EPIC は Epic に入っていないもの */
  epic: string;
  label: string;
  /** 担当者（assignee）。NO_CLAIM は担当者のないもの */
  assignee: string;
}

/** バックログで「Epic に入っていないチケット」を選ぶ値 */
export const NO_EPIC = "-";

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
    .filter((t) => !f.epic || (f.epic === NO_EPIC ? !t.epic : t.epic === f.epic))
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

/** 畳んだ絞り込みの見出しに出す、効いている条件。検索は常に見えているので含めない */
export function activeFilters(f: BacklogFilter, labelOf: (status: string) => string): string[] {
  const parts: string[] = [];
  if (f.status) parts.push(`Status: ${labelOf(f.status)}`);
  if (f.priority) parts.push(`優先度: ${f.priority}`);
  if (f.iteration) parts.push(`Iteration: ${f.iteration}`);
  if (f.epic) parts.push(`Epic: ${f.epic === NO_EPIC ? "なし" : f.epic}`);
  if (f.label) parts.push(`ラベル: ${f.label}`);
  if (f.assignee) parts.push(`担当: ${f.assignee === NO_CLAIM ? "なし" : actorLabel(f.assignee)}`);
  return parts;
}

export function BacklogPage() {
  const store = useStore();
  const host = useHost();
  const sidebar = host.surface === "sidebar";
  const [filtersOpen, setFiltersOpen] = useUiState("backlog.filters", false);
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
  const active = activeFilters(filter, (st) => store.labelOf(st as Ticket["status"]));

  const filters: ReactNode = (
    <>
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
    </>
  );

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
        {sidebar ? null : filters}
        <span className="muted">{rows.length} 件</span>
      </div>
      {sidebar ? (
        <details
          className="fold filters"
          open={filtersOpen}
          onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
        >
          <summary>
            絞り込み
            <span className="muted">{active.length > 0 ? active.join(" ・ ") : ""}</span>
          </summary>
          <div className="toolbar">{filters}</div>
        </details>
      ) : null}
      <div className="backlog-layout">
        <EpicPanel
          selected={filter.epic}
          onSelect={(epic) => set({ epic: filter.epic === epic ? "" : epic })}
        />
        <div className="backlog-main">
          <TicketTable tickets={rows} />
        </div>
      </div>
    </section>
  );
}

/**
 * open の Epic の欄：番号（詳細へ）・タイトル・進捗と、Epic に入っていないチケットの件数。
 * タイトルを押すとその Epic で絞り、もう一度押すと解除する。「+」から Epic を作る。
 * サイドバーでは折りたたみの節にし、開閉を host.state に残す
 */
function EpicPanel({ selected, onSelect }: { selected: string; onSelect: (epic: string) => void }) {
  const store = useStore();
  const host = useHost();
  const sidebar = host.surface === "sidebar";
  const [open, setOpen] = useUiState("backlog.epics", true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const epics = useMemo(
    () => store.epics.filter((e) => e.status === "open").sort(byNumber),
    [store.epics],
  );
  const noEpic = store.tickets.filter(
    (t) => !t.epic && t.status !== "done" && t.status !== "abandoned",
  ).length;
  const create = async () => {
    if (!title.trim() || !store.project) return;
    const r = await store.run("epic.create", { title: title.trim(), project: store.project.id });
    if (r.ok) {
      setTitle("");
      setCreating(false);
    }
  };
  const startCreating = (e: MouseEvent) => {
    // 見出し（summary）の中のボタンなので、節の開閉を起こさない
    e.preventDefault();
    setCreating(true);
    setOpen(true);
  };
  // サイドバーでは詳細を拡張ホストに頼んでエディタ領域のパネルに開く（Iteration の詳細と同じ）
  const openDetail = (e: MouseEvent, id: string) => {
    if (host.surface === "browser") return;
    e.preventDefault();
    host.open({ page: "epics", id });
  };

  const add = (
    <button
      type="button"
      className="link"
      onClick={startCreating}
      aria-label="Epic を作る"
      title="Epic を作る"
    >
      +
    </button>
  );
  const body = (
    <>
      {creating ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="新しい Epic の題"
            aria-label="新しい Epic の題"
            autoFocus
          />
          <button type="submit" className="primary" disabled={!title.trim()}>
            作る
          </button>
          <button type="button" onClick={() => setCreating(false)}>
            やめる
          </button>
        </form>
      ) : null}
      <ul className="rows epic-list">
        {epics.map((e) => (
          <li key={e.id} className={selected === e.id ? "selected" : ""}>
            <a href={hrefOf({ page: "epics", id: e.id })} onClick={(ev) => openDetail(ev, e.id)}>
              <code>{e.id}</code>
            </a>
            <button
              type="button"
              className="epic-pick"
              aria-pressed={selected === e.id}
              title={selected === e.id ? "絞り込みを解除する" : "この Epic で絞る"}
              onClick={() => onSelect(e.id)}
            >
              <span className="row-title">{e.title}</span>
              <ProgressBar progress={e.progress} />
            </button>
          </li>
        ))}
        <li className={selected === NO_EPIC ? "selected" : ""}>
          <span />
          <button
            type="button"
            className="epic-pick"
            aria-pressed={selected === NO_EPIC}
            onClick={() => onSelect(NO_EPIC)}
          >
            <span className="row-title muted">Epic なし</span>
            <span className="muted">{noEpic} 件</span>
          </button>
        </li>
      </ul>
    </>
  );

  if (sidebar) {
    return (
      <details
        className="fold epic-panel"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>
          Epic
          {add}
        </summary>
        {body}
      </details>
    );
  }
  return (
    <aside className="epic-panel">
      <header>
        <h2>Epic</h2>
        {add}
      </header>
      {body}
    </aside>
  );
}
