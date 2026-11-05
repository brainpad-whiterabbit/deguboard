// 小さな表示部品：チケットへのリンク、優先度・Status の印、ラベル、進捗、チケットの行

import { type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { WEBVIEW_CONTRACT_COPY } from "../client/webview.js";
import { useAskSpot, type AskSection } from "./ask-menu.js";
import { useHost } from "../host.js";
import { hrefOf, type Route } from "../router.js";
import { useStore } from "../store.js";
import { actorLabel, type Priority, type Progress, type Status, type Ticket } from "../types.js";

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
        // 呼び出し側が preventDefault したら（行の選択など）開かない
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

/** Epic・Iteration・Plan などの詳細へのリンク。ブラウザではハッシュ遷移、Webview では拡張ホストに頼んでエディタ領域に開く */
export function DetailLink({
  route,
  children,
  className,
  title,
}: {
  route: Route;
  children: ReactNode;
  className?: string | undefined;
  title?: string | undefined;
}) {
  const host = useHost();
  return (
    <a
      href={hrefOf(route)}
      className={className}
      title={title}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        host.open(route);
      }}
    >
      {children}
    </a>
  );
}

/**
 * 優先度の並び方のひとこと（byPriorityThenNumber で high が先、low が後に並ぶ）。ツールチップの 1 行目に添える
 */
const PRIORITY_ORDER_NOTE: Record<Priority, string> = {
  high: "上に並ぶ",
  medium: "既定の並び",
  low: "下に並ぶ",
};

