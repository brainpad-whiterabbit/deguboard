// Iteration（UI-5）の詳細：期間・目標・進捗と中のチケット。見出しの下の欄は IterationSummary（iteration-parts.tsx）、状態に応じた次の操作の案内は IterationNext（iteration-next.tsx）、中のチケットを含む Plan の節は IterationPlans（iteration-plans.tsx）。一覧の画面はなく、planned と active はカンバンの絞り込みで選ぶ（board.tsx）。
// 表示だけで書き込まない。名前・目標・期間の直し・閉じる・再開とチケットの足し外しは、タイトルと行の吹き出し・右クリックからエージェントに頼む
// （ADR-010・UI-15）。開始は頼むことになく、着手（claim）の手順が planned の Iteration を active にする（ADR-006）

import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import { IterationNext } from "../components/iteration-next.js";
import { IterationPlans } from "../components/iteration-plans.js";
import { IterationSummary } from "../components/iteration-parts.js";
import { TicketTable } from "../components/parts.js";
import { TicketSections } from "../components/ticket-sections.js";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { byPriorityThenNumber, ITERATION_LABELS, type IterationDetail } from "../types.js";

export function IterationsPage({ id }: { id: string }) {
  return <IterationDetailView id={id} />;
}

function IterationDetailView({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  // 一覧のチケットか Iteration が読み直されたら Iteration も読み直す
  const { data: it, error } = useCommandData<IterationDetail>(
    "iteration.show",
    { iteration: id },
    store.iterations,
  );

  if (error) return <p className="error">{error}</p>;
  if (!it) return <p className="muted">読み込み中…</p>;

  const items = [...it.items].sort(byPriorityThenNumber);

  return (
    <section>
      {/* パネルは詳細だけを出すので、戻る先の一覧がない（一覧はサイドバー。カンバンへは下の「この Iteration でカンバンを見る」。UI-12） */}
      {host.surface === "panel" ? null : (
        <div className="toolbar">
          <a
            href={hrefOf(
              it.status === "closed" ? { page: "board" } : { page: "board", iteration: it.id },
            )}
          >
            ← カンバン
          </a>
        </div>
      )}
      {/* タイトルの横の吹き出しと右クリックで、この Iteration をエージェントに頼む（UI-15） */}
      <AskSpotBox
        as="h1"
        className="ask-title"
        targets={[it.id]}
        label={`タイトル ${it.id}`}
        section={ASK_SECTIONS.detailTitle}
        pinned
      >
        <code>{it.id}</code> {it.name}{" "}
        <span className={`badge iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
      </AskSpotBox>
      <IterationSummary it={it} />
      {/* 状態に応じた次の操作の案内と依頼文のコピー（書き込まない） */}
      <IterationNext it={it} />
      {/* パネルからはこの Iteration で絞った左パネルのカンバンを開く（一覧の画面へのリンクは host.show でサイドバーに出る。UI-12）。
          閉じた Iteration はカンバンで選べないので出さない */}
      {host.surface === "panel" && it.status !== "closed" ? (
        <div className="actions">
          <a href={hrefOf({ page: "board", iteration: it.id })}>この Iteration でカンバンを見る</a>
        </div>
      ) : null}
      {/* 中のチケットを含む Plan（なければ節を出さない） */}
      <IterationPlans plans={it.plans} />
      {/* パネルは未完了・完了・中止の段に分けた 1 行の並び（Epic 詳細と共用。UI-12）。ブラウザは表 */}
      {host.surface === "panel" ? (
        <TicketSections tickets={it.items} within={it.id} section={ASK_SECTIONS.detailTicket} />
      ) : (
        <TicketTable tickets={items} ask={{ section: ASK_SECTIONS.detailTicket, within: it.id }} />
      )}
    </section>
  );
}
