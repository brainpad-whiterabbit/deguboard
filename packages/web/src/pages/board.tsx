// カンバン（UI-2）。絞り込みの欄（Iteration・Epic・担当者）、選んだ Iteration の見出し、
// その Iteration のチケットを含む Plan の帯（実行計画）と、その Iteration のチケットを状態ごとの節（todo / in_progress / review / done。中止は畳んだ節）で出す。
// Iteration の選択肢は planned と active と「Iteration なし」、Epic の選択肢は open だけ。
// Iteration が 1 つもない Project では Iteration で絞らず、全チケットのカンバンにする。絞り込みの値はハッシュに持つ。
// VS Code の左パネル（surface=sidebar）では、Iteration を選択欄の代わりに札の列（なし・+ を含む）で切り替え、見出しを 2 段と進みの帯に詰め、
// 詳細・…・開始・閉じる・件数は出さない（件数は帯の done/全体）。Epic・担当の絞り込みは見出しの右端の漏斗で開き（開閉は host.state）、
// 絞っている間は見出しの下に値の札（× で外す）を出す。状態の節はペイン風の見出しにする。
// 左パネルの行は担当の名前の列を出さず、右端の上の段（Plan の番号の左）に担当の印（AssigneeMark。人は頭文字の丸、agent は持ち主の丸と汎用のアイコン）を出す。
// 左パネルの行の右端には、開いた Plan に入っているチケットなら Plan の番号と、todo なら着手可か待ちの相手（Plan の after とチケットの depends_on）か承認待ち（Plan が承認待ち）を出す。
// 待ちと承認待ちの行（実行中の Run がないもの）はタイトルを説明文の色で薄く出す。
// 左パネルの行の頭には、実行中の Run があるチケットなら回るリング（右端の下の段に「実行中」）を、実行中の Run のない in_progress なら止まった半分塗りの丸を出す。
// 入っている Iteration か Epic が閉じた done・abandoned のチケットは出さない（履歴でたどる）。
// 節の開閉・最後に選んだ Iteration は host.state に覚える。
// ドラッグ＆ドロップは ticket.move を呼び、拒否されたら通知に理由を出して元の列に戻す（読み直すだけで戻る）

import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityMark,
  DraggableRow,
  PriorityBadge,
  RowPriority,
  type RowActivity,
  StatusBand,
  StatusDot,
  Tags,
  TicketLink,
} from "../components/parts.js";
import { AssigneeMark } from "../components/assignee-mark.js";
import { PlanBand } from "../components/plan-band.js";
import {
  openPlanByTicket,
  planColor,
  planGraph,
  remainingWaits,
} from "../components/plan-graph.js";
import { useChangeFlash } from "../components/change-flash.js";
import { useHost, useUiState } from "../host.js";
import { hrefOf, navigate, NO_ITERATION, type BoardQuery } from "../router.js";
import { useStore } from "../store.js";
import {
  BOARD_STATUSES,
  byNumber,
  byPriorityThenNumber,
  claimOptions,
  matchesClaim,
  actorLabel,
  isFinished,
  isOwnAssignee,
  ITERATION_LABELS,
  NO_CLAIM,
  type Epic,
  type Iteration,
  type PlanRow,
  type Progress,
  type Status,
  type Ticket,
  type TicketRow,
  type WhoamiView,
} from "../types.js";
import { IterationActions, IterationCreateForm } from "./iterations.js";

/** 選んでいるもの。all は Iteration のない Project（Iteration で絞らない） */
type Selection = { kind: "all" } | { kind: "none" } | { kind: "iteration"; iteration: Iteration };

