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
import { WEBVIEW_CONTRACT_COPY } from "../client/webview.js";
import { useHost } from "../host.js";
import { hrefOf, type Route } from "../router.js";
import { useStore } from "../store.js";
import {
  actorLabel,
  isFinished,
  type Priority,
  type Progress,
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
 * 進捗の帯と右の数字の枠。segments を左から積み、幅は total に対する件数の比。
 * StackedProgress と本文の節の見出しのメーター（markdown.tsx の TaskMeter）が使う
 */
export function ProgressMeter({
  segments,
  total,
  className,
  title,
  children,
}: {
  segments: { key: string; className: string; count: number }[];
  total: number;
  className: string;
  title: string;
  /** 帯の右に出す数字 */
  children: ReactNode;
}) {
  return (
    <span className={className} title={title}>
      <span className="bar">
        {segments.map((seg) => (
          <span
            key={seg.key}
            className={seg.className}
            style={{ width: `${(seg.count / total) * 100}%` }}
          />
        ))}
      </span>
      <span className="muted">{children}</span>
    </span>
  );
}

/**
 * 進捗の帯と数字。Status ごとの件数を done から積み、色は --dg-status-*、ツールチップに内訳を出す。
 * partial なら done 以外を斜線にする。ProgressBar と StatusBand が使う
 */
function StackedProgress({
  progress,
  className,
  partial,
  children,
}: {
  progress: Progress;
  className: string;
  partial: boolean;
  /** 帯の右に出す数字 */
  children: ReactNode;
}) {
  const store = useStore();
  const segments = PROGRESS_STATUSES.map((s) => ({
    status: s,
    count: progress.by_status[s] ?? 0,
  })).filter((seg) => seg.count > 0);
  const title = segments.map((seg) => `${store.labelOf(seg.status)} ${seg.count}`).join(" / ");
  return (
    <ProgressMeter
      className={className}
      title={title || "チケットはない"}
      total={progress.total}
      segments={segments.map((seg) => ({
        key: seg.status,
        className: `status-${seg.status}${partial && seg.status !== "done" ? " partial" : ""}`,
        count: seg.count,
      }))}
    >
      {children}
    </ProgressMeter>
  );
}

/**
 * Epic の進捗（done の件数 / abandoned を除く件数。EP-3）。Status ごとに積み上げ、色は --dg-status-*。
 * Webview では完了だけを塗りつぶし、進行中（In Progress・Code Review）は斜線にして、数字に「完了 n / m ・ 進行中 k」と何の比かを書く
 * （全件が進行中だと、塗りつぶしの満タンが「終わった」に見えるので）。ブラウザでは今のまま。short なら数字は done/全体 だけ（実行計画の帯の行が 1 行に収まるよう）
 */
export function ProgressBar({ progress, short }: { progress: Progress; short?: boolean }) {
  const host = useHost();
  const webview = host.surface !== "browser";
  const words = webview && !short;
  const active = (progress.by_status.in_progress ?? 0) + (progress.by_status.review ?? 0);
  return (
    <StackedProgress progress={progress} className="progress" partial={webview}>
      {words ? "完了 " : ""}
      {progress.done}/{progress.total}
      {words && active > 0 ? ` ・ 進行中 ${active}` : ""}
    </StackedProgress>
  );
}

/**
 * Status ごとの色の細い帯と「n/m done」（左パネルのカンバンの見出し）。並びと色は ProgressBar と同じ（done が左、--dg-status-*）。
 * 斜線にはせず、数字に done の比を書く
 */
export function StatusBand({ progress }: { progress: Progress }) {
  return (
    <StackedProgress progress={progress} className="progress status-band" partial={false}>
      {progress.done}/{progress.total} done
    </StackedProgress>
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
  return tickets.filter((t) => !isFinished(t.status)).length;
}

/** 状態の丸印。色は --dg-status-*。読み上げの名前は label、なければ一覧の Workflow の表示名 */
export function StatusDot({ status, label }: { status: Status; label?: string }) {
  const store = useStore();
  return (
    <span
      className={`status-dot status-${status}`}
      role="img"
      aria-label={label ?? store.labelOf(status)}
    />
  );
}

/** カンバンの行の頭の印の種類。running は実行中の Run がある、idle は実行中の Run のない in_progress */
export type RowActivity = "running" | "idle";

/**
 * カンバンの行の頭の印（UI-2）。running は回るリング、idle は止まった半分塗りの丸。色は --dg-status-in_progress。
 * 動きを減らす設定ではリングを回さない（styles.css）
 */
export function ActivityMark({ activity }: { activity: RowActivity }) {
  const label = activity === "running" ? "Run が実行中" : "着手済み（実行中の Run なし）";
  return (
    <span
      className={`activity-mark activity-${activity}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

/**
 * 行の種類。list は一覧（履歴など）の行、kanban はカンバンの行
 * （状態は節で分かるので丸印を出さず、優先度は high に加えて low も小さく出す）、
 * backlog は左パネルのバックログの行（list と同じだが担当者の列を出さず、担当は右端に出す。row-end.tsx の BacklogRowEnd）
 */
export type TicketRowVariant = "list" | "kanban" | "backlog";

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
 * kanban と backlog の行は担当者の列を出さない（担当は右端の印で出す。row-end.tsx の KanbanRowEnd・BacklogRowEnd）。
 * 列がないぶんの幅はタイトルに回る。
 * variant で行の種類を選ぶ（TicketRowVariant）。end を渡すと右端の優先度の印の代わりにそれを出す（カンバンの行の Plan の番号と待ちなど）。
 * head を渡すとカンバンの行の頭（list の行の丸印の位置）にそれを出す（Run の実行中の印。ActivityMark）
 */
export function TicketRow({
  ticket,
  onClick,
  hideAssignee = false,
  flash = false,
  variant = "list",
  head,
  end,
}: {
  ticket: Ticket;
  onClick?: ComponentProps<"a">["onClick"] | undefined;
  hideAssignee?: boolean | undefined;
  /** 前回の描画から変わった行として枠を点滅させる（カンバンのサイドバー。change-flash.ts） */
  flash?: boolean | undefined;
  variant?: TicketRowVariant | undefined;
  /** 頭の差し込み口（kanban の行だけ）。渡さなければ頭に何も出さない */
  head?: ReactNode;
  /** 右端の差し込み口。渡さなければ優先度の印（RowPriority） */
  end?: ReactNode;
}) {
  const kanban = variant === "kanban";
  const backlog = variant === "backlog";
  const withHead = kanban && head != null;
  return (
    <TicketLink
      id={ticket.id}
      className={`row ticket-row status-${ticket.status}${kanban ? " kanban-row" : ""}${backlog ? " backlog-row" : ""}${withHead ? " has-head" : ""}${flash ? " changed" : ""}`}
      onClick={onClick}
    >
      {kanban ? withHead ? head : null : <StatusDot status={ticket.status} />}
      <code>{ticket.id}</code>
      <span className="row-title" title={ticket.title}>
        {ticket.title}
      </span>
      {kanban || backlog ? null : ticket.assignee && !hideAssignee ? (
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
function useDraggableTicket(id: string) {
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

/** 1 行のチケット（サイドバー）。行全体をつかんで動かす。variant・head・end は TicketRow に渡す。dimmed でタイトルを説明文の色にする */
export function DraggableRow({
  ticket,
  hideAssignee,
  flash,
  variant,
  head,
  end,
  dimmed = false,
}: {
  ticket: Ticket;
  hideAssignee?: boolean | undefined;
  flash?: boolean | undefined;
  variant?: TicketRowVariant | undefined;
  head?: ReactNode;
  end?: ReactNode;
  /** すぐに手を付けられない行（カンバンの待ち・承認待ち）としてタイトルを薄く出す */
  dimmed?: boolean | undefined;
}) {
  // 分けて受ける。d.ref を ref に渡すと、規則（react/refs）が d を ref と見なし、d.style などを描画中の ref の読みと誤る
  const { ref, style, isDragging, props } = useDraggableTicket(ticket.id);
  return (
    <div
      ref={ref}
      style={style}
      className={`row-drag${dimmed ? " is-waiting" : ""}${isDragging ? " dragging" : ""}`}
      {...props}
    >
      <TicketRow
        ticket={ticket}
        hideAssignee={hideAssignee}
        flash={flash}
        variant={variant}
        head={head}
        end={end}
      />
    </div>
  );
}

/** 表の 1 行（広い画面）。行全体をつかんで動かす */
function DraggableTr({ ticket, children }: { ticket: Ticket; children: ReactNode }) {
  const { ref, style, isDragging, props } = useDraggableTicket(ticket.id);
  return (
    <tr ref={ref} style={style} className={`row-drag${isDragging ? " dragging" : ""}`} {...props}>
      {children}
    </tr>
  );
}

/**
 * バックログの行の右クリックの文脈。webviewSection は core の WEBVIEW_CONTRACT の写しで、拡張の package.json の when と合う。
 * 既定の切り取り・コピー・貼り付けは出さない
 */
function rowMenuContext(t: Ticket): string {
  return JSON.stringify({
    webviewSection: WEBVIEW_CONTRACT_COPY.backlogRowSection,
    ticket: t.id,
    iteration: t.iteration ?? null,
    project: t.project,
    preventDefaultContextMenuItems: true,
  });
}

/**
 * チケットの一覧。広い画面では表、サイドバーでは 1 行ずつの並び。行の先頭のリンクで詳細へ。
 * draggable なら行をドラッグできる（外側に DndContext が要る）
 */
export function TicketTable({
  tickets,
  extra,
  draggable = false,
  assigneeInEnd = false,
  rowMenu = false,
  end,
}: {
  tickets: readonly Ticket[];
  extra?: ((t: Ticket) => React.ReactNode) | undefined;
  draggable?: boolean;
  /**
   * サイドバーで行の担当者の列を出さない（担当は end が右端に出す。左パネルのバックログ。TicketRowVariant の backlog）。
   * 状態の丸印は todo を白抜きにする（in_progress と review は色の違う塗り。styles.css の .backlog-rows）
   */
  assigneeInEnd?: boolean;
  /**
   * サイドバーの行に VS Code の右クリックのメニューの文脈（data-vscode-context）を付ける。左パネルのバックログで使う。
   * メニューとコマンドは拡張の package.json の webview/context と context-menu.ts。ブラウザでは何も起きない
   */
  rowMenu?: boolean;
  /**
   * サイドバーの行の右端を差し替える（バックログの優先度の札・Plan の番号と着手可・待ち。row-end.tsx の BacklogRowEnd）。
   * 渡さなければ優先度の印（RowPriority）
   */
  end?: ((t: Ticket) => ReactNode) | undefined;
}) {
  const store = useStore();
  const host = useHost();
  if (tickets.length === 0) return <p className="empty">該当するチケットはない</p>;
  if (host.surface === "sidebar") {
    const hideAssignee = sameAssignee(tickets);
    const endOf = (t: Ticket) => (end ? end(t) : <RowPriority priority={t.priority} />);
    const variant = assigneeInEnd ? "backlog" : "list";
    return (
      <ul className={assigneeInEnd ? "rows backlog-rows" : "rows"}>
        {tickets.map((t) => (
          <li key={t.id} data-vscode-context={rowMenu ? rowMenuContext(t) : undefined}>
            {draggable ? (
              <DraggableRow
                ticket={t}
                hideAssignee={hideAssignee}
                variant={variant}
                end={endOf(t)}
              />
            ) : (
              <TicketRow ticket={t} hideAssignee={hideAssignee} variant={variant} end={endOf(t)} />
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
