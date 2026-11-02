// Iteration（UI-5）の詳細：チケットの追加・除外、開始・終了。一覧の画面はなく、planned と active はカンバンの絞り込みで選ぶ（board.tsx）。
// 作成のフォームと開始・閉じるのボタンは components/iteration-parts.tsx に置く。作成のフォームはカンバン（サイドバーでは札の列の「+」から）とバックログから、
// 開始・閉じるのボタンは広い画面のカンバンとバックログの区画の見出しから使う。この詳細の画面は自前の開始・閉じるのボタンを持ち（サイドバーではここで行う）、
// 確認の文に添える ITERATION_CLOSE_NOTE だけを共用する

import { useEffect, useState } from "react";
import { ITERATION_CLOSE_NOTE } from "../components/iteration-parts.js";
import { CloseButton, TicketTable, unfinishedCount } from "../components/parts.js";
import { NO_VALUE } from "../components/run-parts.js";
import { useHost } from "../host.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import {
  byNumber,
  byPriorityThenNumber,
  ITERATION_LABELS,
  type IterationDetail,
} from "../types.js";

export function IterationsPage({ id }: { id: string }) {
  return <IterationDetailView id={id} />;
}

function IterationDetailView({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  const [it, setIt] = useState<IterationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

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

  const members = new Set(it.items.map((t) => t.id));
  const candidates = store.tickets
    .filter((t) => !members.has(t.id) && t.status !== "done" && t.status !== "abandoned")
    .sort(byNumber);
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
      <h1>
        <code>{it.id}</code> {it.name}{" "}
        <span className={`badge iteration-${it.status}`}>{ITERATION_LABELS[it.status]}</span>
      </h1>
      <p className="muted">
        {it.start ?? "?"} 〜 {it.end ?? "?"}
        {it.goal ? ` ・ ${it.goal}` : ""}
        {it.status === "closed"
          ? ` ・ 完了 ${it.completed ?? NO_VALUE} / 持ち越し ${it.carried_over ?? NO_VALUE}`
          : ""}
      </p>
      <div className="actions">
        {it.status === "planned" && (
          <button
            type="button"
            className="primary"
            onClick={() => void store.run("iteration.start", { iteration: it.id })}
          >
            開始する
          </button>
        )}
        {it.status !== "closed" && (
          <CloseButton
            subject={`${it.id} ${it.name}`}
            unfinished={unfinishedCount(it.items)}
            note={ITERATION_CLOSE_NOTE}
            onClose={() => void store.run("iteration.close", { iteration: it.id })}
          />
        )}
        {it.status === "closed" && (
          <button
            type="button"
            onClick={() => void store.run("iteration.reopen", { iteration: it.id })}
          >
            再開する
          </button>
        )}
      </div>
      {it.status !== "closed" && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding)
              void store
                .run("iteration.add", { iteration: it.id, tickets: [adding] })
                .then(() => setAdding(""));
          }}
        >
          <select
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            aria-label="足すチケット"
          >
            <option value="">チケットを選ぶ</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} {t.title}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!adding}>
            足す
          </button>
        </form>
      )}
      <TicketTable
        tickets={items}
        extra={
          it.status !== "closed"
            ? (t) => (
                <button
                  type="button"
                  onClick={() =>
                    void store.run("iteration.remove", { iteration: it.id, tickets: [t.id] })
                  }
                >
                  外す
                </button>
              )
            : undefined
        }
      />
    </section>
  );
}
