// 小さな表示部品：チケットへのリンク、優先度・Status の印、ラベル、進捗、ドラッグできるチケットの行

import { useDraggable } from "@dnd-kit/core";
import {
  useEffect,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useHost } from "../host.js";
import { hrefOf, type Route } from "../router.js";
import { useStore } from "../store.js";
import {
  actorLabel,
  type EpicProgress,
  type Priority,
  type Status,
  type Ticket,
} from "../types.js";

/**
 * チケット詳細へのリンク。チケットへのリンクはすべてここを通す。
 * ブラウザではハッシュ遷移（App の followHashLink が受ける）、Webview では拡張ホストに頼んでエディタ領域に開く（UI-12）。
 * children を渡せば番号の代わりにそれを出す
 */
export function TicketLink({
  id,
  title,
  children,
  ...rest
}: {
  id: string;
  title?: string | undefined;
  children?: ReactNode;
} & Pick<
  ComponentProps<"a">,
  | "onPointerDown"
  | "className"
  | "onClick"
  | "style"
  | "onMouseEnter"
  | "onMouseLeave"
  | "onFocus"
  | "onBlur"
>) {
  const host = useHost();
  return (
    <a
      {...rest}
      href={hrefOf({ page: "ticket", id })}
      onClick={(e) => {
        // 呼び出し側が preventDefault したら（ドラッグ直後など）開かない
        rest.onClick?.(e);
        if (e.defaultPrevented || host.surface === "browser") return;
        e.preventDefault();
        host.open({ page: "ticket", id });
      }}
    >
      {children ?? (
        <>
          <code>{id}</code>
          {title ? ` ${title}` : ""}
        </>
      )}
    </a>
  );
}

