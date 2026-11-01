// 小さな表示部品：チケットへのリンク、優先度・Status の印、ラベル、進捗、ドラッグできるチケットの行

import { useDraggable } from "@dnd-kit/core";
import {
  useEffect,
  useRef,
  useState,
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

/**
 * Epic の進捗（done の件数 / abandoned を除く件数。EP-3）。Status ごとに積み上げ、色は --dg-status-*。
 * Webview では完了だけを塗りつぶし、進行中（In Progress・Code Review）は斜線にして、数字に「完了 n / m ・ 進行中 k」と何の比かを書く
 * （全件が進行中だと、塗りつぶしの満タンが「終わった」に見えるので）。ブラウザでは今のまま
 */
export function ProgressBar({ progress }: { progress: EpicProgress }) {
  const store = useStore();
  const host = useHost();
  const webview = host.surface !== "browser";
  const active = (progress.by_status.in_progress ?? 0) + (progress.by_status.review ?? 0);
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
            className={`status-${seg.status}${webview && seg.status !== "done" ? " partial" : ""}`}
            style={{ width: `${(seg.count / progress.total) * 100}%` }}
          />
        ))}
      </span>
      <span className="muted">
        {webview ? "完了 " : ""}
        {progress.done}/{progress.total}
        {webview && active > 0 ? ` ・ 進行中 ${active}` : ""}
      </span>
    </span>
  );
}

/**
 * Status ごとの色の細い帯と「n/m done」（左パネルのカンバンの見出し）。並びと色は ProgressBar と同じ（done が左、--dg-status-*）。
 * 斜線にはせず、数字に done の比を書く
 */
export function StatusBand({ progress }: { progress: EpicProgress }) {
  const store = useStore();
  const segments = PROGRESS_STATUSES.map((s) => ({
    status: s,
    count: progress.by_status[s] ?? 0,
  })).filter((seg) => seg.count > 0);
  const title = segments.map((seg) => `${store.labelOf(seg.status)} ${seg.count}`).join(" / ");
  return (
    <span className="progress status-band" title={title || "チケットはない"}>
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
        {progress.done}/{progress.total} done
      </span>
    </span>
  );
}

/**
 * 閉じるのボタン（Iteration・Epic）。Webview では押すと画面の中に確認を出し、未完了の件数を見せてから閉じる
 * （Webview では confirm() が使えない）。ブラウザでは今のまま 1 回で閉じる。
 * 見出し（summary）の中にも置くので、クリックは節の開閉に伝えない
 */
