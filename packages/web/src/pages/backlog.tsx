// バックログ（UI-3）。done と abandoned 以外を Iteration ごとの区画（active → planned → Iteration なし）に分け、区画の中は優先度と番号で出す。
// 番号・タイトル・ラベルで検索、Status・優先度・ラベル・担当者で絞り込む。区画の見出しから Iteration の開始・閉じる（サイドバーを除く）、「Iteration なし」から作成。
// Iteration が 1 つもない（planned・active がない）Project では区画に分けず 1 つの表で出す。
// チケットを別の区画にドラッグすると ticket.update で Iteration を変える。拒否されたら通知に理由を出して元の区画に戻す（読み直すだけで戻る）。
// open の Epic は進捗つきの欄に並べ（UI-10）、押すとその Epic のチケットに絞る（もう一度押すと解除）。Epic の作成も欄から行う。
// サイドバーでは検索と件数だけ常に出し、絞り込みと Epic の欄は畳む（効いている条件は見出しに出す。開閉は host.state に残す）

import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ProgressBar, TicketTable } from "../components/parts.js";
import { useHost, useUiState } from "../host.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { shortPeriod } from "./board.js";
import {
  BOARD_STATUSES,
  PRIORITIES,
  actorLabel,
  byNumber,
  byPriorityThenNumber,
  claimOptions,
  ITERATION_LABELS,
  matchesClaim,
  NO_CLAIM,
  type Iteration,
  type Ticket,
} from "../types.js";
import { IterationActions, IterationCreateForm } from "./iterations.js";

export interface BacklogFilter {
  query: string;
  status: string;
  priority: string;
  /** Epic の ID。NO_EPIC は Epic に入っていないもの */
  epic: string;
  label: string;
  /** 担当者（assignee）。NO_CLAIM は担当者のないもの */
  assignee: string;
}

/** バックログで「Epic に入っていないチケット」を選ぶ値 */
const NO_EPIC = "-";

