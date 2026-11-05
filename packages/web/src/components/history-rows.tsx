// 履歴用のチケットの行と一覧（左パネルの履歴）。Iteration・Epic・チケットのタブで共用する。
// 行は 2 段：1 段目は状態の丸印・番号・タイトル（サイドバーでは 2 行まで）、2 段目は Epic・PR などの付記。
// 優先度と担当者は出さない（終わったものを見る画面なので）。中止の行は点を塗らない輪にしてタイトルを薄くし、付記の頭に「中止」と書いて、色だけに頼らず完了と見分ける。
// 検索中は query を渡し、当たった部分（タイトル・番号・ラベル）に印（mark）を付ける。
// 行はエージェントに頼める場所にする（右端の吹き出し・右クリック・Shift+F10。ask-menu.tsx）

import { Fragment, useState, type ReactNode } from "react";
import { ASK_SECTIONS, useAskSpot } from "./ask-menu.js";
import { DetailLink, StatusDot, TicketLink } from "./parts.js";
import { useStore } from "../store.js";
import type { Ticket } from "../types.js";

/** 一覧で最初に出す行の数。多いときは残りを「ほか N 件」のボタンで開ける */
const HISTORY_LIST_HEAD = 8;

/**
 * text の中の query に当たる部分（大文字小文字を区別しない）に印を付ける。query が空なら text のまま。
 * 小文字にすると長さの変わる文字を含むときは、位置がずれるので印を付けない
 */
function Highlight({ text, query }: { text: string; query?: string | undefined }) {
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
 * 履歴用のチケットの行。2 段目は「中止」（中止のときだけ）・Iteration（showIteration のとき）・Epic（あるときだけ）・
 * PR 番号（なければ PR なし）・note の順に「・」で区切って出す。
 * Epic のタブのように Epic が分かっている一覧では showEpic={false} で Epic を省く。
 * query を渡すと、番号とタイトルの当たった部分に印を付け、当たったラベルを note の前に足す
 */
export function HistoryTicketRow({
  ticket: t,
  showIteration = false,
  showEpic = true,
  note,
  query,
}: {
  ticket: Ticket;
  /** 2 段目に Iteration を出す（Epic・チケットのタブ）。Iteration がなければ Iteration なし */
  showIteration?: boolean | undefined;
  showEpic?: boolean | undefined;
  /** 2 段目の最後に足すもの（持ち越しの行の「今は s5」、終えた日など） */
  note?: ReactNode;
  /** 検索語。当たった部分に印を付ける */
  query?: string | undefined;
}) {
  const store = useStore();
  // 行から頼む（UI-15。吹き出し・右クリック・Shift+F10）
  const spot = useAskSpot({
    targets: [t.id],
    label: `行 ${t.id}`,
    section: ASK_SECTIONS.historyRow,
  });
  const q = query?.trim().toLowerCase() ?? "";
  const abandoned = t.status === "abandoned";
  const parts: ReactNode[] = [];
  if (abandoned) parts.push(<span className="history-abandoned">{store.labelOf(t.status)}</span>);
  if (showIteration)
    parts.push(
      t.iteration ? (
        <DetailLink route={{ page: "iterations", id: t.iteration }}>{t.iteration}</DetailLink>
      ) : (
        <span className="history-none">Iteration なし</span>
      ),
    );
  // Epic のないチケットは何も書かない（Iteration の行の内訳で分かり、行ごとに繰り返すと読むところが埋もれる）
  if (showEpic && t.epic)
    parts.push(<DetailLink route={{ page: "epics", id: t.epic }}>{t.epic}</DetailLink>);
  parts.push(t.pr ? <span>#{t.pr}</span> : <span className="history-none">PR なし</span>);
  const labels = q ? t.labels.filter((l) => l.toLowerCase().includes(q)) : [];
  if (labels.length > 0)
    parts.push(
      <span className="history-hit-labels">
        ラベル{" "}
        {labels.map((l, n) => (
          <Fragment key={l}>
            {n > 0 ? ", " : ""}
            <Highlight text={l} query={q} />
          </Fragment>
        ))}
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
      <small className="history-ticket-meta">
        {parts.map((p, n) => (
          <span key={n}>
            {n > 0 ? " ・ " : ""}
            {p}
          </span>
        ))}
      </small>
      {spot.overlay}
    </div>
  );
}

/**
 * 履歴用の行の一覧。渡した順のまま出し、head 件より多いときは先頭の head 件だけ出して「ほか N 件」のボタンで残りを開ける。
 * row で行の描き方を変えられる（既定は HistoryTicketRow）。
 * 「ほか N 件」を開いた状態は tickets が変わっても戻らないので、別の一覧に切り替えるときは呼ぶ側で key を変える
 */
export function HistoryTicketList({
  tickets,
  head = HISTORY_LIST_HEAD,
  row = (t) => <HistoryTicketRow ticket={t} />,
}: {
  tickets: readonly Ticket[];
  head?: number | undefined;
  row?: ((ticket: Ticket) => ReactNode) | undefined;
}) {
  const [all, setAll] = useState(false);
  const folded = !all && tickets.length > head;
  const shown = folded ? tickets.slice(0, head) : tickets;
  return (
    <div className="rows history-list">
      {shown.map((t) => (
        <Fragment key={t.id}>{row(t)}</Fragment>
      ))}
      {folded ? (
        <button type="button" className="link history-more" onClick={() => setAll(true)}>
          ほか {tickets.length - head} 件
        </button>
      ) : null}
    </div>
  );
}
