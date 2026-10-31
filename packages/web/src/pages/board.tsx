// カンバン（UI-2）。列は todo / in_progress / review / done。abandoned は切り替えで出す。
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
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { PriorityBadge, StatusDot, Tags, TicketLink, TicketRow } from "../components/parts.js";
import { useHost } from "../host.js";
import { navigate } from "../router.js";
import { useStore } from "../store.js";
import { BOARD_STATUSES, byPriorityThenNumber, type Status, type Ticket } from "../types.js";

export function BoardPage({ epic }: { epic?: string | undefined }) {
  const store = useStore();
  const [showAbandoned, setShowAbandoned] = useState(false);
  // 読み直しが終わるまでの間だけ、落とした先の列に見せる
  const [moving, setMoving] = useState<{ id: string; status: Status } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const columns: readonly Status[] = showAbandoned
    ? [...BOARD_STATUSES, "abandoned"]
    : BOARD_STATUSES;
  const tickets = useMemo(
    () =>
      store.tickets
        .filter((t) => !epic || t.epic === epic)
        .map((t) => (moving && moving.id === t.id ? { ...t, status: moving.status } : t))
        .sort(byPriorityThenNumber),
    [store.tickets, epic, moving],
  );

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
      <div className="toolbar">
        <h1>カンバン</h1>
        <label>
          Epic
          <select
            value={epic ?? ""}
            onChange={(e) => navigate({ page: "board", epic: e.target.value || undefined })}
          >
            <option value="">すべて</option>
            {store.epics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} {e.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showAbandoned}
            onChange={(e) => setShowAbandoned(e.target.checked)}
          />
          abandoned を出す
        </label>
      </div>
      <DndContext sensors={sensors} onDragEnd={(e) => void onDragEnd(e)}>
        <div className="board">
          {columns.map((status) => (
            <Column
              key={status}
              status={status}
              tickets={tickets.filter((t) => t.status === status)}
            />
          ))}
        </div>
      </DndContext>
    </section>
  );
}

/**
 * 列。広い画面では横に並び、サイドバーでは縦に積んで折りたためる（UI-12）。
 * 見出しに状態の丸印と件数、空なら破線の枠
 */
function Column({ status, tickets }: { status: Status; tickets: Ticket[] }) {
  const store = useStore();
  const host = useHost();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const sidebar = host.surface === "sidebar";
  return (
    <details
      ref={setNodeRef}
      open
      className={`column status-${status}${isOver ? " over" : ""}`}
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
        tickets.map((t) => <Card key={t.id} ticket={t} />)
      )}
    </details>
  );
}

/** 1 行のチケット。行全体をつかんで動かし、動かした直後の click では開かない */
function DraggableRow({ ticket }: { ticket: Ticket }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
  });
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!dragged.current) return;
    dragged.current = false;
    e.preventDefault();
  };
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`row-drag${isDragging ? " dragging" : ""}`}
      {...listeners}
      {...attributes}
    >
      <TicketRow ticket={ticket} onClick={onClick} />
    </div>
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
      {ticket.claimed_by ? <div className="meta">{ticket.claimed_by}</div> : null}
    </article>
  );
}
