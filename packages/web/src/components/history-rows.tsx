// 履歴用のチケットの行と一覧（左パネルの履歴）。Iteration・Epic・チケットのタブで共用する。
// 行は 2 段：1 段目は状態の丸印・番号・タイトル（サイドバーでは 2 行まで）、2 段目は Epic などの付記。
// PR はカンバンの行と同じく番号のすぐ下にリンクで出す（RowPrLink。UI-2）。
// 優先度と担当者は出さない（終わったものを見る画面なので）。中止の行は点を塗らない輪にしてタイトルを薄くし、色だけに頼らず完了と見分ける。
// 完了と混ざる一覧では付記の頭にも「中止」と書く。「中止 N 件」の小見出しの下の行では、小見出しと重なるので書かない。
// 検索中は query を渡し、当たった部分（タイトル・番号・ラベル）に印（mark）を付ける（Highlight。Iteration・Epic の行の印にも使う）。
// 行はエージェントに頼める場所にする（右端の吹き出し・Shift+F10。ask-menu.tsx）。右クリックは「詳細を開く」「ID をコピー」

import { Fragment, useState, type ReactNode } from "react";
import { ASK_SECTIONS, useAskSpot } from "./ask-menu.js";
import { DetailLink, RowPrLink, StatusDot, TicketLink } from "./parts.js";
import type { Ticket } from "../types.js";
import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 一覧で最初に出す行の数。多いときは残りを「ほか N 件」のボタンで開ける */
const HISTORY_LIST_HEAD = 8;
/**
 * 全体がこの件数以下の一覧は切らずに全部出す。数件を隠すためにボタンを押させるより、
 * 全部並べたほうが速く見渡せるので
 */
const HISTORY_LIST_UNFOLDED_MAX = 15;
/**
 * 「ほか N 件」を 1 回押して開く件数。残りを一度に全部開くと、数百件の一覧で行の描画が重くなるので区切る
 */
const HISTORY_LIST_STEP = 50;

/**
 * text の中の query に当たる部分（大文字小文字を区別しない）に印を付ける。query が空なら text のまま。
 * 小文字にすると長さの変わる文字を含むときは、位置がずれるので印を付けない
 */
export function Highlight({ text, query }: { text: string; query?: string | undefined }) {
  const q = query?.trim().toLowerCase() ?? "";
  const lower = text.toLowerCase();
  if (!q || lower.length !== text.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, from)) {
    if (at > from) out.push(text.slice(from, at));
    out.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return <>{out}</>;
}

/**
 * 履歴用のチケットの行。2 段目は「中止」（中止で markAbandoned のときだけ）・Iteration（showIteration のとき）・Epic（あるときだけ）・
 * note の順に「・」で区切って出す。
 * PR の番号があるときは、番号のすぐ下に PR の印と #番号のリンクを出す（カンバンの行と同じ RowPrLink）。
 * 番号と PR は番号の列に縦に積み、PR は行の 2 行目（タイトルが 2 行なら 2 行目の横、1 行なら付記の横）に重ねて、行を増やさない（styles.css の .history-ticket）。
 * PR のないチケットは PR の欄にも付記にも何も出さない（カンバンの行と同じ）。PR の有無は番号の下の印の有無で見分けられ、
 * ない行ごとに「PR なし」と書くと、Epic のないものを書かないのと同じく付記の読むところが埋もれるので。
 * Epic のタブのように Epic が分かっている一覧では showEpic={false} で Epic を省く。
 * query を渡すと、番号とタイトルの当たった部分に印を付け、当たったラベルを note の前に足す
 */
