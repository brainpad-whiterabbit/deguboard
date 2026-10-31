// Iteration（UI-5）。一覧と、選んだ Iteration のチケット。チケットの追加・除外、開始・終了

import { useEffect, useState } from "react";
import { TicketTable } from "../components/parts.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { byNumber, byPriorityThenNumber, type IterationDetail } from "../types.js";

export function IterationsPage({ id }: { id?: string | undefined }) {
  return id ? <IterationDetailView id={id} /> : <IterationList />;
}

function IterationList() {
  const store = useStore();
  const [showClosed, setShowClosed] = useState(false);
  const [form, setForm] = useState({ name: "", goal: "", start: "", end: "" });
  const rows = store.iterations.filter((i) => showClosed || i.status !== "closed").sort(byNumber);
  const create = async () => {
    if (!form.name.trim() || !store.project) return;
    const r = await store.run("iteration.create", {
      project: store.project.id,
      name: form.name.trim(),
      ...(form.goal.trim() ? { goal: form.goal.trim() } : {}),
      ...(form.start ? { start: form.start } : {}),
      ...(form.end ? { end: form.end } : {}),
    });
    if (r.ok) setForm({ name: "", goal: "", start: "", end: "" });
  };
  return (
    <section>
      <div className="toolbar">
        <h1>Iteration</h1>
        <label>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          閉じたものも出す
        </label>
      </div>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="名前"
          aria-label="名前"
        />
        <input
          value={form.goal}
          onChange={(e) => setForm({ ...form, goal: e.target.value })}
          placeholder="目標"
          aria-label="目標"
        />
        <input
          type="date"
          value={form.start}
          onChange={(e) => setForm({ ...form, start: e.target.value })}
          aria-label="開始日"
        />
        <input
          type="date"
          value={form.end}
          onChange={(e) => setForm({ ...form, end: e.target.value })}
          aria-label="終了日"
        />
        <button type="submit" className="primary" disabled={!form.name.trim()}>
          作る
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="empty">Iteration はない</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>番号</th>
              <th>名前</th>
              <th>状態</th>
              <th>期間</th>
              <th>目標</th>
              <th>チケット</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td>
                  <a href={hrefOf({ page: "iterations", id: i.id })}>
                    <code>{i.id}</code>
                  </a>
                </td>
                <td>
                  <a href={hrefOf({ page: "iterations", id: i.id })}>{i.name}</a>
                </td>
                <td>{i.status}</td>
                <td>
                  {i.start ?? ""}
                  {i.start || i.end ? " 〜 " : ""}
                  {i.end ?? ""}
                </td>
                <td>{i.goal}</td>
                <td>{store.tickets.filter((t) => t.iteration === i.id).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function IterationDetailView({ id }: { id: string }) {
  const store = useStore();
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
      <div className="toolbar">
        <a href={hrefOf({ page: "iterations" })}>← Iteration 一覧</a>
      </div>
      <h1>
        <code>{it.id}</code> {it.name} <span className="badge">{it.status}</span>
      </h1>
      <p className="muted">
        {it.start ?? "?"} 〜 {it.end ?? "?"}
        {it.goal ? ` ・ ${it.goal}` : ""}
        {it.status === "closed"
          ? ` ・ 完了 ${it.completed ?? 0} / 持ち越し ${it.carried_over ?? 0}`
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
          <button
            type="button"
            onClick={() => void store.run("iteration.close", { iteration: it.id })}
          >
            閉じる
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
