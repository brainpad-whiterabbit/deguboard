// バックログ（UI-3）。done と abandoned 以外を Iteration ごとの区画（active → planned → Iteration なし）に分け、区画の中は優先度と番号で出す。
// 番号・タイトル・ラベルで検索、Status・優先度・ラベル・担当者で絞り込む。区画の見出しから Iteration の開始・閉じる（サイドバーを除く）、「Iteration なし」から作成。
// Iteration が 1 つもない（planned・active がない）Project では区画に分けず 1 つの表で出す。
// チケットを別の区画にドラッグすると ticket.update で Iteration を変える。拒否されたら通知に理由を出して元の区画に戻す（読み直すだけで戻る）。
// open の Epic は進捗つきの欄に並べ（UI-10）、押すとその Epic のチケットに絞る（もう一度押すと解除）。広い画面では Epic の作成も欄から行う。
// サイドバーでは検索を常に出し、その下によく使う絞り込み（自分・作業中・high）のチップと、畳んだ欄で効いている条件の札（× で外す）を並べる。
// 絞り込みの欄は畳み（開閉は host.state に残す）、見出しの件数は絞り込みが効いているときだけ「n / m 件」で出す。
// サイドバーの Epic の欄は open の Epic があるときだけ、番号・題・進捗のチップと「Epic なし」のチップを並べる（2 行を超える分は「ほか N」）
// サイドバーの行の右端には、開いた Plan に入っていれば Plan の番号と着手可・待ちを出す（カンバンと同じ部品と判定。components/row-end.tsx の BacklogRowEnd）。
// サイドバーの行は担当者の列を出さず、別の人の担当だけ右端に頭文字の丸で出す（自分か自分の agent は出さない。store.me）

import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMemo, useState, type ReactNode } from "react";
import { Chip, ChipRow } from "../components/chips.js";
import {
  IterationActions,
  IterationCreateForm,
  shortPeriod,
} from "../components/iteration-parts.js";
import { ProgressBar, TicketTable } from "../components/parts.js";
import { BacklogRowEnd, kanbanPlanMarks, type PlanMark } from "../components/row-end.js";
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
  isOwnAssignee,
  ITERATION_LABELS,
  matchesClaim,
  NO_CLAIM,
  type Iteration,
  type Ticket,
  type WhoamiView,
} from "../types.js";

export interface BacklogFilter {
  query: string;
  status: string;
  priority: string;
  /** Epic の ID。NO_EPIC は Epic に入っていないもの */
  epic: string;
  label: string;
  /** 担当者（assignee）。NO_CLAIM は担当者のないもの */
  assignee: string;
  /** 操作している人か、その人の agent が担当のものだけ（「自分」のチップ。判定は isOwnAssignee） */
  mine: boolean;
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
  mine: false,
};

/**
 * 絞り込みの規則。表示の正本はここ（requirements 6.4）。me は操作している人（store.me）で、mine の判定に使う。
 * 操作している人が分からない（null）間の mine は、どのチケットにも当たらない
 */
export function filterBacklog(
  tickets: readonly Ticket[],
  f: BacklogFilter,
  me: Pick<WhoamiView, "own_ids"> | null = null,
): Ticket[] {
  const q = f.query.trim().toLowerCase();
  return tickets
    .filter((t) => t.status !== "done" && t.status !== "abandoned")
    .filter((t) => !f.status || t.status === f.status)
    .filter((t) => !f.priority || t.priority === f.priority)
    .filter((t) => !f.epic || (f.epic === NO_EPIC ? !t.epic : t.epic === f.epic))
    .filter((t) => !f.label || t.labels.includes(f.label))
    .filter((t) => matchesClaim(t, f.assignee))
    .filter((t) => !f.mine || (!!t.assignee && isOwnAssignee(me, t.assignee)))
    .filter(
      (t) =>
        !q ||
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.labels.some((l) => l.toLowerCase().includes(q)),
    )
    .sort(byPriorityThenNumber);
}

