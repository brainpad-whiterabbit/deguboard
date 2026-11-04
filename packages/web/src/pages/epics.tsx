// Epic の詳細（UI-10）。進捗（EP-3）と、Epic のチケットを Status ごとに出す。
// 表示だけで書き込まない。閉じる・再開とチケットの足し外しは、タイトルと行の吹き出し・右クリックからエージェントに頼む（ADR-010・UI-15）。
// 一覧の画面は持たない（open はバックログの欄、closed は履歴）。
// VS Code（パネル）ではチケットを未完了・完了・中止の小見出しの付いた 1 本の一覧にする（カンバンはサイドバーで見る。UI-12）。ブラウザは Status ごとの列

import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import {
  PriorityMark,
  ProgressBar,
  StatusDot,
  TicketLink,
  TicketRow,
} from "../components/parts.js";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import {
  EPIC_LABELS,
  STATUSES,
  byPriorityThenNumber,
  isFinished,
  type EpicDetail,
  type Status,
} from "../types.js";

export function EpicsPage({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  const webview = host.surface !== "browser";
  // 一覧のチケットか Epic が読み直されたら Epic も読み直す
  const { data: epic, error } = useCommandData<EpicDetail>("epic.show", { epic: id }, store.epics);

  if (error) return <p className="error">{error}</p>;
  if (!epic) return <p className="muted">読み込み中…</p>;

  return (
    <section>
      {/* パネルは詳細だけを出すので、戻る先の一覧がない（一覧はサイドバー。UI-12） */}
      {webview ? null : (
        <div className="toolbar">
          <a href={hrefOf({ page: "backlog" })}>← バックログ</a>
        </div>
      )}
      <header className="detail-header">
        {/* タイトルの横の吹き出しと右クリックで、この Epic をエージェントに頼む（UI-15） */}
        <AskSpotBox
          as="h1"
          className="ask-title"
          targets={[epic.id]}
          label={`タイトル ${epic.id}`}
          section={ASK_SECTIONS.detailTitle}
          pinned
        >
          <code>{epic.id}</code> {epic.title}{" "}
          <span className="badge">{EPIC_LABELS[epic.status]}</span>
        </AskSpotBox>
        <ProgressBar progress={epic.progress} />
      </header>
      <div className="actions">
        <a href={hrefOf({ page: "board", epic: epic.id })}>この Epic でカンバンを見る</a>
      </div>
      <Markdown body={epic.body} />
      <h2>チケット</h2>
      {webview ? (
        <EpicTicketList epic={epic} />
      ) : (
        <div className="groups">
          {STATUSES.map((s) => {
            const items = epic.tickets.filter((t) => t.status === s).sort(byPriorityThenNumber);
            if (items.length === 0 && s === "abandoned") return null;
            return (
              <div key={s} className="column">
                <h2>
                  <StatusDot status={s} />
                  <span>{store.labelOf(s)}</span>
                  <span className="muted">{items.length}</span>
                </h2>
                {items.length === 0 ? <p className="empty">なし</p> : null}
                {items.map((t) => (
                  <div key={t.id} className={`card status-${s}`} style={{ cursor: "default" }}>
                    <div className="meta">
                      <TicketLink id={t.id} />
                      <PriorityMark priority={t.priority} />
                    </div>
                    <div className="title">{t.title}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 一覧の段。未完了は開いたまま、完了と中止は既定で畳む。0 件の段は出さない */
const EPIC_SECTIONS = [
  { key: "open", label: "未完了", folded: false },
  { key: "done", label: "完了", folded: true },
  { key: "abandoned", label: "中止", folded: true },
] as const;

function sectionOf(status: Status): (typeof EPIC_SECTIONS)[number]["key"] {
  return isFinished(status) ? status : "open";
}

/**
 * VS Code（パネル）の Epic のチケットの一覧。未完了・完了・中止の段ごとに小見出しと件数を付け、行はサイドバーと同じ 1 行（TicketRow）。
 * 段の中は Status の順（Workflow の並び）、同じ Status なら優先度と番号の順
 */
function EpicTicketList({ epic }: { epic: EpicDetail }) {
  const order = new Map<string, number>(STATUSES.map((s, i) => [s, i]));
  const sorted = [...epic.tickets].sort(
    (a, b) => (order.get(a.status) ?? 0) - (order.get(b.status) ?? 0) || byPriorityThenNumber(a, b),
  );
  return (
    <div className="epic-tickets">
      {EPIC_SECTIONS.map((section) => {
        const items = sorted.filter((t) => sectionOf(t.status) === section.key);
        if (items.length === 0) return null;
        return (
          <details key={section.key} className="fold" open={!section.folded}>
            <summary>
              {section.label} <span className="muted">{items.length}</span>
            </summary>
            <ul className="rows">
              {/* 行の吹き出しと右クリックで頼める。この Epic を within に渡し、「e2 から外す」を候補に足す。Ctrl/⌘・Shift+クリックで複数選べる（UI-15） */}
              {items.map((t) => (
                <AskSpotBox
                  key={t.id}
                  as="li"
                  targets={[t.id]}
                  label={`行 ${t.id}`}
                  section={ASK_SECTIONS.detailTicket}
                  within={epic.id}
                  select
                >
                  <TicketRow ticket={t} />
                </AskSpotBox>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
