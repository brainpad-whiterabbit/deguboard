// Epic の詳細（UI-10）。進捗（EP-3）と、Epic のチケットを Status ごとに出す。
// 表示だけで書き込まない。閉じる・再開とチケットの足し外しは、タイトルと行の吹き出し・右クリックからエージェントに頼む（ADR-010・UI-15）。
// 一覧の画面は持たない（open はバックログの欄、closed は履歴）。
// VS Code（パネル）ではチケットを未完了・完了・中止の小見出しの付いた 1 本の一覧にする（components/ticket-sections.tsx。Iteration 詳細と共用）（カンバンはサイドバーで見る。UI-12）。ブラウザは Status ごとの列

import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import { PriorityMark, ProgressBar, StatusDot, TicketLink } from "../components/parts.js";
import { TicketSections } from "../components/ticket-sections.js";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { EPIC_LABELS, STATUSES, byPriorityThenNumber, type EpicDetail } from "../types.js";

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
        <TicketSections
          tickets={epic.tickets}
          within={epic.id}
          section={ASK_SECTIONS.detailTicket}
        />
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
