// カンバン（UI-2）。絞り込みの欄（Iteration・Epic・担当者）、選んだ Iteration の見出し、
// その Iteration のチケットを含む Plan の帯（実行計画）と、その Iteration のチケットを状態ごとの節（todo / in_progress / review / done。中止は畳んだ節）で出す。
// Iteration の選択肢は planned と active と「Iteration なし」、Epic の選択肢は open だけ。
// Iteration が 1 つもない Project では Iteration で絞らず、全チケットのカンバンにする。絞り込みの値はハッシュに持つ。
// VS Code の左パネル（surface=sidebar）では、見出しを 2 段と進みの帯に詰め（Iteration の選択欄に「+ Iteration を作る」を入れる）、
// 詳細・…・開始・閉じるは出さない。絞り込みは見出しの下の 1 行にし、状態の節はペイン風の見出しにする。
// 左パネルの行の右端には、開いた Plan に入っているチケットなら Plan の番号と、todo なら着手可か待ちの相手（Plan の after とチケットの depends_on）か承認待ち（Plan が承認待ち）を出す。
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
import { useMemo, useState } from "react";
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
  sameAssignee,
} from "../components/parts.js";
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
  ITERATION_LABELS,
  NO_CLAIM,
  type Epic,
  type Iteration,
  type PlanRow,
  type Progress,
  type Status,
  type Ticket,
  type TicketRow,
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
  const abandoned = tickets.filter((t) => t.status === "abandoned");
  // 見えている行の担当が 1 人だけなら、サイドバーの行に担当を出さない（同じ名前が全行に並ぶだけなので）
  const hideAssignee = sameAssignee(tickets);
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

  const count = tickets.length - abandoned.length;
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
            selection={selection}
            count={count}
            // 件数と帯は絞り込み（Epic・担当）の後のチケットで数える（件数と帯の数をそろえる）
            progress={ticketProgress(tickets)}
            onSelect={select}
            onCreate={() => setCreating(true)}
          />
          {createForm}
          {epics.length > 0 || claims.length > 0 ? (
            <div className="board-filters compact">{filterSelects}</div>
          ) : null}
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
            <span className="muted count">{count} 件</span>
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
              hideAssignee={hideAssignee}
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
              hideAssignee={hideAssignee}
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
export function hideClosedFinished(
  tickets: Ticket[],
  iterations: Pick<Iteration, "id" | "status">[],
  epics: Pick<Epic, "id" | "status">[],
  epic?: string,
): Ticket[] {
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

/** Iteration の選択欄で「+ Iteration を作る」を表す値（Iteration の ID とは重ならない） */
const CREATE_ITERATION = "+create";

/**
 * 左パネルのカンバンの見出し（UI-2）。1 段目に番号・名前（Iteration の選択欄）・状態・件数、2 段目に期間・目標（1 行で省略）、
 * 3 段目に状態ごとの色の帯と「n/m done」。「+ Iteration を作る」は選択欄の最後の選択肢。詳細・…・開始・閉じるは出さない
 */
function SidebarBoardHead({
  open,
  selection,
  count,
  progress,
  onSelect,
  onCreate,
}: {
  open: Iteration[];
  selection: Selection;
  count: number;
  progress: Progress;
  onSelect: (iteration: string) => void;
  onCreate: () => void;
}) {
  const it = selection.kind === "iteration" ? selection.iteration : undefined;
  const value =
    selection.kind === "iteration"
      ? selection.iteration.id
      : selection.kind === "none"
        ? NO_ITERATION
        : "";
  const name = it ? it.name : selection.kind === "none" ? "Iteration なし" : "Iteration はない";
  const period = it ? shortPeriod(it.start, it.end) : undefined;
  return (
    <header className="board-head sidebar-head">
      <div className="head-line">
        {it ? <code>{it.id}</code> : null}
        {/* 見えるのは名前と ▾ だけにし、透明なセレクトを重ねて押せるようにする（選択肢には番号と状態を出す） */}
        <span className="iteration-pick">
          <span className="name">{name}</span>
          <span className="caret" aria-hidden="true">
            ▾
          </span>
          <select
            aria-label="Iteration"
            value={value}
            onChange={(e) => {
              if (e.target.value === CREATE_ITERATION) onCreate();
              else onSelect(e.target.value);
            }}
          >
            {selection.kind === "all" ? (
              <option value="" disabled>
                Iteration はない
              </option>
            ) : null}
            {open.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} {i.name}（{ITERATION_LABELS[i.status]}）
              </option>
            ))}
            {selection.kind === "all" ? null : <option value={NO_ITERATION}>Iteration なし</option>}
            <option value={CREATE_ITERATION}>+ Iteration を作る</option>
          </select>
        </span>
        {it ? <span className="muted state">{ITERATION_LABELS[it.status]}</span> : null}
        <span className="muted count">{count} 件</span>
      </div>
      {period || it?.goal ? (
        <div className="head-line sub muted">
          {period ? <span className="period">{period}</span> : null}
          {it?.goal ? (
            <span className="goal" title={it.goal}>
              {it.goal}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="head-line">
        <StatusBand progress={progress} />
      </div>
    </header>
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
 * 見出しに状態の丸印と件数。サイドバーでは枠と背景のないペイン風の見出しで、空の節は見出しの 1 行だけにする
 * （ドロップ先は details 全体なので、空の節の見出しにも落とせる）
 */
function Column({
  status,
  tickets,
  planOf,
  planMarks,
  hideAssignee,
  flashing,
  defaultOpen,
}: {
  status: Status;
  tickets: Ticket[];
  /** チケットが入っている開いた Plan の ID */
  planOf: ReadonlyMap<string, string>;
  /** 左パネルの行の右端に出す Plan の番号と待ち（kanbanPlanMarks） */
  planMarks: ReadonlyMap<string, PlanMark>;
  /** サイドバーの行に担当を出さない */
  hideAssignee: boolean;
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
          <span className={sidebar ? "section-count" : "muted"}>{tickets.length}</span>
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
                  hideAssignee={hideAssignee}
                  flash={flashing.has(t.id)}
                  variant="kanban"
                  head={activity ? <ActivityMark activity={activity} /> : undefined}
                  end={
                    mark || running ? (
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

/** 左パネルのカンバンの行に出す、チケットが入っている開いた Plan と、残っている待ちの相手 */
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

/**
 * 左パネルのカンバンの行の右端（開いた Plan に入っているか、実行中の Run があるチケット）。縦に 2 段で、上に Plan の番号を Plan の色で、
 * 下に実行中の Run があれば「実行中」（Plan の外の行でも）、なければ todo なら承認待ち（Plan が承認待ち）・
 * 待ちの相手（after と depends_on の終わっていないもの）・着手可、どれでもなければ優先度の印を出す。
 * 下の段に優先度の印でないものを出すときに優先度の印（high・low）もあれば、優先度の印を上の段の Plan の番号の左に寄せる
 */
function KanbanRowEnd({
  ticket,
  mark,
  running,
}: {
  ticket: Ticket;
  mark: PlanMark | undefined;
  running: boolean;
}) {
  const readiness =
    !mark || ticket.status !== "todo" ? null : mark.pending ? (
      <span className="row-wait" title={`${mark.plan} は人の承認を待っている`}>
        承認待ち
      </span>
    ) : mark.waitingOn.length === 0 ? (
      <span className="row-ready">着手可</span>
    ) : (
      <span className="row-wait" title={`${mark.waitingOn.join("・")} を待っている`}>
        {waitLabel(mark.waitingOn)}
      </span>
    );
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
        {mark ? (
          <span
            className={`row-plan plan-color-${planColor(mark.plan)}`}
            title={`Plan ${mark.plan}`}
          >
            {mark.plan}
          </span>
        ) : null}
      </span>
      <span className="row-end-sub">{sub ?? priority}</span>
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
