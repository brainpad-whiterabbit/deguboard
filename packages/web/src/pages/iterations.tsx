// Iteration（UI-5）の詳細：期間・目標と中のチケット。一覧の画面はなく、planned と active はカンバンの絞り込みで選ぶ（board.tsx）。
// 表示だけで書き込まない。開始・閉じる・再開とチケットの足し外しは、タイトルと行の吹き出し・右クリックからエージェントに頼む（ADR-010・UI-15）

import { useEffect, useState } from "react";
import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import { TicketTable } from "../components/parts.js";
import { NO_VALUE } from "../components/run-parts.js";
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
  const [it, setIt] = useState<IterationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    store.client
      .run<IterationDetail>("iteration.show", { iteration: id })
      .then((r) => alive && (setIt(r.data), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, store.client, store.iterations, store.tickets]);

  if (error) return <p className="error">{error}</p>;
  if (!it) return <p className="muted">読み込み中…</p>;

  const items = [...it.items].sort(byPriorityThenNumber);

  return (
    <section>
      {/* パネルは詳細だけを出すので、戻る先の一覧がない（一覧はサイドバー。UI-12） */}
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
      <p className="muted">
        {it.start ?? "?"} 〜 {it.end ?? "?"}
        {it.goal ? ` ・ ${it.goal}` : ""}
        {it.status === "closed"
          ? ` ・ 完了 ${it.completed ?? NO_VALUE} / 持ち越し ${it.carried_over ?? NO_VALUE}`
          : ""}
      </p>
      <TicketTable tickets={items} ask={{ section: ASK_SECTIONS.detailTicket, within: it.id }} />
    </section>
  );
}