/** 効いている条件の 1 つ。key はその条件の欄、text は札に出す文、title はツールチップ、clear は外す差分 */
interface ActiveFilter {
  key: Exclude<keyof BacklogFilter, "query">;
  text: string;
  title?: string;
  clear: Partial<BacklogFilter>;
}

/** 効いている条件（検索を除く）。検索は常に見えているので含めない */
function activeFilters(f: BacklogFilter, labelOf: (status: string) => string): ActiveFilter[] {
  const parts: ActiveFilter[] = [];
  if (f.mine) parts.push({ key: "mine", text: "担当 自分", clear: { mine: false } });
  if (f.status) {
    parts.push({ key: "status", text: `Status ${labelOf(f.status)}`, clear: { status: "" } });
  }
  if (f.priority)
    parts.push({ key: "priority", text: `優先度 ${f.priority}`, clear: { priority: "" } });
  if (f.epic) {
    const text = `Epic ${f.epic === NO_EPIC ? "なし" : f.epic}`;
    parts.push({ key: "epic", text, clear: { epic: "" } });
  }
  if (f.label) parts.push({ key: "label", text: `ラベル ${f.label}`, clear: { label: "" } });
  if (f.assignee) {
    const who = f.assignee === NO_CLAIM ? "なし" : actorLabel(f.assignee);
    parts.push({
      key: "assignee",
      text: `担当 ${who}`,
      title: f.assignee === NO_CLAIM ? "担当なし" : f.assignee,
      clear: { assignee: "" },
    });
  }
  return parts;
}

/**
 * よく使う絞り込みのチップ：押すとその条件で絞り、もう一度押すと外す。
 * 「自分」は操作している人（store.me）が分かるまで出さない
 */
const QUICK_FILTERS = [
  {
    key: "mine",
    text: "自分",
    what: () => "自分か自分の agent の担当",
    on: (f: BacklogFilter) => f.mine,
    toggle: (f: BacklogFilter): Partial<BacklogFilter> => ({ mine: !f.mine }),
  },
  {
    key: "status",
    text: "作業中",
    what: (statusLabel: string) => `Status ${statusLabel}`,
    on: (f: BacklogFilter) => f.status === "in_progress",
    toggle: (f: BacklogFilter): Partial<BacklogFilter> => ({
      status: f.status === "in_progress" ? "" : "in_progress",
    }),
  },
  {
    key: "priority",
    text: "high",
    what: () => "優先度 high",
    on: (f: BacklogFilter) => f.priority === "high",
    toggle: (f: BacklogFilter): Partial<BacklogFilter> => ({
      priority: f.priority === "high" ? "" : "high",
    }),
  },
] as const;

/**
 * 効いている条件のうち、ほかの場所で見えていないものを札にする。よく使うチップで見えている条件（出ているチップが効いているとき）と、
 * Epic の欄のチップで見えている Epic（epicShown。選んだチップは ChipRow が「ほか N」に隠さない）は札にしない
 */
