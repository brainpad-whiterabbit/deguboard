// 履歴用のチケットの行と一覧（左パネルの履歴）。Iteration・Epic・チケットのタブで共用する。
// 行は 2 段：1 段目は状態の丸印・番号・タイトル（サイドバーでは 2 行まで）、2 段目は Epic・PR などの付記。
// 優先度と担当者は出さない（終わったものを見る画面なので）。中止の行は薄くし、付記の頭に「中止」と書いて完了と見分ける

import { Fragment, useState, type ReactNode } from "react";
import { DetailLink, StatusDot, TicketLink } from "./parts.js";
import { useStore } from "../store.js";
import type { Ticket } from "../types.js";

/** 一覧で最初に出す行の数。多いときは残りを「ほか N 件」のボタンで開ける */
export const HISTORY_LIST_HEAD = 8;

/**
 * 履歴用のチケットの行。2 段目は「中止」（中止のときだけ）・Iteration（iteration を渡したとき）・Epic（なければ Epic なし）・
 * PR 番号（なければ PR なし）・note の順に「・」で区切って出す。
 * Epic のタブのように Epic が分かっている一覧では showEpic={false} で Epic を省く
 */
export function HistoryTicketRow({
  ticket: t,
  showIteration = false,
  showEpic = true,
  note,
}: {
  ticket: Ticket;
  /** 2 段目に Iteration を出す（チケットのタブ）。Iteration がなければ Iteration なし */
  showIteration?: boolean | undefined;
  showEpic?: boolean | undefined;
  /** 2 段目の最後に足すもの（持ち越しの行の「今は s5」、終えた日など） */
  note?: ReactNode;
}) {
  const store = useStore();
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
  if (showEpic)
    parts.push(
      t.epic ? (
        <DetailLink route={{ page: "epics", id: t.epic }}>{t.epic}</DetailLink>
      ) : (
        <span className="history-none">Epic なし</span>
      ),
    );
  parts.push(t.pr ? <span>#{t.pr}</span> : <span className="history-none">PR なし</span>);
  if (note != null) parts.push(note);
  return (
    <div className={`history-ticket${abandoned ? " abandoned" : ""}`}>
      <TicketLink id={t.id} className={`row ticket-row history-ticket-main status-${t.status}`}>
        <StatusDot status={t.status} />
        <code>{t.id}</code>
        <span className="row-title" title={t.title}>
          {t.title}
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
