// 小さな表示部品：チケットへのリンク、優先度・Status の印、ラベル、進捗、チケットの行

import { type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { BACKLOG_TICKET_SECTION, useAskSpot, type AskSection } from "./ask-menu.js";
import { useEpicHighlightClass } from "./epic-chip.js";
import { useHost } from "../host.js";
import { hrefOf, type Route } from "../router.js";
import { useStore } from "../store.js";
import { actorLabel, type Priority, type Progress, type Status, type Ticket } from "../types.js";
import { tr, msg } from "../l10n.js";

/**
 * チケット詳細へのリンク。チケットへのリンクはすべてここを通す。
 * 拡張ホストに頼んでエディタ領域に開く（UI-12。dg serve ではハッシュ遷移。host.open）。
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
        if (e.defaultPrevented) return;
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

/** Epic・Iteration・Plan などの詳細へのリンク。拡張ホストに頼んでエディタ領域に開く（dg serve ではハッシュ遷移。host.open） */
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
 * 文の中の ID（t12・e3・s2・p7）。境界の規則は VS Code 拡張の ID_PATTERN（packages/vscode/src/ids.ts）と同じにし、
 * カンバンとエディタで同じ字だけをリンクにする（web は vscode に依存しないので形を写している。変えるときは両方を直す）。
 * 語や経路の一部（step1・feat/t12・v1.t2・t12abc・t12-foo・t12.md）は拾わず、文末の「t12.」・括弧・日本語に隣り合う「t12を」は拾う
 */
const TEXT_ID = /(?<![\w/.-])([tsep][1-9]\d*)(?![\w/]|[-.]\w)/;

/** ID の頭の文字から詳細の画面を決める（core の model/id.ts の ID_PREFIX と同じ対応） */
function idRoute(id: string): Route {
  switch (id.charAt(0)) {
    case "t":
      return { page: "ticket", id };
    case "e":
      return { page: "epics", id };
    case "s":
      return { page: "iterations", id };
    default:
      return { page: "plans", id };
  }
}

/** 文の中の ID を詳細へのリンクにして出す（Iteration の目標など）。ID のほかの字はそのまま */
export function IdLinkedText({ text }: { text: string }) {
  // 捕まえる組が 1 つの split は、奇数の位置に ID が来る
  const parts = text.split(new RegExp(TEXT_ID.source, "g"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <DetailLink key={i} route={idRoute(part)}>
            {part}
          </DetailLink>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * 優先度の並び方のひとこと（byPriorityThenNumber で high が先、low が後に並ぶ）。ツールチップの 1 行目に添える
 */
const PRIORITY_ORDER_NOTE: Record<Priority, string> = {
  high: msg("上に並ぶ"),
  medium: msg("既定の並び"),
  low: msg("下に並ぶ"),
};

/** 優先度の記号（10px の SVG。high は上向きの矢印、medium は =、low は下向きの矢印）。色は文字に合わせて currentColor */
function PriorityGlyph({ priority }: { priority: Priority }) {
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

/** 優先度の印のツールチップ：1 行目に値と並び方、2 行目から判断基準（config。既定のままなら表示言語の訳。store が決める）。基準がまだ読めていなければ 1 行目だけ */
export function priorityTitle(priority: Priority, criteria: Record<Priority, string>): string {
  const head = tr("優先度 {0}（{1}）", priority, tr(PRIORITY_ORDER_NOTE[priority]));
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
      title={title || tr("チケットはない")}
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
 * 完了だけを塗りつぶし、進行中（In Progress・Review）は斜線にして、数字に「完了 n / m ・ 進行中 k」と何の比かを書く
 * （全件が進行中だと、塗りつぶしの満タンが「終わった」に見えるので）。short なら数字は done/全体 だけ（実行計画の帯の行が 1 行に収まるよう）
 */
export function ProgressBar({ progress, short }: { progress: Progress; short?: boolean }) {
  const words = !short;
  const active = (progress.by_status.in_progress ?? 0) + (progress.by_status.review ?? 0);
  return (
    <StackedProgress progress={progress} className="progress" partial>
      {words ? tr("完了 ") : ""}
      {progress.done}/{progress.total}
      {words && active > 0 ? tr(" ・ 進行中 {0}", active) : ""}
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
 * 状態ごとの件数の行（左パネルのカンバンの見出しの帯の下）。並びと色は帯（StatusBand）と同じで、1 件以上の状態だけを丸印と数字で出す。
 * 状態の名前はツールチップと読み上げで読む（幅を取らないように）
 */
export function StatusCounts({ progress }: { progress: Progress }) {
  const store = useStore();
  const items = PROGRESS_STATUSES.map((s) => ({
    status: s,
    count: progress.by_status[s] ?? 0,
  })).filter((item) => item.count > 0);
  if (items.length === 0) return null;
  return (
    <div className="status-counts">
      {items.map(({ status, count }) => {
        const label = `${store.labelOf(status)} ${count}`;
        return (
          <span key={status} className="status-count" title={label}>
            <StatusDot status={status} label={label} />
            <span aria-hidden="true">{count}</span>
          </span>
        );
      })}
    </div>
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
 * variant で行の種類を選ぶ（TicketRowVariant）。end を渡すと右端の優先度の印の代わりにそれを出す（カンバンの行の Plan の番号と待ち、Run の並びなど）。
 * カンバンとバックログの行で PR の番号があるときは、行のリンクの外の 2 段目に PR のリンクを出す（RowPrLink）。包みの class は呼び出し側が prRowClass で付ける。
 * Epic の札に触れている間（EpicHighlight で包んだ一覧）は、その Epic の行を光らせ、ほかを薄くする（useEpicHighlightClass）
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
  const backlog = variant === "backlog";
  const epicClass = useEpicHighlightClass(ticket);
  return (
    <>
      <TicketLink
        id={ticket.id}
        className={`row ticket-row status-${ticket.status}${kanban ? " kanban-row" : ""}${backlog ? " backlog-row" : ""}${flash ? " changed" : ""}${epicClass}`}
        onClick={onClick}
      >
        {kanban ? null : <StatusDot status={ticket.status} />}
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
      {(kanban || backlog) && ticket.pr ? <RowPrLink pr={ticket.pr} className={epicClass} /> : null}
    </>
  );
}

/**
 * PR の Web の URL（リモートの Web の URL と PR の番号から。詳細の PR の欄と行の PR のリンクが同じ URL を開く）。
 * web の URL がわからないときは null（リンクにせず番号を文字だけで出す）
 */
export function prHref(webUrl: string | null | undefined, pr: number): string | null {
  return webUrl ? `${webUrl}/pull/${pr}` : null;
}

/**
 * PR のある行の包み（UI-2）の class。カンバンとバックログの行で PR の番号があるときだけ付け、番号の列の 2 段目に PR のリンクを置く（styles.css の .pr-row）。
 * 包みは行の要素（.row-item・li）
 */
function prRowClass(
  ticket: Pick<Ticket, "pr">,
  variant: TicketRowVariant | undefined,
): string | undefined {
  if (!ticket.pr || (variant !== "kanban" && variant !== "backlog")) return undefined;
  return `pr-row ${variant}`;
}

/**
 * 行の番号の下の PR のリンク（UI-2）。カンバン・バックログの行（TicketRow）と履歴の行（history-rows.tsx）で使う。
 * 行のリンクの外に置くので、リンクの中にリンクを入れず、Tab では止まらない（tabIndex -1）。
 * 押しても行の選択と詳細は変えない（ask-menu.tsx の NOT_SELECT_CLICK が .row-pr を外す）。PR の印と #番号（PrLink と同じ URL）。
 * className は欄に足す class（先頭に空白を付けて渡す。Epic の札に触れている間の光らせ方）
 */
export function RowPrLink({ pr, className = "" }: { pr: number; className?: string | undefined }) {
  const href = prHref(useStore().status?.web_url, pr);
  const label = (
    <>
      <PrGlyph />#{pr}
    </>
  );
  return (
    <span className={`row-pr${className}`}>
      <span className="row-pr-link">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" tabIndex={-1}>
            {label}
          </a>
        ) : (
          label
        )}
      </span>
    </span>
  );
}

/** PR の印（9px の SVG。枝分かれした線）。色は文字に合わせて currentColor */
function PrGlyph() {
  return (
    <svg
      className="pr-glyph"
      width={9}
      height={9}
      viewBox="0 0 10 10"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
    >
      <circle cx="2.5" cy="2.5" r="1.3" />
      <circle cx="2.5" cy="7.5" r="1.3" />
      <circle cx="7.5" cy="7.5" r="1.3" />
      <path d="M2.5 3.8v2.4M7.5 6.2V4A1.5 1.5 0 0 0 6 2.5H5" />
    </svg>
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
 * 1 行のチケット（サイドバーのカンバン）。variant・end は TicketRow に渡す。dimmed でタイトルを説明文の色にする。
 * tone で行の地の色を変える（最後の Run が返事待ちか失敗・中断。row-end.tsx の runTone）。
 * ask を渡すと行をエージェントに頼める場所にする（右端の吹き出し・Shift+F10。ask-menu.tsx）。Ctrl/⌘・Shift+クリックで複数選べる（selection.tsx）。
 * 右クリックの文脈に行のチケットを載せ、拡張の「詳細を開く」「ID をコピー」を出す（useAskSpot の menu）
 */
export function AskRow({
  ticket,
  hideAssignee,
  flash,
  variant,
  end,
  dimmed = false,
  tone = null,
  ask,
}: {
  ticket: Ticket;
  hideAssignee?: boolean | undefined;
  flash?: boolean | undefined;
  variant?: TicketRowVariant | undefined;
  end?: ReactNode;
  /** すぐに手を付けられない行（カンバンの待ち・承認待ち）としてタイトルを薄く出す */
  dimmed?: boolean | undefined;
  /** 行の地の色（waiting は返事待ち、failed は失敗・中断）。null なら変えない */
  tone?: "waiting" | "failed" | null | undefined;
  /** エージェントに頼む場所の種類。対象はこの行のチケット */
  ask?: AskSection | undefined;
}) {
  const spot = useAskSpot(
    ask
      ? {
          targets: [ticket.id],
          label: tr("行 {0}", ticket.id),
          section: ask,
          menu: ticket.id,
          select: true,
        }
      : null,
  );
  const prClass = prRowClass(ticket, variant);
  return (
    <div
      className={`row-item${dimmed ? " is-waiting" : ""}${tone ? ` run-tone-${tone}` : ""}${prClass ? ` ${prClass}` : ""}`}
      {...(ask ? spot.props : {})}
    >
      <TicketRow
        ticket={ticket}
        hideAssignee={hideAssignee}
        flash={flash}
        variant={variant}
        end={end}
      />
      {spot.overlay}
    </div>
  );
}

/**
 * バックログの行（サイドバー）。右クリックの文脈は場所によらない webviewSection（core の WEBVIEW_CONTRACT の写しで、拡張の package.json の when と合う）と
 * チケットの ID（拡張の「詳細を開く」「ID をコピー」が使う）だけ載せる（useAskSpot の menu。既定の切り取り・コピー・貼り付けは出さない）。頼む入口は吹き出し
 */
function BacklogItem({
  ticket: t,
  className,
  children,
}: {
  ticket: Ticket;
  className?: string | undefined;
  children: ReactNode;
}) {
  const spot = useAskSpot({
    targets: [t.id],
    label: tr("行 {0}", t.id),
    section: BACKLOG_TICKET_SECTION,
    menu: t.id,
    select: true,
  });
  return (
    <li className={className} {...spot.props}>
      {children}
      {spot.overlay}
    </li>
  );
}

/**
 * チケットの一覧（サイドバーの 1 行ずつの並び）。行の先頭のリンクで詳細へ
 */
export function TicketTable({
  tickets,
  assigneeInEnd = false,
  rowMenu = false,
  end,
}: {
  tickets: readonly Ticket[];
  /**
   * サイドバーで行の担当者の列を出さない（担当は end が右端に出す。左パネルのバックログ。TicketRowVariant の backlog）。
   * 状態の丸印は todo を白抜きにする（in_progress と review は色の違う塗り。styles.css の .backlog-rows）
   */
  assigneeInEnd?: boolean;
  /**
   * サイドバーの行に VS Code の右クリックのメニュー（詳細を開く・ID をコピー）の文脈（data-vscode-context）を付け、エージェントに頼む吹き出しを出す。左パネルのバックログで使う
   * （カンバンの行は AskRow、履歴の行は HistoryTicketRow が同じ文脈を付ける）。
   * メニューとコマンドは拡張の package.json の webview/context と context-menu.ts
   */
  rowMenu?: boolean;
  /**
   * サイドバーの行の右端を差し替える（バックログの優先度の札・Plan の番号と着手可・待ち。row-end.tsx の BacklogRowEnd）。
   * 渡さなければ優先度の印（RowPriority）
   */
  end?: ((t: Ticket) => ReactNode) | undefined;
}) {
  if (tickets.length === 0) return <p className="empty">{tr("該当するチケットはない")}</p>;
  const hideAssignee = sameAssignee(tickets);
  const endOf = (t: Ticket) => (end ? end(t) : <RowPriority priority={t.priority} />);
  const variant = assigneeInEnd ? "backlog" : "list";
  return (
    <ul className={assigneeInEnd ? "rows backlog-rows" : "rows"}>
      {tickets.map((t) => {
        const content = (
          <TicketRow ticket={t} hideAssignee={hideAssignee} variant={variant} end={endOf(t)} />
        );
        const className = prRowClass(t, variant);
        return rowMenu ? (
          <BacklogItem key={t.id} ticket={t} className={className}>
            {content}
          </BacklogItem>
        ) : (
          <li key={t.id} className={className}>
            {content}
          </li>
        );
      })}
    </ul>
  );
}
