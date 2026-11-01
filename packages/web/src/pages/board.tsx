// カンバン（UI-2）。絞り込みの欄（Iteration・Epic・担当者）、選んだ Iteration の見出し、
// その Iteration のチケットを状態ごとの節（todo / in_progress / review / done。中止は畳んだ節）で出す。
// Iteration の選択肢は planned と active と「Iteration なし」、Epic の選択肢は open だけ。
// Iteration が 1 つもない Project では Iteration で絞らず、全チケットのカンバンにする。絞り込みの値はハッシュに持つ。
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
import { DraggableRow, PriorityBadge, StatusDot, Tags, TicketLink } from "../components/parts.js";
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
  type Status,
  type Ticket,
} from "../types.js";
import { IterationActions, IterationCreateForm } from "./iterations.js";

/** 選んでいるもの。all は Iteration のない Project（Iteration で絞らない） */
type Selection = { kind: "all" } | { kind: "none" } | { kind: "iteration"; iteration: Iteration };

export function BoardPage({ query }: { query: BoardQuery }) {
  const store = useStore();
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

  const onDragEnd = async (event: DragEndEvent) => {
    const id = String(event.active.id);
    const status = event.over?.id as Status | undefined;
    const ticket = store.tickets.find((t) => t.id === id);
    if (!status || !ticket || ticket.status === status) return;
    setMoving({ id, status });
    await store.run("ticket.move", { ticket: id, status });
    setMoving(null);
  };

  return (
    <section>
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
        <span className="muted count">{tickets.length - abandoned.length} 件</span>
      </div>
      {creating ? (
        <div className="board-filters">
          <IterationCreateForm onDone={() => setCreating(false)} />
        </div>
      ) : null}
      {selection.kind === "iteration" ? <IterationHead iteration={selection.iteration} /> : null}
      <DndContext sensors={sensors} onDragEnd={(e) => void onDragEnd(e)}>
        <div className="board">
          {BOARD_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tickets={tickets.filter((t) => t.status === status)}
              // 完了は既定で畳む（どの surface でも。開いた状態は useUiState が保つ）
              defaultOpen={status !== "done"}
            />
          ))}
          {/* 中止は切り替えではなく、あるときだけ最後の列（サイドバーでは最後の節）に畳んで置く */}
          {abandoned.length > 0 ? (
            <Column status="abandoned" tickets={abandoned} defaultOpen={false} />
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

/**
 * 状態ごとの節。広い画面では横に並び、サイドバーでは縦に積む（UI-12）。開閉は host.state に覚える。
 * 見出しに状態の丸印と件数、空なら破線の枠
 */
function Column({
  status,
  tickets,
  defaultOpen,
}: {
  status: Status;
  tickets: Ticket[];
  defaultOpen: boolean;
}) {
  const store = useStore();
  const host = useHost();
  const [open, setOpen] = useUiState(`board.section.${status}`, defaultOpen);
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const sidebar = host.surface === "sidebar";
  return (
    <details
      ref={setNodeRef}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`column fold status-${status}${isOver ? " over" : ""}`}
      data-status={status}
    >
      <summary>
        <h2>
          <StatusDot status={status} />
          <span>{store.labelOf(status)}</span>
          <span className="muted">{tickets.length}</span>
        </h2>
      </summary>
      {sidebar && tickets.length === 0 ? <p className="empty">なし</p> : null}
      {sidebar ? (
        <div className="rows">
          {tickets.map((t) => (
            <DraggableRow key={t.id} ticket={t} />
          ))}
        </div>
      ) : (
        <div className="cards">
          {tickets.map((t) => (
            <Card key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </details>
  );
}

function Card({ ticket }: { ticket: Ticket }) {
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
