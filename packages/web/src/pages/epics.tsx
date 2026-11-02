// Epic の詳細（UI-10）。進捗（EP-3）と、Epic のチケットを Status ごとに出す。チケットの追加・除外、閉じる・再開。
// 一覧の画面は持たない（open はバックログの欄、closed は履歴）。
// VS Code（パネル）ではチケットを未完了・完了・中止の小見出しの付いた 1 本の一覧にする（カンバンはサイドバーで見る。UI-12）。ブラウザは Status ごとの列

import { useEffect, useState } from "react";
import {
  CloseButton,
  PriorityBadge,
  ProgressBar,
  StatusDot,
  TicketLink,
  TicketRow,
  unfinishedCount,
} from "../components/parts.js";
import { useHost } from "../host.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import {
  EPIC_LABELS,
  STATUSES,
  byNumber,
  byPriorityThenNumber,
  isFinished,
  type EpicDetail,
  type Status,
} from "../types.js";

export function EpicsPage({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  const webview = host.surface !== "browser";
  const [epic, setEpic] = useState<EpicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  useEffect(() => {
    let alive = true;
    store.client
      .run<EpicDetail>("epic.show", { epic: id })
      .then((r) => alive && (setEpic(r.data), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, store.client, store.epics, store.tickets]);

  if (error) return <p className="error">{error}</p>;
  if (!epic) return <p className="muted">読み込み中…</p>;

  const members = new Set(epic.tickets.map((t) => t.id));
  const candidates = store.tickets
    .filter((t) => !members.has(t.id) && t.status !== "abandoned")
    .sort(byNumber);
  const open = epic.status === "open";

  return (
    <section>
      {/* パネルは詳細だけを出すので、戻る先の一覧がない（一覧はサイドバー。UI-12） */}
      {webview ? null : (
        <div className="toolbar">
          <a href={hrefOf({ page: "backlog" })}>← バックログ</a>
        </div>
      )}
      <header className="detail-header">
        <h1>
          <code>{epic.id}</code> {epic.title}{" "}
          <span className="badge">{EPIC_LABELS[epic.status]}</span>
        </h1>
        <ProgressBar progress={epic.progress} />
      </header>
      <div className="actions">
        <a href={hrefOf({ page: "board", epic: epic.id })}>この Epic でカンバンを見る</a>
        {open ? (
          <CloseButton
            subject={`${epic.id} ${epic.title}`}
            unfinished={unfinishedCount(epic.tickets)}
            onClose={() => void store.run("epic.close", { epic: epic.id })}
          />
        ) : (
          <button type="button" onClick={() => void store.run("epic.reopen", { epic: epic.id })}>
            再開する
          </button>
        )}
      </div>
      <Markdown body={epic.body} />
      <h2>チケット</h2>
      {open && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding)
              void store
                .run("epic.add", { epic: epic.id, tickets: [adding] })
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
      {webview ? (
        <EpicTicketList epic={epic} removable={open} />
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
                      <PriorityBadge priority={t.priority} />
                      {open && <RemoveButton epic={epic.id} ticket={t.id} />}
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

/** Epic から外すボタン */
function RemoveButton({ epic, ticket }: { epic: string; ticket: string }) {
  const store = useStore();
  return (
    <button
      type="button"
      onClick={() => void store.run("epic.remove", { epic, tickets: [ticket] })}
      title="Epic から外す"
    >
      外す
    </button>
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
function EpicTicketList({ epic, removable }: { epic: EpicDetail; removable: boolean }) {
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
              {items.map((t) => (
                <li key={t.id}>
                  <TicketRow ticket={t} />
                  {removable && <RemoveButton epic={epic.id} ticket={t.id} />}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