export function HistoryTicketRow({
  ticket: t,
  showIteration = false,
  showEpic = true,
  markAbandoned = true,
  note,
  query,
}: {
  ticket: Ticket;
  /** 2 段目に Iteration を出す（Epic の見方）。Iteration がなければ Iteration なし */
  showIteration?: boolean | undefined;
  showEpic?: boolean | undefined;
  /**
   * 中止の行の 2 段目の頭に「中止」と書く。「中止 N 件」の小見出しの下（history.tsx の AbandonedGroup）では
   * 小見出しと同じ言葉を行ごとに繰り返すことになるので false にする（輪の点と薄いタイトルは残る）
   */
  markAbandoned?: boolean | undefined;
  /** 2 段目の最後に足すもの（持ち越しの行の「今は s5」、終えた日など） */
  note?: ReactNode;
  /** 検索語。当たった部分に印を付ける */
  query?: string | undefined;
}) {
  // 行から頼む（UI-15。吹き出し・Shift+F10）。右クリックでチケットの「詳細を開く」「ID をコピー」を出す
  const spot = useAskSpot({
    targets: [t.id],
    label: tr("行 {0}", t.id),
    section: ASK_SECTIONS.historyRow,
    place: ASK_SECTIONS.historyRow,
    menu: t.id,
    select: true,
  });
  const q = query?.trim().toLowerCase() ?? "";
  const abandoned = t.status === "abandoned";
  const parts: ReactNode[] = [];
  // 中止の表記は履歴の結果の切り替えと同じ「中止」（labelOf の表示名は使わない。理由は history.tsx の結果の切り替えの注記）
  if (abandoned && markAbandoned)
    parts.push(<span className="history-abandoned">{tr("中止")}</span>);
  if (showIteration)
    parts.push(
      t.iteration ? (
        <DetailLink route={{ page: "iterations", id: t.iteration }}>{t.iteration}</DetailLink>
      ) : (
        <span className="history-none">{tr("Iteration なし")}</span>
      ),
    );
  // Epic のないチケットは何も書かない（Iteration の行の内訳で分かり、行ごとに繰り返すと読むところが埋もれる）
  if (showEpic && t.epic)
    parts.push(<DetailLink route={{ page: "epics", id: t.epic }}>{t.epic}</DetailLink>);
  const labels = q ? t.labels.filter((l) => l.toLowerCase().includes(q)) : [];
  if (labels.length > 0)
    parts.push(
      <span className="history-hit-labels">
        {trNode(
          "ラベル{0}{1}",
          " ",
          labels.map((l, n) => (
            <Fragment key={l}>
              {n > 0 ? ", " : ""}
              <Highlight text={l} query={q} />
            </Fragment>
          )),
        )}
      </span>,
    );
  if (note != null) parts.push(note);
  return (
    <div className={`history-ticket${abandoned ? " abandoned" : ""}`} {...spot.props}>
      <TicketLink id={t.id} className={`row ticket-row history-ticket-main status-${t.status}`}>
        <StatusDot status={t.status} />
        <code>
          <Highlight text={t.id} query={q} />
        </code>
        <span className="row-title" title={t.title}>
          <Highlight text={t.title} query={q} />
        </span>
      </TicketLink>
      {/* 付記が空でも 2 段目の高さは取る（PR のある行とない行の高さを揃える。styles.css の .history-ticket-meta） */}
      <small className="history-ticket-meta">
        <span className="history-ticket-note">
          {parts.map((p, n) => (
            <span key={n}>
              {n > 0 ? tr(" ・ ") : ""}
              {p}
            </span>
          ))}
        </span>
      </small>
      {t.pr ? <RowPrLink pr={t.pr} /> : null}
      {spot.overlay}
    </div>
  );
}

/**
 * 履歴用の行の一覧。渡した順のまま出す。unfoldedMax 件より多いときは先頭の head 件だけ出し、
 * 「ほか N 件」（N は残りの全件数）のボタンを押すたびに step 件ずつ開く。
 * row で行の描き方を変えられる（既定は HistoryTicketRow）。before は行の前に挟むもの（区切りの見出し）を返し、
 * 出ている行の分だけ挟む（まだ開いていない行の区切りは出さない）。
 * 「ほか N 件」を開いた状態は tickets が変わっても戻らないので、別の一覧に切り替えるときは呼ぶ側で key を変える
 */
export function HistoryTicketList({
  tickets,
  head = HISTORY_LIST_HEAD,
  unfoldedMax = HISTORY_LIST_UNFOLDED_MAX,
  step = HISTORY_LIST_STEP,
  row = (t) => <HistoryTicketRow ticket={t} />,
  before,
}: {
  tickets: readonly Ticket[];
  head?: number | undefined;
  /** 全体がこの件数以下なら切らない */
  unfoldedMax?: number | undefined;
  /** 「ほか N 件」を 1 回押して開く件数 */
  step?: number | undefined;
  row?: ((ticket: Ticket) => ReactNode) | undefined;
  /** 行の前に挟むもの。挟まない行では null を返す */
  before?: ((ticket: Ticket) => ReactNode) | undefined;
}) {
  // 開いた件数（先頭の head 件に足す数）
  const [opened, setOpened] = useState(0);
  const limit = tickets.length <= Math.max(unfoldedMax, head) ? tickets.length : head + opened;
  const shown = limit < tickets.length ? tickets.slice(0, limit) : tickets;
  const rest = tickets.length - shown.length;
  return (
    <div className="rows history-list">
      {shown.map((t) => (
        <Fragment key={t.id}>
          {before?.(t)}
          {row(t)}
        </Fragment>
      ))}
      {rest > 0 ? (
        <button
          type="button"
          className="link history-more"
          onClick={() => setOpened((n) => n + step)}
        >
          {trNode("ほか {0} 件", rest)}
        </button>
      ) : null}
    </div>
  );
}