function foldedFilters(
  f: BacklogFilter,
  active: readonly ActiveFilter[],
  { meKnown, epicShown }: { meKnown: boolean; epicShown: boolean },
): ActiveFilter[] {
  return active.filter((a) => {
    if (a.key === "epic") return !epicShown;
    const quick = QUICK_FILTERS.find((q) => q.key === a.key);
    if (!quick || !quick.on(f)) return true;
    return quick.key === "mine" && !meKnown;
  });
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
  const rows = useMemo(() => filterBacklog(tickets, filter, store.me), [tickets, filter, store.me]);
  // サイドバーの行の右端に、開いた Plan の番号と着手可・待ちを出す（判定はカンバンと同じ kanbanPlanMarks）
  const planMarks = useMemo(
    () => (sidebar ? kanbanPlanMarks(store.plans, store.tickets) : new Map<string, PlanMark>()),
    [sidebar, store.plans, store.tickets],
  );
  const rowEnd = (t: Ticket, priority: ReactNode) => (
    <BacklogRowEnd ticket={t} mark={planMarks.get(t.id)} priority={priority} me={store.me} />
  );
  const total = useMemo(() => filterBacklog(tickets, EMPTY_FILTER).length, [tickets]);
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
  const filtering = active.length > 0 || filter.query.trim() !== "";
  const { epics: openEpics } = useOpenEpics();
  // Epic の欄に選んだ Epic のチップが出ているか（open の Epic がないと欄は出ず、閉じた Epic を選んでいればチップはない）
  const epicShown =
    openEpics.length > 0 &&
    (filter.epic === NO_EPIC || openEpics.some((e) => e.id === filter.epic));

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
        <QuickFilters
          filter={filter}
          folded={foldedFilters(filter, active, { meKnown: store.me !== null, epicShown })}
          statusLabel={store.labelOf("in_progress")}
          meKnown={store.me !== null}
          onChange={set}
        />
      ) : null}
      {sidebar ? (
        <details
          className="fold filters"
          open={filtersOpen}
          onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
        >
          <summary>
            絞り込み
            {filtering ? (
              <span className="muted count" title={`全 ${total} 件のうち ${rows.length} 件`}>
                {rows.length} / {total} 件
              </span>
            ) : null}
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
                <Section key={s.iteration?.id ?? NO_SECTION} section={s} rowEnd={rowEnd} />
              ))}
            </DndContext>
          ) : (
            <TicketTable tickets={rows} assigneeInEnd rowMenu end={rowEnd} />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * サイドバーの検索欄の下の 1 行：よく使う絞り込みのチップ（押すと絞り、効いているものは塗る）と、
 * ほかの場所で見えていない効いている条件の札（× で外す）。札が多ければ折り返す（条件を隠さない）
 */
function QuickFilters({
  filter,
  folded,
  statusLabel,
  meKnown,
  onChange,
}: {
  filter: BacklogFilter;
  folded: readonly ActiveFilter[];
  statusLabel: string;
  /** 操作している人が分かっているか。分かるまで「自分」は出さない */
  meKnown: boolean;
  onChange: (patch: Partial<BacklogFilter>) => void;
}) {
  return (
    <div className="chip-row quick-filters" role="group" aria-label="絞り込み">
      {QUICK_FILTERS.filter((q) => q.key !== "mine" || meKnown).map((q) => {
        const pressed = q.on(filter);
        const what = q.what(statusLabel);
        return (
          <Chip
            key={q.key}
            pressed={pressed}
            title={pressed ? `${what} の絞り込みを外す` : `${what} で絞る`}
            onClick={() => onChange(q.toggle(filter))}
          >
            {q.text}
          </Chip>
        );
      })}
      {folded.map((a) => (
        <span key={a.key} className="filter-chip" title={a.title ?? a.text}>
          <span className="filter-chip-text">{a.text}</span>
          <button
            type="button"
            aria-label={`${a.text} の絞り込みを外す`}
            onClick={() => onChange(a.clear)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * 1 つの区画：見出し（番号・名前・状態・期間・目標・件数・詳細と開始・閉じる。「Iteration なし」は作成）とチケットの表。
 * 0 件なら見出しだけ。サイドバーでは折りたたみの節にし、開閉を host.state に残す。サイドバーの見出しは帯と 2 段で、開始・閉じるを置かない
 */
/** 「Iteration なし」の区画の落とし先の ID（Iteration の ID と重ならない） */
const NO_SECTION = "-";

function Section({
  section: { iteration: it, tickets },
  rowEnd,
}: {
  section: BacklogSection;
  /** サイドバーの行の右端（TicketTable の end） */
  rowEnd: (t: Ticket, priority: ReactNode) => ReactNode;
}) {
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
  // 2 段目に状態・月日の期間・目標を 1 行で（目標が溢れたら省略してツールチップで全文。カンバンと同じ）。開始・閉じるは置かず、詳細の画面で行う。
  // 0 件の区画は帯も 2 段目もない 1 行にし、「Iteration なし」は行の右端の「+」で作る
  const period = it ? shortPeriod(it.start, it.end) : undefined;
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
        <span className="head-line sub muted">
          <span className={`state iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
          {period ? <span className="period">{period}</span> : null}
          {it.goal ? (
            <span className="goal" title={it.goal}>
              {it.goal}
            </span>
          ) : null}
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
      {tickets.length > 0 ? (
        <TicketTable tickets={tickets} draggable priorityMarks assigneeInEnd rowMenu end={rowEnd} />
      ) : null}
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
 * サイドバーでは EpicChips を出す
 */
function EpicPanel({ selected, onSelect }: { selected: string; onSelect: (epic: string) => void }) {
  const host = useHost();
  if (host.surface === "sidebar") return <EpicChips selected={selected} onSelect={onSelect} />;
  return <EpicList selected={selected} onSelect={onSelect} />;
}

function useOpenEpics() {
  const store = useStore();
  const epics = useMemo(
    () => store.epics.filter((e) => e.status === "open").sort(byNumber),
    [store.epics],
  );
  const noEpic = store.tickets.filter(
    (t) => !t.epic && t.status !== "done" && t.status !== "abandoned",
  ).length;
  return { epics, noEpic };
}

/**
 * サイドバーの Epic の欄：open の Epic があるときだけ、番号・題・進捗のチップと「Epic なし」のチップを並べる。
 * 押すとその Epic で絞り、もう一度押すと外れる。2 行を超える分は「ほか N」にまとめる
 */
function EpicChips({ selected, onSelect }: { selected: string; onSelect: (epic: string) => void }) {
  const { epics, noEpic } = useOpenEpics();
  if (epics.length === 0) return null;
  return (
    <div className="epic-chips">
      <span className="chip-label">Epic</span>
      <ChipRow
        label="Epic で絞る"
        contentKey={
          epics.map((e) => `${e.id}:${e.title}:${e.progress.done}/${e.progress.total}`).join("|") +
          `|${noEpic}`
        }
        moreLabel={(n) => `Epic をあと ${n} 本出す`}
        lessLabel="Epic を畳む"
      >
        {epics.map((e) => (
          <Chip
            key={e.id}
            className="epic-chip"
            pressed={selected === e.id}
            title={selected === e.id ? "絞り込みを外す" : `${e.id} ${e.title} で絞る`}
            onClick={() => onSelect(e.id)}
          >
            <code>{e.id}</code>
            <span className="chip-title">{e.title}</span>
            <ProgressBar progress={e.progress} short />
          </Chip>
        ))}
        <Chip
          key={NO_EPIC}
          className="epic-chip loose"
          pressed={selected === NO_EPIC}
          title={selected === NO_EPIC ? "絞り込みを外す" : "Epic のないチケットで絞る"}
          onClick={() => onSelect(NO_EPIC)}
        >
          Epic なし
          <span className="chip-count">{noEpic}</span>
        </Chip>
      </ChipRow>
    </div>
  );
}

/** 広い画面の Epic の欄。番号はハッシュの遷移で詳細へ（エディタのパネルはバックログを出さない） */
function EpicList({ selected, onSelect }: { selected: string; onSelect: (epic: string) => void }) {
  const store = useStore();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const { epics, noEpic } = useOpenEpics();
  const create = async () => {
    if (!title.trim() || !store.project) return;
    const r = await store.run("epic.create", { title: title.trim(), project: store.project.id });
    if (r.ok) {
      setTitle("");
      setCreating(false);
    }
  };
  const startCreating = () => setCreating(true);

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
            <a href={hrefOf({ page: "epics", id: e.id })}>
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
        <li className={selected === NO_EPIC ? "selected" : undefined}>
          <span />
          <button
            type="button"
            className="epic-pick"
            aria-pressed={selected === NO_EPIC}
            title={selected === NO_EPIC ? "絞り込みを解除する" : "Epic のないチケットで絞る"}
            onClick={() => onSelect(NO_EPIC)}
          >
            <span className="row-title muted">Epic なし</span>
            <span className="muted">{noEpic} 件</span>
          </button>
        </li>
      </ul>
    </>
  );

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