export function CloseButton({
  subject,
  unfinished,
  note,
  onClose,
}: {
  /** 確認の文に出す名前（s4 sprint4 など） */
  subject: string;
  unfinished: number;
  /** 未完了があるときに添える、閉じたあとにどうなるか */
  note?: string | undefined;
  onClose: () => void;
}) {
  const host = useHost();
  const [confirming, setConfirming] = useState(false);
  if (host.surface === "browser") {
    return (
      <button type="button" onClick={onClose}>
        閉じる
      </button>
    );
  }
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <>
      <button
        type="button"
        aria-expanded={confirming}
        onClick={(e) => {
          stop(e);
          setConfirming(true);
        }}
      >
        閉じる
      </button>
      {confirming ? (
        <div className="confirm" role="group" aria-label={`${subject} を閉じる確認`} onClick={stop}>
          <p>
            {subject} を閉じる。
            {unfinished > 0 ? `未完了が ${unfinished} 件ある。${note ?? ""}` : "未完了はない。"}
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={(e) => {
                stop(e);
                setConfirming(false);
                onClose();
              }}
            >
              {unfinished > 0 ? `${unfinished} 件を残して閉じる` : "閉じる"}
            </button>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                setConfirming(false);
              }}
            >
              やめる
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 未完了（done・abandoned 以外）のチケットの件数 */
export function unfinishedCount(tickets: readonly Pick<Ticket, "status">[]): number {
  return tickets.filter((t) => t.status !== "done" && t.status !== "abandoned").length;
}

/** 状態の丸印。色は --dg-status-* */
export function StatusDot({ status }: { status: Status }) {
  const store = useStore();
  return (
    <span className={`status-dot status-${status}`} role="img" aria-label={store.labelOf(status)} />
  );
}

/**
 * 行の種類。list は一覧（バックログ・履歴など）の行、kanban はカンバンの行
 * （状態は節で分かるので丸印を出さず、優先度は high に加えて low も小さく出す）
 */
export type TicketRowVariant = "list" | "kanban";

/** 行の右端の優先度の印。high は札、kanban の行では low も小さな灰色の文字で出す。それ以外は空のセル（行の格子の位置を保つ） */
export function RowPriority({
  priority,
  variant = "list",
}: {
  priority: Priority;
  variant?: TicketRowVariant | undefined;
}) {
  if (priority === "high") return <PriorityBadge priority="high" />;
  if (variant === "kanban" && priority === "low") {
    return (
      <span className="row-low" title="優先度 low">
        low
      </span>
    );
  }
  return <span />;
}

/**
 * チケットの 1 行（サイドバー向け）：状態の丸印・番号・タイトル・担当者・右端（既定は優先度の印）。
 * サイドバーではタイトルを 2 行まで折り返す（styles.css）。hideAssignee で担当者を出さない（見えている行の担当が 1 人だけのとき）。
 * variant で行の種類を選ぶ（TicketRowVariant）。end を渡すと右端の優先度の印の代わりにそれを出す（カンバンの行の Plan の番号と待ちなど）
 */
export function TicketRow({
  ticket,
  onClick,
  hideAssignee = false,
  flash = false,
  variant = "list",
  end,
}: {
  ticket: Ticket;
  onClick?: ComponentProps<"a">["onClick"] | undefined;
  hideAssignee?: boolean | undefined;
  /** 前回の描画から変わった行として枠を点滅させる（カンバンのサイドバー。change-flash.ts） */
  flash?: boolean | undefined;
  variant?: TicketRowVariant | undefined;
  /** 右端の差し込み口。渡さなければ優先度の印（RowPriority） */
  end?: ReactNode;
}) {
  const kanban = variant === "kanban";
  return (
    <TicketLink
      id={ticket.id}
      className={`row ticket-row status-${ticket.status}${kanban ? " kanban-row" : ""}${flash ? " changed" : ""}`}
      onClick={onClick}
    >
      {kanban ? null : <StatusDot status={ticket.status} />}
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
      {end ?? <RowPriority priority={ticket.priority} variant={variant} />}
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

/** 1 行のチケット（サイドバー）。行全体をつかんで動かす。variant と end は TicketRow に渡す */
export function DraggableRow({
  ticket,
  hideAssignee,
  flash,
  variant,
  end,
}: {
  ticket: Ticket;
  hideAssignee?: boolean | undefined;
  flash?: boolean | undefined;
  variant?: TicketRowVariant | undefined;
  end?: ReactNode;
}) {
  const d = useDraggableTicket(ticket.id);
  return (
    <div
      ref={d.ref}
      style={d.style}
      className={`row-drag${d.isDragging ? " dragging" : ""}`}
      {...d.props}
    >
      <TicketRow
        ticket={ticket}
        hideAssignee={hideAssignee}
        flash={flash}
        variant={variant}
        end={end}
      />
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
  priorityMarks = false,
}: {
  tickets: readonly Ticket[];
  extra?: ((t: Ticket) => React.ReactNode) | undefined;
  draggable?: boolean;
  /**
   * サイドバーで行の左に優先度の印（H・M・L）を付け、優先度の変わるところに区切りを入れる。
   * 優先度の順に並べた一覧（バックログの区画）で使う
   */
  priorityMarks?: boolean;
}) {
  const store = useStore();
  const host = useHost();
  if (tickets.length === 0) return <p className="empty">該当するチケットはない</p>;
  if (host.surface === "sidebar") {
    const hideAssignee = sameAssignee(tickets);
    return (
      <ul className="rows">
        {tickets.map((t, i) => (
          <li
            key={t.id}
            className={
              priorityMarks && i > 0 && tickets[i - 1]!.priority !== t.priority
                ? "priority-break"
                : undefined
            }
          >
            {priorityMarks ? (
              <span
                className={`priority-mark priority-${t.priority}`}
                title={`優先度 ${t.priority}`}
              >
                {t.priority.charAt(0).toUpperCase()}
              </span>
            ) : null}
            {draggable ? (
              <DraggableRow ticket={t} hideAssignee={hideAssignee} />
            ) : (
              <TicketRow ticket={t} hideAssignee={hideAssignee} />
            )}
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
