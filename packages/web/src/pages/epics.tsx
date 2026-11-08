// Epic の詳細（UI-10）。進捗（EP-3）と、Epic のチケットを出す。
// 表示だけで書き込まない。閉じる・再開とチケットの足し外しは、タイトルと行の吹き出しからエージェントに頼む（ADR-010・UI-15）。
// 一覧の画面は持たない（open はバックログの欄、closed は履歴）。
// チケットは未完了・完了・中止の小見出しの付いた 1 本の一覧にする（components/ticket-sections.tsx。Iteration 詳細と共用）（カンバンはサイドバーで見る。UI-12）

import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import { ProgressBar } from "../components/parts.js";
import { TicketSections } from "../components/ticket-sections.js";
import { useCommandData } from "../command-data.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { EPIC_LABELS, type EpicDetail } from "../types.js";
import { tr } from "../l10n.js";

export function EpicsPage({ id }: { id: string }) {
  const store = useStore();
  // 一覧のチケットか Epic が読み直されたら Epic も読み直す
  const { data: epic, error } = useCommandData<EpicDetail>("epic.show", { epic: id }, store.epics);

  if (error) return <p className="error">{error}</p>;
  if (!epic) return <p className="muted">{tr("読み込み中…")}</p>;

  // パネルは詳細だけを出すので、戻る先の一覧を置かない（一覧はサイドバー。UI-12）
  return (
    <section>
      <header className="detail-header">
        {/* タイトルの横の吹き出しで、この Epic をエージェントに頼む（UI-15） */}
        <AskSpotBox
          as="h1"
          className="ask-title"
          targets={[epic.id]}
          label={tr("タイトル {0}", epic.id)}
          section={ASK_SECTIONS.detailTitle}
          pinned
        >
          <code>{epic.id}</code> {epic.title}{" "}
          <span className="badge">{tr(EPIC_LABELS[epic.status])}</span>
        </AskSpotBox>
        <ProgressBar progress={epic.progress} />
      </header>
      <div className="actions">
        <a href={hrefOf({ page: "board", epic: epic.id })}>{tr("この Epic でカンバンを見る")}</a>
      </div>
      <Markdown body={epic.body} />
      <h2>{tr("チケット")}</h2>
      <TicketSections tickets={epic.tickets} within={epic.id} section={ASK_SECTIONS.detailTicket} />
    </section>
  );
}