export const EMPTY_FILTER: BacklogFilter = {
  query: "",
  status: "",
  priority: "",
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
function activeFilters(f: BacklogFilter, labelOf: (status: string) => string): string[] {
  const parts: string[] = [];
  if (f.status) parts.push(`Status: ${labelOf(f.status)}`);
  if (f.priority) parts.push(`優先度: ${f.priority}`);
  if (f.epic) parts.push(`Epic: ${f.epic === NO_EPIC ? "なし" : f.epic}`);
  if (f.label) parts.push(`ラベル: ${f.label}`);
  if (f.assignee) parts.push(`担当: ${f.assignee === NO_CLAIM ? "なし" : actorLabel(f.assignee)}`);
  return parts;
}

/** バックログの区画。iteration がなければ「Iteration なし」 */
export interface BacklogSection {
  iteration?: Iteration | undefined;
  tickets: Ticket[];
}

/**
 * 絞り込んだチケットを区画に分ける。並びは active → planned（それぞれ番号の順）→ チケットが残る closed → Iteration なし。
 * 区画の中は rows の並び（優先度と番号）のまま。0 件の区画も出す（closed は残るものがあるときだけ）
 */
export function sectionsOf(
  rows: readonly Ticket[],
  iterations: readonly Iteration[],
  all: readonly Ticket[] = rows,
): BacklogSection[] {
  const rank = { active: 0, planned: 1, closed: 2 } as const;
  const remaining = new Set(
    all.filter((t) => t.status !== "done" && t.status !== "abandoned").map((t) => t.iteration),
  );
  const shown = iterations
    .filter((i) => i.status !== "closed" || remaining.has(i.id))
    .sort((a, b) => rank[a.status] - rank[b.status] || byNumber(a, b));
  const known = new Set(shown.map((i) => i.id));
  return [
    ...shown.map((i) => ({ iteration: i, tickets: rows.filter((t) => t.iteration === i.id) })),
    { tickets: rows.filter((t) => !t.iteration || !known.has(t.iteration)) },
  ];
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
  // 読み直しが終わるまでの間だけ、落とした先の区画に見せる
  const [moving, setMoving] = useState<{ id: string; iteration: Ticket["iteration"] } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const tickets = useMemo(
    () =>
      moving
        ? store.tickets.map((t) => (t.id === moving.id ? { ...t, iteration: moving.iteration } : t))
        : store.tickets,
    [store.tickets, moving],
  );
  const rows = useMemo(() => filterBacklog(tickets, filter), [tickets, filter]);
  const onDragEnd = async (event: DragEndEvent) => {
    const id = String(event.active.id);
    const over = event.over?.id;
    const ticket = store.tickets.find((t) => t.id === id);
    if (over === undefined || !ticket) return;
    const iteration = over === NO_SECTION ? undefined : (String(over) as Ticket["iteration"]);
    if ((ticket.iteration ?? undefined) === iteration) return;
    setMoving({ id, iteration });
    await store.run("ticket.update", { ticket: id, iteration: iteration ?? null });
    setMoving(null);
  };
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
      {/* サイドバーでは条件があるときだけ出す */}
      {!sidebar || active.length > 0 ? (
        <button type="button" onClick={() => setFilter(EMPTY_FILTER)}>
          絞り込みを消す
        </button>
      ) : null}
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
        {/* サイドバーでは件数を絞り込みの行に置き、1 行を使わない */}
        {sidebar ? null : <span className="muted">{rows.length} 件</span>}
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
            <span className="muted count">{rows.length} 件</span>
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
          {store.iterations.some((i) => i.status !== "closed") ? (
            <DndContext sensors={sensors} onDragEnd={(e) => void onDragEnd(e)}>
              {sectionsOf(rows, store.iterations, tickets).map((s) => (
                <Section key={s.iteration?.id ?? NO_SECTION} section={s} />
              ))}
            </DndContext>
          ) : (
            <TicketTable tickets={rows} />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 1 つの区画：見出し（番号・名前・状態・期間・目標・件数・詳細と開始・閉じる。「Iteration なし」は作成）とチケットの表。
 * 0 件なら見出しだけ。サイドバーでは折りたたみの節にし、開閉を host.state に残す。サイドバーの見出しは帯と 2 段で、開始・閉じるを置かない
 */
/** 「Iteration なし」の区画の落とし先の ID（Iteration の ID と重ならない） */
const NO_SECTION = "-";

function Section({ section: { iteration: it, tickets } }: { section: BacklogSection }) {
  const host = useHost();
  // 区画全体が落とし先。閉じた Iteration には入れられないので落とし先にしない
  const { setNodeRef, isOver } = useDroppable({
    id: it?.id ?? NO_SECTION,
    disabled: it?.status === "closed",
  });
  const sidebar = host.surface === "sidebar";
  const [open, setOpen] = useUiState(`backlog.section.${it?.id ?? "none"}`, true);
  const [creating, setCreating] = useState(false);
  const link = it ? (
    <a
      href={hrefOf({ page: "iterations", id: it.id })}
      title="詳細"
      onClick={(e) => {
        // Webview では詳細を拡張ホストに頼んでエディタ領域に開く（履歴の行と同じ）
        if (host.surface === "browser") return;
        e.preventDefault();
        host.open({ page: "iterations", id: it.id });
      }}
    >
      <code>{it.id}</code> {it.name}
    </a>
  ) : (
    "Iteration なし"
  );
  // サイドバーの見出し（カンバンの SidebarBoardHead と同じ部品）：左の帯の色で Iteration の状態を出し、1 段目に番号・名前・件数、
  // 2 段目に状態・月日の期間・目標を 1 行で（溢れたら省略してツールチップで全文）。開始・閉じるは置かず、詳細の画面で行う。
  // 0 件の区画は帯も 2 段目もない 1 行にし、「Iteration なし」は行の右端の「+」で作る
  const period = it ? shortPeriod(it.start, it.end) : undefined;
  const sub = it ? [ITERATION_LABELS[it.status], period, it.goal].filter(Boolean).join(" ・ ") : "";
  const sidebarHead = (
    <>
      <span className="head-line">
        <span className="name">{link}</span>
        <span className="muted count">{tickets.length} 件</span>
        {it || creating ? null : (
          <button
            type="button"
            className="link create"
            aria-label="Iteration を作る"
            title="Iteration を作る"
            onClick={(e) => {
              // 見出し（summary）の中のボタンなので、節の開閉を起こさない
              e.preventDefault();
              setCreating(true);
              setOpen(true);
            }}
          >
            +
          </button>
        )}
      </span>
      {it && tickets.length > 0 ? (
        <span className="head-line sub muted" title={sub}>
          <span className={`state iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
          {period ? <span className="period">{period}</span> : null}
          {it.goal ? <span className="goal">{it.goal}</span> : null}
        </span>
      ) : null}
    </>
  );
  const head = (
    <>
      {it ? (
        <>
          <a
            href={hrefOf({ page: "iterations", id: it.id })}
            title="詳細"
            onClick={(e) => {
              // Webview では詳細を拡張ホストに頼んでエディタ領域に開く（履歴の行と同じ）
              if (host.surface === "browser") return;
              e.preventDefault();
              host.open({ page: "iterations", id: it.id });
            }}
          >
            <code>{it.id}</code> {it.name}
          </a>
          <span className={`badge iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
        </>
      ) : (
        <span className="name">Iteration なし</span>
      )}
      <span className="muted count">{tickets.length} 件</span>
      <span className="actions">
        {it ? (
          <IterationActions iteration={it} />
        ) : creating ? null : (
          <button
            type="button"
            className="link"
            onClick={(e) => {
              // 見出し（summary）の中のボタンなので、節の開閉を起こさない
              e.preventDefault();
              setCreating(true);
              setOpen(true);
            }}
          >
            + Iteration を作る
          </button>
        )}
      </span>
      {it && (it.start || it.end || it.goal) ? (
        <small className="muted meta">
          {it.start || it.end ? `${it.start ?? "?"} 〜 ${it.end ?? "?"}` : ""}
          {(it.start || it.end) && it.goal ? " ・ " : ""}
          {it.goal}
        </small>
      ) : null}
    </>
  );
  const body = (
    <>
      {creating ? <IterationCreateForm onDone={() => setCreating(false)} /> : null}
      {tickets.length > 0 ? <TicketTable tickets={tickets} draggable priorityMarks /> : null}
    </>
  );
  if (sidebar) {
    return (
      <details
        ref={setNodeRef}
        className={`fold backlog-section sidebar-section iteration-${it?.status ?? "none"}${isOver ? " over" : ""}${tickets.length === 0 ? " empty-section" : ""}`}
        // 0 件の区画は畳んだ 1 行にする（作るフォームを開いたときだけ開く）
        open={tickets.length === 0 ? creating : open}
        onToggle={(e) => tickets.length > 0 && setOpen(e.currentTarget.open)}
      >
        <summary>{sidebarHead}</summary>
        {body}
      </details>
    );
  }
  return (
    <section ref={setNodeRef} className={`backlog-section${isOver ? " over" : ""}`}>
      <header>{head}</header>
      {body}
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
          <li key={e.id} className={selected === e.id ? "selected" : undefined}>
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
              {sidebar && selected === e.id ? <span className="epic-clear">× 解除</span> : null}
            </button>
          </li>
        ))}
        <li className={selected === NO_EPIC ? "selected" : undefined}>
          {/* サイドバーでは Epic の行と同じ形にする（番号の欄に「—」） */}
          {sidebar ? <code className="muted">—</code> : <span />}
          <button
            type="button"
            className="epic-pick"
            aria-pressed={selected === NO_EPIC}
            title={selected === NO_EPIC ? "絞り込みを解除する" : "Epic のないチケットで絞る"}
            onClick={() => onSelect(NO_EPIC)}
          >
            <span className={sidebar ? "row-title" : "row-title muted"}>Epic なし</span>
            <span className="muted">{noEpic} 件</span>
            {sidebar && selected === NO_EPIC ? <span className="epic-clear">× 解除</span> : null}
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