export function BoardPage({ query }: { query: BoardQuery }) {
  const store = useStore();
  const host = useHost();
  // 読み直しが終わるまでの間だけ、落とした先の列に見せる
  const [moving, setMoving] = useState<{ id: string; status: Status } | null>(null);
  const [lastIteration, setLastIteration] = useUiState<string | undefined>(
    "board.iteration",
    undefined,
  );
  const [creating, setCreating] = useState(false);
  // 左パネルの絞り込みの欄（Epic・担当）を開いているか
  const [filtersOpen, setFiltersOpen] = useUiState("board.filters", false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const open = useMemo(
    () => store.iterations.filter((i) => i.status !== "closed").sort(byNumber),
    [store.iterations],
  );
  const selection = useMemo<Selection>(() => {
    if (open.length === 0) return { kind: "all" };
    if (query.iteration === NO_ITERATION) return { kind: "none" };
    const pick =
      open.find((i) => i.id === query.iteration) ??
      open.find((i) => i.id === lastIteration) ??
      open.find((i) => i.status === "active") ??
      open[0]!;
    return { kind: "iteration", iteration: pick };
  }, [open, query.iteration, lastIteration]);

  const select = (iteration: string) => {
    setLastIteration(iteration === NO_ITERATION ? undefined : iteration);
    // 担当者は Iteration ごとに顔ぶれが変わるので外す。Epic は残す
    navigate({ page: "board", iteration, epic: query.epic });
  };
  const setFilter = (patch: Partial<BoardQuery>) =>
    navigate({
      page: "board",
      iteration: query.iteration,
      epic: query.epic,
      assignee: query.assignee,
      ...patch,
    });

  const scoped = useMemo(() => {
    const inScope = (t: Ticket) =>
      selection.kind === "all"
        ? true
        : selection.kind === "none"
          ? !t.iteration
          : t.iteration === selection.iteration.id;
    return store.tickets.filter(inScope);
  }, [store.tickets, selection]);
  // 閉じた Epic は出さない。Epic の詳細から閉じた Epic で開いたときは、選んでいるものだけ残す
  const epics = useMemo(
    () => store.epics.filter((e) => e.status === "open" || e.id === query.epic),
    [store.epics, query.epic],
  );
  const claims = useMemo(() => claimOptions(scoped), [scoped]);
  const tickets = useMemo(
    () =>
      hideClosedFinished(scoped, store.iterations, store.epics, query.epic)
        .filter((t) => !query.epic || t.epic === query.epic)
        .filter((t) => matchesClaim(t, query.assignee ?? ""))
        .map((t) => (moving && moving.id === t.id ? { ...t, status: moving.status } : t))
        .sort(byPriorityThenNumber),
    [scoped, store.iterations, store.epics, query.epic, query.assignee, moving],
  );
  const chipTickets = useMemo(
    () => hideClosedFinished(store.tickets, store.iterations, store.epics),
    [store.tickets, store.iterations, store.epics],
  );
  const abandoned = tickets.filter((t) => t.status === "abandoned");
  const planOf = useMemo(() => openPlanByTicket(store.plans), [store.plans]);
  const planMarks = useMemo(
    () => kanbanPlanMarks(store.plans, store.tickets, planOf),
    [store.plans, store.tickets, planOf],
  );

  // サイドバーでは、前回の描画から Status か Iteration が変わった行を点滅させる（UI-2。CLI やエージェントの書き込みに気づけるように）
  const sidebar = host.surface === "sidebar";
  const flash = useChangeFlash(store.tickets, host.state, sidebar);

  const onDragEnd = async (event: DragEndEvent) => {
    const id = String(event.active.id);
    const status = event.over?.id as Status | undefined;
    const ticket = store.tickets.find((t) => t.id === id);
    if (!status || !ticket || ticket.status === status) return;
    setMoving({ id, status });
    // 自分で動かした行は点滅させない
    flash.ignore(id);
    const result = await store.run("ticket.move", { ticket: id, status });
    if (!result.ok) flash.release(id);
    setMoving(null);
  };

  const filterSelects = (
    <>
      {epics.length > 0 ? (
        <label>
          Epic
          <select
            value={query.epic ?? ""}
            onChange={(e) => setFilter({ epic: e.target.value || undefined })}
          >
            <option value="">すべて</option>
            {epics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} {e.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {claims.length > 0 ? (
        <label>
          担当
          <select
            value={query.assignee ?? ""}
            onChange={(e) => setFilter({ assignee: e.target.value || undefined })}
          >
            <option value="">すべて</option>
            {claims.map((c) => (
              <option key={c} value={c} title={c}>
                {c === NO_CLAIM ? "なし" : actorLabel(c)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
  const createForm = creating ? (
    <div className="board-filters">
      <IterationCreateForm onDone={() => setCreating(false)} />
    </div>
  ) : null;

  return (
    <section>
      {sidebar ? (
        <>
          {/* 左パネルは見出しを 2 段と進みの帯に詰め、詳細・操作は出さない（Iteration の開始は `dg guide work` の手順が claim のときに行い、閉じるはバックログの区画の「…」と詳細から行う） */}
          <SidebarBoardHead
            open={open}
            // 札は閉じた Iteration・Epic の終わったチケットを除いて数え、Epic・担当の絞り込みでは変えない
            tickets={chipTickets}
            selection={selection}
            // 帯は絞り込み（Epic・担当）の後のチケットで数える
            progress={ticketProgress(tickets)}
            onSelect={select}
            onCreate={() => setCreating(true)}
            filter={
              epics.length > 0 || claims.length > 0
                ? {
                    open: filtersOpen,
                    active: !!query.epic || !!query.assignee,
                    onToggle: () => setFiltersOpen(!filtersOpen),
                  }
                : undefined
            }
          />
          {createForm}
          {filtersOpen && (epics.length > 0 || claims.length > 0) ? (
            <div className="board-filters compact" id="board-filters">
              {filterSelects}
            </div>
          ) : null}
          <FilterChips
            epic={query.epic ? store.epics.find((e) => e.id === query.epic) : undefined}
            epicId={query.epic}
            assignee={query.assignee}
            onClear={setFilter}
          />
        </>
      ) : (
        <>
          <div className="board-filters">
            {selection.kind === "all" ? (
              <span className="muted">Iteration はない</span>
            ) : (
              <label>
                Iteration
                <select
                  value={selection.kind === "none" ? NO_ITERATION : selection.iteration.id}
                  onChange={(e) => select(e.target.value)}
                >
                  {open.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} {i.name}（{ITERATION_LABELS[i.status]}）
                    </option>
                  ))}
                  <option value={NO_ITERATION}>Iteration なし</option>
                </select>
              </label>
            )}
            {creating ? null : (
              <button type="button" className="link" onClick={() => setCreating(true)}>
                + Iteration を作る
              </button>
            )}
            {filterSelects}
            <span className="muted count">{tickets.length - abandoned.length} 件</span>
          </div>
          {createForm}
          {selection.kind === "iteration" ? (
            <IterationHead iteration={selection.iteration} />
          ) : null}
        </>
      )}
      <PlanBand scope={scoped} />
      <DndContext sensors={sensors} onDragEnd={(e) => void onDragEnd(e)}>
        <div className="board">
          {BOARD_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tickets={tickets.filter((t) => t.status === status)}
              planOf={planOf}
              planMarks={planMarks}
              flashing={flash.flashing}
              // 完了は既定で畳む（どの surface でも。開いた状態は useUiState が保つ）
              defaultOpen={status !== "done"}
            />
          ))}
          {/* 中止は切り替えではなく、あるときだけ最後の列（サイドバーでは最後の節）に畳んで置く */}
          {abandoned.length > 0 ? (
            <Column
              status="abandoned"
              tickets={abandoned}
              planOf={planOf}
              planMarks={planMarks}
              flashing={flash.flashing}
              defaultOpen={false}
            />
          ) : null}
        </div>
      </DndContext>
    </section>
  );
}

/**
 * 入っている Iteration か Epic のどちらかが closed の done・abandoned のチケットを除く。
 * 終わっていないチケットは Epic が閉じていても残す。絞り込みで選んだ Epic（epic）のチケットは除かない
 */
export function hideClosedFinished<T extends Ticket>(
  tickets: T[],
  iterations: Pick<Iteration, "id" | "status">[],
  epics: Pick<Epic, "id" | "status">[],
  epic?: string,
): T[] {
  const closedIterations = new Set(
    iterations.filter((i) => i.status === "closed").map((i) => i.id),
  );
  const closedEpics = new Set(epics.filter((e) => e.status === "closed").map((e) => e.id));
  return tickets.filter(
    (t) =>
      (t.status !== "done" && t.status !== "abandoned") ||
      (!!epic && t.epic === epic) ||
      !((t.iteration && closedIterations.has(t.iteration)) || (t.epic && closedEpics.has(t.epic))),
  );
}

/** 選んだ Iteration の見出し：番号・名前・状態・期間・目標と、開始・終了・詳細 */
function IterationHead({ iteration: it }: { iteration: Iteration }) {
  return (
    <header className="board-head">
      <h1>
        <code>{it.id}</code> {it.name}
      </h1>
      <span className={`badge iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
      {it.start || it.end ? (
        <span className="muted">
          {it.start ?? "?"} 〜 {it.end ?? "?"}
        </span>
      ) : null}
      {it.goal ? <span className="muted goal">{it.goal}</span> : null}
      <span className="actions">
        <a href={hrefOf({ page: "iterations", id: it.id })}>詳細</a>
        <IterationActions iteration={it} />
      </span>
    </header>
  );
}

/**
 * 左パネルのカンバンの見出し（UI-2）。1 段目に Iteration の札の列（IterationChips）と右端の絞り込みボタン（漏斗）、
 * 2 段目に選んでいるものの名前・期間・目標（1 行で省略）、3 段目に状態ごとの色の帯と「n/m done」（件数はここだけ）。
 * 詳細・…・開始・閉じるは出さない。
 * filter は絞り込める Epic か担当があるときだけ渡す（漏斗を出す）。絞っている間は漏斗を色付きにする
 */
function SidebarBoardHead({
  open,
  tickets,
  selection,
  progress,
  onSelect,
  onCreate,
  filter,
}: {
  open: Iteration[];
  /** 札の進みと「なし n」を数えるチケット。閉じた Iteration・Epic の終わったチケットを除き（hideClosedFinished）、Epic・担当の絞り込みとは関係なく一定 */
  tickets: readonly Ticket[];
  selection: Selection;
  progress: Progress;
  onSelect: (iteration: string) => void;
  onCreate: () => void;
  filter: { open: boolean; active: boolean; onToggle: () => void } | undefined;
}) {
  const it = selection.kind === "iteration" ? selection.iteration : undefined;
  const name = it ? it.name : selection.kind === "none" ? "Iteration なし" : "Iteration はない";
  const period = it ? shortPeriod(it.start, it.end) : undefined;
  return (
    <header className="board-head sidebar-head">
      <div className="head-line">
        <IterationChips
          open={open}
          tickets={tickets}
          selection={selection}
          onSelect={onSelect}
          onCreate={onCreate}
        />
        {filter ? (
          <button
            type="button"
            className={`filter-toggle${filter.active ? " active" : ""}${filter.open ? " open" : ""}`}
            aria-label={filter.active ? "絞り込み（絞っている）" : "絞り込み"}
            title="Epic・担当で絞り込む"
            aria-expanded={filter.open}
            aria-controls={filter.open ? "board-filters" : undefined}
            onClick={filter.onToggle}
          >
            <FunnelIcon />
          </button>
        ) : null}
      </div>
      <div className="head-line sub muted">
        <span className="name">{name}</span>
        {period ? <span className="period">{period}</span> : null}
        {it?.goal ? (
          <span className="goal" title={it.goal}>
            {it.goal}
          </span>
        ) : null}
      </div>
      <div className="head-line">
        <StatusBand progress={progress} />
      </div>
    </header>
  );
}

/**
 * 左パネルの Iteration の札の列（UI-2）。planned と active の Iteration を番号順に並べ、最後に「なし n」（Iteration に入っていない
 * 終わっていないチケットの数）と「+」（Iteration を作る）を置く。札は番号・進みの輪・done/全体で、選んでいる札は塗り、
 * active は実線、planned は破線の枠。名前・期間・目標はツールチップで読む。
 * 幅に入らなければ列だけが横にスクロールし、選んでいる札が見える位置まで寄せる。Iteration のない Project では「+」だけ
 */
function IterationChips({
  open,
  tickets,
  selection,
  onSelect,
  onCreate,
}: {
  open: Iteration[];
  tickets: readonly Ticket[];
  selection: Selection;
  onSelect: (iteration: string) => void;
  onCreate: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const selected =
    selection.kind === "iteration"
      ? selection.iteration.id
      : selection.kind === "none"
        ? NO_ITERATION
        : undefined;
  // 選んでいる札が列の見える範囲から外れていたら、列だけを横にスクロールして寄せる（scrollIntoView は画面ごと動かすので使わない）
  useLayoutEffect(() => {
    const el = strip.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip) return;
    // 列は position: relative なので、offsetLeft は列の左端からの位置
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [selected, open.length]);
  const loose = tickets.filter(
    (t) => !t.iteration && t.status !== "done" && t.status !== "abandoned",
  ).length;
  return (
    <div className="iteration-chips" role="group" aria-label="Iteration" ref={strip}>
      {open.map((i) => {
        const progress = ticketProgress(tickets.filter((t) => t.iteration === i.id));
        const period = i.start || i.end ? `\n期間 ${i.start ?? "?"} 〜 ${i.end ?? "?"}` : "";
        const goal = i.goal ? `\n目標 ${i.goal}` : "";
        return (
          <button
            key={i.id}
            type="button"
            className={`iteration-chip ${i.status}`}
            aria-pressed={selected === i.id}
            title={`${i.id} ${i.name}（${ITERATION_LABELS[i.status]}）${period}${goal}`}
            onClick={() => onSelect(i.id)}
          >
            <code>{i.id}</code>
            <ProgressRing progress={progress} />
            <span className="chip-count">
              {progress.done}/{progress.total}
            </span>
          </button>
        );
      })}
      {selection.kind === "all" ? null : (
        <button
          type="button"
          className="iteration-chip loose"
          aria-pressed={selected === NO_ITERATION}
          title={`Iteration なし（終わっていないチケット ${loose} 件）`}
          onClick={() => onSelect(NO_ITERATION)}
        >
          なし {loose}
        </button>
      )}
      <button
        type="button"
        className="iteration-chip create"
        aria-label="Iteration を作る"
        title="Iteration を作る"
        onClick={onCreate}
      >
        +
      </button>
    </div>
  );
}

/** 札の進みの小さな輪（done/全体の割合だけ線を引く）。全体が 0 なら輪の下地だけ */
function ProgressRing({ progress }: { progress: Progress }) {
  const r = 4.5;
  const length = 2 * Math.PI * r;
  const ratio = progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <svg className="ring" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth="2"
      />
      {ratio > 0 ? (
        <circle
          cx="6"
          cy="6"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${length * ratio} ${length}`}
          transform="rotate(-90 6 6)"
        />
      ) : null}
    </svg>
  );
}

/** 絞り込みの漏斗の印。線は currentColor で、絞っている間は CSS で中を塗る（.filter-toggle.active） */
function FunnelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"
        fill="currentColor"
        fillOpacity={0}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 左パネルのカンバンで絞っている値の札（例「担当 eiki/agent ×」）。× で外す。絞っていなければ何も出さない。
 * Epic は番号を出し、題はツールチップで読む
 */
function FilterChips({
  epic,
  epicId,
  assignee,
  onClear,
}: {
  epic: Epic | undefined;
  epicId: string | undefined;
  assignee: string | undefined;
  onClear: (patch: Partial<BoardQuery>) => void;
}) {
  if (!epicId && !assignee) return null;
  const who = assignee === NO_CLAIM ? "なし" : assignee ? actorLabel(assignee) : "";
  return (
    <div className="filter-chips">
      {epicId ? (
        <span className="filter-chip" title={epic ? `${epic.id} ${epic.title}` : epicId}>
          <span className="filter-chip-text">Epic {epicId}</span>
          <button
            type="button"
            aria-label={`Epic ${epicId} の絞り込みを外す`}
            onClick={() => onClear({ epic: undefined })}
          >
            ×
          </button>
        </span>
      ) : null}
      {assignee ? (
        <span className="filter-chip" title={assignee === NO_CLAIM ? "担当なし" : assignee}>
          <span className="filter-chip-text">担当 {who}</span>
          <button
            type="button"
            aria-label={`担当 ${who} の絞り込みを外す`}
            onClick={() => onClear({ assignee: undefined })}
          >
            ×
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** 見出しに出す期間を短くする（2026-11-15 と 2026-11-28 → 11/15–11/28）。どちらもなければ undefined */
export function shortPeriod(start?: string, end?: string): string | undefined {
  if (!start && !end) return undefined;
  const md = (d: string | undefined) => {
    const m = d ? /^\d{4}-(\d{2})-(\d{2})/.exec(d) : null;
    return m ? `${Number(m[1])}/${Number(m[2])}` : (d ?? "?");
  };
  return `${md(start)}–${md(end)}`;
}

/**
 * カンバンに出ているチケットの進み。数え方は core の progressOf（EP-3）の写しで、同じ結果になることを board.test.ts で確かめる
 * （web は core の実行時のコードを取り込まない。ADR-007）
 */
export function ticketProgress(tickets: readonly Pick<Ticket, "status">[]): Progress {
  const by_status: Record<Status, number> = {
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    abandoned: 0,
  };
  for (const t of tickets) by_status[t.status] += 1;
  return {
    total: tickets.length - by_status.abandoned,
    done: by_status.done,
    by_status,
  };
}

/**
 * 状態ごとの節。広い画面では横に並び、サイドバーでは縦に積む（UI-12）。開閉は host.state に覚える。
 * 見出しに状態の丸印と件数。サイドバーでは枠と背景のないペイン風の見出しで、空の節は見出しの 1 行だけにする。
 * サイドバーの件数は、終わった状態（isFinished）の節では塗らずに数字だけにする
 * （ドロップ先は details 全体なので、空の節の見出しにも落とせる）
 */
function Column({
  status,
  tickets,
  planOf,
  planMarks,
  flashing,
  defaultOpen,
}: {
  status: Status;
  tickets: TicketRow[];
  /** チケットが入っている開いた Plan の ID */
  planOf: ReadonlyMap<string, string>;
  /** 左パネルの行の右端に出す Plan の番号と待ち（kanbanPlanMarks） */
  planMarks: ReadonlyMap<string, PlanMark>;
  /** 点滅させるチケット（サイドバー） */
  flashing: ReadonlySet<string>;
  defaultOpen: boolean;
}) {
  const store = useStore();
  const host = useHost();
  const [open, setOpen] = useUiState(`board.section.${status}`, defaultOpen);
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const sidebar = host.surface === "sidebar";
  const empty = tickets.length === 0;
  return (
    <details
      ref={setNodeRef}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`column fold status-${status}${empty ? " is-empty" : ""}${isOver ? " over" : ""}`}
      data-status={status}
    >
      <summary>
        <h2>
          <StatusDot status={status} />
          <span>{store.labelOf(status)}</span>
          <span
            className={sidebar ? `section-count${isFinished(status) ? " is-plain" : ""}` : "muted"}
          >
            {tickets.length}
          </span>
        </h2>
      </summary>
      {sidebar ? (
        empty ? null : (
          <div className="rows">
            {tickets.map((t) => {
              const mark = planMarks.get(t.id);
              const activity = rowActivity(t, store.runningTickets);
              const running = activity === "running";
              return (
                <DraggableRow
                  key={t.id}
                  ticket={t}
                  dimmed={!running && isWaitingReadiness(kanbanReadiness(t, mark))}
                  flash={flashing.has(t.id)}
                  variant="kanban"
                  head={activity ? <ActivityMark activity={activity} /> : undefined}
                  end={
                    mark || running || t.assignee ? (
                      <KanbanRowEnd ticket={t} mark={mark} running={running} />
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )
      ) : (
        <div className="cards">
          {tickets.map((t) => (
            <Card key={t.id} ticket={t} plan={planOf.get(t.id)} />
          ))}
        </div>
      )}
    </details>
  );
}

/** 左パネルのカンバンとバックログの行に出す、チケットが入っている開いた Plan と、残っている待ちの相手 */
export interface PlanMark {
  plan: string;
  /** Plan が承認待ち（plan.status が pending）。todo の行は待ちの相手によらず「承認待ち」と出す */
  pending: boolean;
  /** 残っている待ちの相手（remainingWaits。Plan の after の待ちが先、depends_on が後）。空なら着手できる */
  waitingOn: string[];
}

/** 開いた Plan に入っているチケットごとの PlanMark。after の待ちは Plan ごとに planGraph で求め、depends_on の待ちは deps_done で決める（remainingWaits） */
export function kanbanPlanMarks(
  plans: readonly PlanRow[],
  tickets: readonly TicketRow[],
  planOf: ReadonlyMap<string, string> = openPlanByTicket(plans),
): Map<string, PlanMark> {
  // キーをチケットの ID の型（t の番号）のままにすると depends_on・after の文字列で引けないので、文字列に広げる
  const byId = new Map<string, TicketRow>(tickets.map((t) => [t.id, t]));
  const marks = new Map<string, PlanMark>();
  for (const plan of plans) {
    if (plan.status === "closed") continue;
    for (const node of planGraph(plan, byId).nodes) {
      if (planOf.get(node.id) !== plan.id) continue;
      marks.set(node.id, {
        plan: plan.id,
        pending: plan.status === "pending",
        waitingOn: remainingWaits(byId.get(node.id)!, node.waitingOn, byId),
      });
    }
  }
  return marks;
}

/**
 * 左パネルのカンバンの行の頭の印：実行中の Run があれば running（Status によらない）、なければ in_progress だけ idle、ほかは出さない。
 * 実行中の Run を読み終えるまで（null）は出さない（開いた直後に実行中のチケットへ反対の意味の idle を出さないように）
 */
export function rowActivity(
  ticket: Pick<Ticket, "id" | "status">,
  runningTickets: ReadonlySet<string> | null,
): RowActivity | undefined {
  if (!runningTickets) return undefined;
  if (runningTickets.has(ticket.id)) return "running";
  return ticket.status === "in_progress" ? "idle" : undefined;
}

/** 待ちの相手の短い書き方：1 件なら「t137 待ち」、2 件以上なら先頭と残りの件数で「t137+1 待ち」、なければ空文字 */
export function waitLabel(waitingOn: readonly string[]): string {
  const [first, ...rest] = waitingOn;
  if (first === undefined) return "";
  return `${first}${rest.length > 0 ? `+${rest.length}` : ""} 待ち`;
}

/** 左パネルのカンバンとバックログの todo の行が着手できるか：承認待ち（Plan が承認待ち）・待ち（待ちの相手が残る）・着手可。開いた Plan に入っていない行と todo でない行は null */
export type KanbanReadiness = "pending" | "waiting" | "ready";

/** 行の右端の着手可・待ち・承認待ちと、タイトルを薄くするか（isWaitingReadiness）を同じ判定で決める */
export function kanbanReadiness(
  ticket: Pick<Ticket, "status">,
  mark: PlanMark | undefined,
): KanbanReadiness | null {
  if (!mark || ticket.status !== "todo") return null;
  if (mark.pending) return "pending";
  return mark.waitingOn.length === 0 ? "ready" : "waiting";
}

/** 承認待ちか待ちの行は、すぐには手を付けられないのでタイトルを説明文の色で薄く出す（UI-2。実行中の Run の例外は呼び出し側） */
export function isWaitingReadiness(readiness: KanbanReadiness | null): boolean {
  return readiness === "pending" || readiness === "waiting";
}

/**
 * 左パネルのカンバンの行の右端（開いた Plan に入っているか、実行中の Run があるか、担当のあるチケット）。縦に 2 段で、上に担当の印と Plan の番号を Plan の色で、
 * 下に実行中の Run があれば「実行中」（Plan の外の行でも）、なければ todo なら承認待ち（Plan が承認待ち）・
 * 待ちの相手（after と depends_on の終わっていないもの）・着手可、どれでもなければ優先度の印を出す。
 * 下の段に優先度の印でないものを出すときに優先度の印（high・low）もあれば、優先度の印を上の段の Plan の番号の左に寄せる
 */
function KanbanRowEnd({
  ticket,
  mark,
  running,
}: {
  ticket: TicketRow;
  mark: PlanMark | undefined;
  running: boolean;
}) {
  const readiness = planReadiness(ticket, mark);
  // 実行中の Run があれば、todo でも着手可・待ちより「実行中」を出す（手が動いていることの方が大事なので）
  const sub = running ? (
    <span className="row-running" title="このマシンで Run が実行中">
      実行中
    </span>
  ) : (
    readiness
  );
  const priority = <RowPriority priority={ticket.priority} variant="kanban" />;
  return (
    <span className="row-end">
      <span className="row-end-top">
        {sub ? priority : null}
        <AssigneeMark assignee={ticket.assignee} runAgent={ticket.run_agent} />
        {mark ? <RowPlan plan={mark.plan} /> : null}
      </span>
      <span className="row-end-sub">{sub ?? priority}</span>
    </span>
  );
}

/** 左パネルの行の Plan の番号（Plan の色） */
function RowPlan({ plan }: { plan: string }) {
  return (
    <span className={`row-plan plan-color-${planColor(plan)}`} title={`Plan ${plan}`}>
      {plan}
    </span>
  );
}

/** 左パネルの行の着手可・待ちの相手・承認待ち（kanbanReadiness で 1 回だけ判定する）。開いた Plan に入っていない行と todo でない行は null */
function planReadiness(ticket: Pick<Ticket, "status">, mark: PlanMark | undefined): ReactNode {
  const state = kanbanReadiness(ticket, mark);
  if (!mark || state === null) return null;
  if (state === "pending") {
    return (
      <span className="row-wait" title={`${mark.plan} は人の承認を待っている`}>
        承認待ち
      </span>
    );
  }
  if (state === "ready") return <span className="row-ready">着手可</span>;
  return (
    <span className="row-wait" title={`${mark.waitingOn.join("・")} を待っている`}>
      {waitLabel(mark.waitingOn)}
    </span>
  );
}

/**
 * 左パネルのバックログの行の右端（UI-3）：開いた Plan に入っていれば、カンバンの行と同じ部品で縦に 2 段、上に Plan の番号、
 * 下に todo なら着手可・待ちの相手・承認待ち（判定は kanbanPlanMarks と kanbanReadiness）。入っていなければ priority をそのまま出す。
 * 担当者が別の人なら、カンバンと同じ担当の印（頭文字の丸。全名はツールチップ）を上の段の Plan の番号の左に出す。
 * 自分か自分の agent（isOwnAssignee。core の whoami の own_ids）なら出さない。
 * priority は行の右端の優先度の印（左に優先度の印を出す区画では null。そのとき何も出さない行は空のセルで格子の位置を保つ）。
 * 下の段に着手可・待ちを出すときは、優先度の印を上の段の Plan の番号の左に寄せる
 */
export function BacklogRowEnd({
  ticket,
  mark,
  priority,
  me,
}: {
  /** 一覧の行（TicketRow）なら Run の agent（run_agent）で agent のアイコンを選ぶ */
  ticket: Pick<Ticket, "status" | "assignee"> & Partial<Pick<TicketRow, "run_agent">>;
  mark: PlanMark | undefined;
  priority: ReactNode;
  /** 操作している人（store.me）。分からなければ担当者をすべて別の人として出す */
  me: Pick<WhoamiView, "own_ids"> | null;
}) {
  const who =
    ticket.assignee && !isOwnAssignee(me, ticket.assignee) ? (
      <AssigneeMark assignee={ticket.assignee} runAgent={ticket.run_agent} />
    ) : null;
  if (!mark) {
    if (!who) return <>{priority ?? <span />}</>;
    return (
      <span className="row-end">
        <span className="row-end-top">
          {priority}
          {who}
        </span>
      </span>
    );
  }
  const readiness = planReadiness(ticket, mark);
  return (
    <span className="row-end">
      <span className="row-end-top">
        {readiness ? priority : null}
        {who}
        <RowPlan plan={mark.plan} />
      </span>
      <span className="row-end-sub">{readiness ?? priority}</span>
    </span>
  );
}

function Card({ ticket, plan }: { ticket: Ticket; plan: string | undefined }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`card status-${ticket.status}${isDragging ? " dragging" : ""}`}
      {...listeners}
      {...attributes}
    >
      <div className="meta">
        <TicketLink id={ticket.id} onPointerDown={(e) => e.stopPropagation()} />
        <PriorityBadge priority={ticket.priority} />
        {ticket.epic ? <span>{ticket.epic}</span> : null}
        {ticket.iteration ? <span>{ticket.iteration}</span> : null}
        {plan ? <span className={`plan-tag plan-color-${planColor(plan)}`}>{plan}</span> : null}
      </div>
      <div className="title">{ticket.title}</div>
      <Tags labels={ticket.labels} />
      {ticket.assignee ? (
        <div className="meta" title={ticket.assignee}>
          {actorLabel(ticket.assignee)}
        </div>
      ) : null}
    </article>
  );
}
