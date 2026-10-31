// Epic（UI-10）。一覧と進捗（EP-3）、選んだ Epic のチケットを Status ごとに出す。チケットの追加・除外、閉じる・再開

import { useEffect, useState } from "react";
import { PriorityBadge, ProgressBar, StatusDot, TicketLink } from "../components/parts.js";
import { useHost } from "../host.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { STATUSES, byNumber, byPriorityThenNumber, type EpicDetail } from "../types.js";

export function EpicsPage({ id }: { id?: string | undefined }) {
  return id ? <EpicDetailView id={id} /> : <EpicList />;
}

function EpicList() {
  const store = useStore();
  const host = useHost();
  const [showClosed, setShowClosed] = useState(false);
  const [title, setTitle] = useState("");
  const rows = store.epics.filter((e) => showClosed || e.status === "open").sort(byNumber);
  const create = async () => {
    if (!title.trim() || !store.project) return;
    const r = await store.run("epic.create", { title: title.trim(), project: store.project.id });
    if (r.ok) setTitle("");
  };
  return (
    <section>
      <div className="toolbar">
        <h1>Epic</h1>
        <label>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          閉じたものも出す
        </label>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="新しい Epic の題"
            aria-label="新しい Epic の題"
          />
          <button type="submit" className="primary" disabled={!title.trim()}>
            作る
          </button>
        </form>
      </div>
      {rows.length === 0 ? (
        <p className="empty">Epic はない</p>
      ) : host.surface === "sidebar" ? (
        <ul className="rows">
          {rows.map((e) => (
            <li key={e.id}>
              <a className="row" href={hrefOf({ page: "epics", id: e.id })}>
                <code>{e.id}</code>
                <span className="row-title" title={e.title}>
                  {e.title}
                </span>
                <ProgressBar progress={e.progress} />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>番号</th>
              <th>タイトル</th>
              <th>状態</th>
              <th>進捗</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>
                  <a href={hrefOf({ page: "epics", id: e.id })}>
                    <code>{e.id}</code>
                  </a>
                </td>
                <td>
                  <a href={hrefOf({ page: "epics", id: e.id })}>{e.title}</a>
                </td>
                <td>{e.status}</td>
                <td>
                  <ProgressBar progress={e.progress} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EpicDetailView({ id }: { id: string }) {
  const store = useStore();
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
      <div className="toolbar">
        <a href={hrefOf({ page: "epics" })}>← Epic 一覧</a>
      </div>
      <header className="detail-header">
        <h1>
          <code>{epic.id}</code> {epic.title} <span className="badge">{epic.status}</span>
        </h1>
        <ProgressBar progress={epic.progress} />
      </header>
      <div className="actions">
        <a href={hrefOf({ page: "board", epic: epic.id })}>この Epic でカンバンを見る</a>
        {open ? (
          <button type="button" onClick={() => void store.run("epic.close", { epic: epic.id })}>
            閉じる
          </button>
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
                    {open && (
                      <button
                        type="button"
                        onClick={() =>
                          void store.run("epic.remove", { epic: epic.id, tickets: [t.id] })
                        }
                        title="Epic から外す"
                      >
                        外す
                      </button>
                    )}
                  </div>
                  <div className="title">{t.title}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