/** 優先度の記号（10px の SVG。high は上向きの矢印、medium は =、low は下向きの矢印）。色は文字に合わせて currentColor */
export function PriorityGlyph({ priority }: { priority: Priority }) {
  const common = {
    className: "priority-glyph",
    width: 10,
    height: 10,
    viewBox: "0 0 10 10",
    "aria-hidden": true,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (priority === "high")
    return (
      <svg {...common}>
        <path d="M5 8.5V2M2.5 4.5 5 2l2.5 2.5" />
      </svg>
    );
  if (priority === "low")
    return (
      <svg {...common}>
        <path d="M5 1.5V8M2.5 5.5 5 8l2.5-2.5" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M2.5 4h5M2.5 6.5h5" />
    </svg>
  );
}

/** 優先度の印のツールチップ：1 行目に値と並び方、2 行目から判断基準（config、なければ core の既定）。基準がまだ読めていなければ 1 行目だけ */
export function priorityTitle(priority: Priority, criteria: Record<Priority, string>): string {
  const head = `優先度 ${priority}（${PRIORITY_ORDER_NOTE[priority]}）`;
  const note = criteria[priority];
  return note ? `${head}\n${note}` : head;
}

/**
 * 優先度の印（TK-8）：記号（矢印・=）と値の文字をそろえて出す。色は high が赤の太字、medium が前景色、low が説明文の色。
 * マウスを載せると値・並び方・判断基準をツールチップに出す。帯・カード・表の列では 3 つの値を出し、行では high・low だけ（RowPriority）
 */
export function PriorityMark({ priority }: { priority: Priority }) {
  const store = useStore();
  return (
    <span
      className={`priority-mark priority-${priority}`}
      title={priorityTitle(priority, store.priorityCriteria)}
    >
      <PriorityGlyph priority={priority} />
      <span className="priority-text">{priority}</span>
    </span>
  );
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
 * （状態は節で分かるので丸印を出さず、担当は右端に出す）、
 * backlog は左パネルのバックログの行（list と同じだが担当者の列を出さず、担当は右端に出す。row-end.tsx の BacklogRowEnd）
 */
export type TicketRowVariant = "list" | "kanban" | "backlog";

/** 行の右端の優先度の印。high・low は矢印と文字で出し、medium は出さない。行では右端の 1 段目の左端に置く（row-end.tsx） */
export function RowPriority({ priority }: { priority: Priority }) {
  if (priority === "medium") return null;
  return <PriorityMark priority={priority} />;
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
      {end ?? <RowPriority priority={ticket.priority} />}
    </TicketLink>
  );
}

/**
 * 行のチケットの担当がすべて同じ 1 人か。そのときは行ごとに担当を出さない（TicketRow の hideAssignee）。
 * 担当のないチケットが混ざる・行がないときは false
 */
export function sameAssignee(tickets: readonly Pick<Ticket, "assignee">[]): boolean {
  const first = tickets[0]?.assignee;
  return !!first && tickets.every((t) => t.assignee === first);
}

/**
 * 1 行のチケット（サイドバーのカンバン）。variant・head・end は TicketRow に渡す。dimmed でタイトルを説明文の色にする。
 * ask を渡すと行をエージェントに頼める場所にする（右端の吹き出し・Shift+F10。ask-menu.tsx）。Ctrl/⌘・Shift+クリックで複数選べる（selection.tsx）
 */
export function AskRow({
  ticket,
  hideAssignee,
  flash,
  variant,
  head,
  end,
  dimmed = false,
  ask,
}: {
  ticket: Ticket;
  hideAssignee?: boolean | undefined;
  flash?: boolean | undefined;
  variant?: TicketRowVariant | undefined;
  head?: ReactNode;
  end?: ReactNode;
  /** すぐに手を付けられない行（カンバンの待ち・承認待ち）としてタイトルを薄く出す */
  dimmed?: boolean | undefined;
  /** エージェントに頼む場所の種類。対象はこの行のチケット */
  ask?: AskSection | undefined;
}) {
  const spot = useAskSpot(
    ask ? { targets: [ticket.id], label: `行 ${ticket.id}`, section: ask, select: true } : null,
  );
  return (
    <div className={`row-item${dimmed ? " is-waiting" : ""}`} {...(ask ? spot.props : {})}>
      <TicketRow
        ticket={ticket}
        hideAssignee={hideAssignee}
        flash={flash}
        variant={variant}
        head={head}
        end={end}
      />
      {spot.overlay}
    </div>
  );
}

/**
 * バックログの行（サイドバー）。右クリックの文脈は webviewSection（core の WEBVIEW_CONTRACT の写しで、拡張の package.json の when と合う）と
 * チケット（拡張の「詳細を開く」「ID をコピー」が使う）だけ載せる（useAskSpot。既定の切り取り・コピー・貼り付けは出さない）。頼む入口は吹き出し
 */
function BacklogItem({ ticket: t, children }: { ticket: Ticket; children: ReactNode }) {
  const spot = useAskSpot({
    targets: [t.id],
    label: `行 ${t.id}`,
    section: WEBVIEW_CONTRACT_COPY.backlogRowSection,
    context: { ticket: t.id },
    select: true,
  });
  return (
    <li {...spot.props}>
      {children}
      {spot.overlay}
    </li>
  );
}

/** 一覧の行をエージェントに頼む場所にするときの指定。within はチケットが入っている Iteration・Epic（詳細の中の行） */
export interface RowAsk {
  section: AskSection;
  within?: string | undefined;
}

function rowAskOptions(t: Ticket, ask: RowAsk) {
  return {
    targets: [t.id],
    label: `行 ${t.id}`,
    section: ask.section,
    within: ask.within,
    select: true,
  };
}

/** 頼める 1 行（サイドバーの並び）。吹き出しは行の右端に重ねる */
function AskLi({ ticket, ask, children }: { ticket: Ticket; ask: RowAsk; children: ReactNode }) {
  const spot = useAskSpot(rowAskOptions(ticket, ask));
  return (
    <li {...spot.props}>
      {children}
      {spot.overlay}
    </li>
  );
}

/** 頼める表の 1 行（広い画面）。吹き出しは末尾のセルに置く（tr の直下にボタンは置けない） */
function AskTr({ ticket, ask, children }: { ticket: Ticket; ask: RowAsk; children: ReactNode }) {
  const spot = useAskSpot(rowAskOptions(ticket, ask));
  return (
    <tr {...spot.props}>
      {children}
      <td className="ask-cell">{spot.overlay}</td>
    </tr>
  );
}

/**
 * チケットの一覧。広い画面では表、サイドバーでは 1 行ずつの並び。行の先頭のリンクで詳細へ
 */
export function TicketTable({
  tickets,
  assigneeInEnd = false,
  rowMenu = false,
  end,
  ask,
}: {
  tickets: readonly Ticket[];
  /**
   * サイドバーで行の担当者の列を出さない（担当は end が右端に出す。左パネルのバックログ。TicketRowVariant の backlog）。
   * 状態の丸印は todo を白抜きにする（in_progress と review は色の違う塗り。styles.css の .backlog-rows）
   */
  assigneeInEnd?: boolean;
  /**
   * サイドバーの行に VS Code の右クリックのメニュー（詳細を開く・ID をコピー）の文脈（data-vscode-context）を付け、エージェントに頼む吹き出しを出す。左パネルのバックログで使う。
   * メニューとコマンドは拡張の package.json の webview/context と context-menu.ts。ブラウザでは右クリックのメニューは出ない
   */
  rowMenu?: boolean;
  /**
   * サイドバーの行の右端を差し替える（バックログの優先度の札・Plan の番号と着手可・待ち。row-end.tsx の BacklogRowEnd）。
   * 渡さなければ優先度の印（RowPriority）
   */
  end?: ((t: Ticket) => ReactNode) | undefined;
  /** 行をエージェントに頼む場所にする（吹き出し・Shift+F10。Iteration の詳細の中の行）。rowMenu があればそちらを使う */
  ask?: RowAsk | undefined;
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
        {tickets.map((t) => {
          const content = (
            <TicketRow ticket={t} hideAssignee={hideAssignee} variant={variant} end={endOf(t)} />
          );
          return rowMenu ? (
            <BacklogItem key={t.id} ticket={t}>
              {content}
            </BacklogItem>
          ) : ask ? (
            <AskLi key={t.id} ticket={t} ask={ask}>
              {content}
            </AskLi>
          ) : (
            <li key={t.id}>{content}</li>
          );
        })}
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
          {ask ? <th aria-label="エージェントに頼む" /> : null}
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
                <PriorityMark priority={t.priority} />
              </td>
              <td>{t.iteration ?? ""}</td>
              <td>{t.epic ? <a href={hrefOf({ page: "epics", id: t.epic })}>{t.epic}</a> : ""}</td>
              <td>
                <Tags labels={t.labels} />
              </td>
            </>
          );
          return ask ? (
            <AskTr key={t.id} ticket={t} ask={ask}>
              {cells}
            </AskTr>
          ) : (
            <tr key={t.id}>{cells}</tr>
          );
        })}
      </tbody>
    </table>
  );
}