/** Epic・Iteration などの詳細へのリンク。ブラウザではハッシュ遷移、Webview では拡張ホストに頼んでエディタ領域に開く */
export function DetailLink({ route, children }: { route: Route; children: ReactNode }) {
  const host = useHost();
  return (
    <a
      href={hrefOf(route)}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        host.open(route);
      }}
    >
      {children}
    </a>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge priority-${priority}`}>{priority}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  const store = useStore();
  return <span className={`badge status-${status}`}>{store.labelOf(status)}</span>;
}

export function Tags({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="tags">
      {labels.map((l) => (
        <span key={l} className="badge">
          {l}
        </span>
      ))}
    </span>
  );
}

/** 進捗バーに積む Status の順（done が左）。abandoned は total に入らないので出さない */
const PROGRESS_STATUSES = [
  "done",
  "review",
  "in_progress",
  "todo",
] as const satisfies readonly Status[];

/** Epic の進捗（done の件数 / abandoned を除く件数。EP-3）。Status ごとに積み上げ、色は --dg-status-* */
export function ProgressBar({ progress }: { progress: EpicProgress }) {
  const store = useStore();
  const segments = PROGRESS_STATUSES.map((s) => ({
    status: s,
    count: progress.by_status[s] ?? 0,
  })).filter((seg) => seg.count > 0);
  const title = segments.map((seg) => `${store.labelOf(seg.status)} ${seg.count}`).join(" / ");
  return (
    <span className="progress" title={title || "チケットはない"}>
      <span className="bar">
        {segments.map((seg) => (
          <span
            key={seg.status}
            className={`status-${seg.status}`}
            style={{ width: `${(seg.count / progress.total) * 100}%` }}
          />
        ))}
      </span>
      <span className="muted">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

/** 状態の丸印。色は --dg-status-* */
export function StatusDot({ status }: { status: Status }) {
  const store = useStore();
  return (
    <span className={`status-dot status-${status}`} role="img" aria-label={store.labelOf(status)} />
  );
}

/**
 * チケットの 1 行（サイドバー向け）：状態の丸印・番号・タイトル・担当者・優先度が high なら印。
 * サイドバーではタイトルを 2 行まで折り返す（styles.css）。hideAssignee で担当者を出さない（見えている行の担当が 1 人だけのとき）
 */
export function TicketRow({
  ticket,
  onClick,
  hideAssignee = false,
}: {
  ticket: Ticket;
  onClick?: ComponentProps<"a">["onClick"] | undefined;
  hideAssignee?: boolean | undefined;
}) {
  return (
    <TicketLink
      id={ticket.id}
      className={`row ticket-row status-${ticket.status}`}
      onClick={onClick}
    >
      <StatusDot status={ticket.status} />
      <code>{ticket.id}</code>
      <span className="row-title" title={ticket.title}>
        {ticket.title}
      </span>
      {ticket.assignee && !hideAssignee ? (
        <span className="row-assignee" title={ticket.assignee}>
          {actorLabel(ticket.assignee)}
        </span>
      ) : (
        <span />
      )}
      {ticket.priority === "high" ? <PriorityBadge priority="high" /> : <span />}
    </TicketLink>
  );
}

/**
 * チケットをドラッグできるようにする（@dnd-kit。id はチケットの ID）。動かした直後の click では詳細を開かない
 * （捕捉の段階で preventDefault し、TicketLink と App の followHashLink はそれを見て何もしない）
 */
export function useDraggableTicket(id: string) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return {
    ref: setNodeRef,
    style,
    isDragging,
    props: {
      ...listeners,
      ...attributes,
      onClickCapture: (e: MouseEvent) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.preventDefault();
      },
    },
  };
}

/**
 * 行のチケットの担当がすべて同じ 1 人か。そのときは行ごとに担当を出さない（TicketRow の hideAssignee）。
 * 担当のないチケットが混ざる・行がないときは false
 */
export function sameAssignee(tickets: readonly Pick<Ticket, "assignee">[]): boolean {
  const first = tickets[0]?.assignee;
  return !!first && tickets.every((t) => t.assignee === first);
}

/** 1 行のチケット（サイドバー）。行全体をつかんで動かす */
export function DraggableRow({
  ticket,
  hideAssignee,
}: {
  ticket: Ticket;
  hideAssignee?: boolean | undefined;
}) {
  const d = useDraggableTicket(ticket.id);
  return (
    <div
      ref={d.ref}
      style={d.style}
      className={`row-drag${d.isDragging ? " dragging" : ""}`}
      {...d.props}
    >
      <TicketRow ticket={ticket} hideAssignee={hideAssignee} />
    </div>
  );
}

/** 表の 1 行（広い画面）。行全体をつかんで動かす */
function DraggableTr({ ticket, children }: { ticket: Ticket; children: ReactNode }) {
  const d = useDraggableTicket(ticket.id);
  return (
    <tr
      ref={d.ref}
      style={d.style}
      className={`row-drag${d.isDragging ? " dragging" : ""}`}
      {...d.props}
    >
      {children}
    </tr>
  );
}

/**
 * チケットの一覧。広い画面では表、サイドバーでは 1 行ずつの並び。行の先頭のリンクで詳細へ。
 * draggable なら行をドラッグできる（外側に DndContext が要る）
 */
export function TicketTable({
  tickets,
  extra,
  draggable = false,
}: {
  tickets: readonly Ticket[];
  extra?: ((t: Ticket) => React.ReactNode) | undefined;
  draggable?: boolean;
}) {
  const store = useStore();
  const host = useHost();
  if (tickets.length === 0) return <p className="empty">該当するチケットはない</p>;
  if (host.surface === "sidebar") {
    return (
      <ul className="rows">
        {tickets.map((t) => (
          <li key={t.id}>
            {draggable ? <DraggableRow ticket={t} /> : <TicketRow ticket={t} />}
            {extra ? extra(t) : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <table className="list">
      <thead>
        <tr>
          <th>番号</th>
          <th>タイトル</th>
          <th>Status</th>
          <th>優先度</th>
          <th>Iteration</th>
          <th>Epic</th>
          <th>ラベル</th>
          {extra ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => {
          const cells = (
            <>
              <td>
                <TicketLink id={t.id} />
              </td>
              <td>
                <TicketLink id={t.id}>{t.title}</TicketLink>
              </td>
              <td>{store.labelOf(t.status)}</td>
              <td>
                <PriorityBadge priority={t.priority} />
              </td>
              <td>{t.iteration ?? ""}</td>
              <td>{t.epic ? <a href={hrefOf({ page: "epics", id: t.epic })}>{t.epic}</a> : ""}</td>
              <td>
                <Tags labels={t.labels} />
              </td>
              {extra ? <td>{extra(t)}</td> : null}
            </>
          );
          return draggable ? (
            <DraggableTr key={t.id} ticket={t}>
              {cells}
            </DraggableTr>
          ) : (
            <tr key={t.id}>{cells}</tr>
          );
        })}
      </tbody>
    </table>
  );
}
