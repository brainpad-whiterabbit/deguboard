// チケット詳細（UI-4）。本文（概要・受け入れ条件）、属性、Epic、依存先と依存元、作業ブランチ、Run の一覧と、経過（deguboard ブランチの履歴）。
// 属性と本文を編集でき、Status は ticket.move と同じ検査を通る

import { useEffect, useState } from "react";
import { PriorityBadge, StatusBadge, Tags, TicketLink } from "../components/parts.js";
import { TicketRuns } from "../components/ticket-runs.js";
import { TicketTimeline } from "../components/timeline.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import {
  PRIORITIES,
  STATUSES,
  type FieldDefinition,
  type Priority,
  type Status,
  type TicketDetail,
} from "../types.js";

interface Draft {
  title: string;
  priority: Priority;
  labels: string;
  epic: string;
  iteration: string;
  assignee: string;
  body: string;
  fields: Record<string, string>;
}

function draftOf(t: TicketDetail, fields: readonly FieldDefinition[]): Draft {
  return {
    title: t.title,
    priority: t.priority,
    labels: t.labels.join(", "),
    epic: t.epic ?? "",
    iteration: t.iteration ?? "",
    assignee: t.assignee ?? "",
    body: t.body,
    fields: Object.fromEntries(
      fields.map((f) => [f.id, t[f.id] === undefined ? "" : String(t[f.id])]),
    ),
  };
}

/** 任意フィールドの入力を Workflow の型に合わせる。空は未指定 */
export function parseFieldValue(def: FieldDefinition, raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  if (def.type === "number") return Number(text);
  if (def.type === "boolean") return text === "true";
  return text;
}

export function TicketPage({ id }: { id: string }) {
  const store = useStore();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const fields = store.workflow?.definition.fields ?? [];

  // 一覧（store.tickets）が読み直されたら本文も読み直す
  useEffect(() => {
    let alive = true;
    store.client
      .run<TicketDetail>("ticket.show", { ticket: id })
      .then((r) => alive && (setTicket(r.data), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, store.client, store.tickets]);

  if (error) return <p className="error">{error}</p>;
  if (!ticket) return <p className="muted">読み込み中…</p>;

  const save = async () => {
    if (!draft) return;
    const patch: Record<string, unknown> = {
      ticket: ticket.id,
      title: draft.title,
      priority: draft.priority,
      labels: draft.labels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      epic: draft.epic || null,
      iteration: draft.iteration || null,
      assignee: draft.assignee.trim() || null,
      body: draft.body,
    };
    const values = Object.fromEntries(
      fields
        .map((f) => [f.id, parseFieldValue(f, draft.fields[f.id] ?? "")])
        .filter(([, v]) => v !== undefined),
    );
    if (Object.keys(values).length) patch["fields"] = values;
    const r = await store.run("ticket.update", patch);
    if (r.ok) setDraft(null);
  };

  const move = async (status: Status) => {
    if (status !== ticket.status) await store.run("ticket.move", { ticket: ticket.id, status });
  };

  const dependsOn = ticket.depends_on.map(
    (d) => store.tickets.find((t) => t.id === d) ?? { id: d, title: "" },
  );
  const dependents = ticket.dependents.map(
    (d) => store.tickets.find((t) => t.id === d) ?? { id: d, title: "" },
  );

  return (
    <section className="detail">
      <div>
        <header>
          <code>{ticket.id}</code>
          {draft ? (
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              aria-label="タイトル"
              style={{ flex: 1 }}
            />
          ) : (
            <h1>{ticket.title}</h1>
          )}
        </header>
        {draft ? (
          <textarea
            className="body"
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            aria-label="本文"
          />
        ) : (
          <Markdown body={ticket.body} />
        )}
        <div className="actions">
          {draft ? (
            <>
              <button type="button" className="primary" onClick={() => void save()}>
                保存
              </button>
              <button type="button" onClick={() => setDraft(null)}>
                取り消し
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setDraft(draftOf(ticket, fields))}>
              編集
            </button>
          )}
        </div>
        <TicketRuns id={ticket.id} />
        <TicketTimeline id={ticket.id} />
      </div>
      <aside>
        <dl className="props">
          <dt>Status</dt>
          <dd>
            <select
              value={ticket.status}
              onChange={(e) => void move(e.target.value as Status)}
              aria-label="Status"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {store.labelOf(s)}
                </option>
              ))}
            </select>
          </dd>
          <dt>優先度</dt>
          <dd>
            {draft ? (
              <select
                value={draft.priority}
                onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}
                aria-label="優先度"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              <PriorityBadge priority={ticket.priority} />
            )}
          </dd>
          <dt>ラベル</dt>
          <dd>
            {draft ? (
              <input
                value={draft.labels}
                onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
                placeholder="カンマ区切り"
                aria-label="ラベル"
              />
            ) : (
              <Tags labels={ticket.labels} />
            )}
          </dd>
          <dt>Epic</dt>
          <dd>
            {draft ? (
              <select
                value={draft.epic}
                onChange={(e) => setDraft({ ...draft, epic: e.target.value })}
                aria-label="Epic"
              >
                <option value="">なし</option>
                {store.epics
                  .filter((e) => e.status === "open" || e.id === ticket.epic)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.id} {e.title}
                    </option>
                  ))}
              </select>
            ) : ticket.epic ? (
              <a href={hrefOf({ page: "epics", id: ticket.epic })}>
                {ticket.epic} {store.epics.find((e) => e.id === ticket.epic)?.title ?? ""}
              </a>
            ) : (
              <span className="muted">なし</span>
            )}
          </dd>
          <dt>Iteration</dt>
          <dd>
            {draft ? (
              <select
                value={draft.iteration}
                onChange={(e) => setDraft({ ...draft, iteration: e.target.value })}
                aria-label="Iteration"
              >
                <option value="">なし</option>
                {store.iterations
                  .filter((i) => i.status !== "closed" || i.id === ticket.iteration)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} {i.name}
                    </option>
                  ))}
              </select>
            ) : ticket.iteration ? (
              <a href={hrefOf({ page: "iterations", id: ticket.iteration })}>{ticket.iteration}</a>
            ) : (
              <span className="muted">なし</span>
            )}
          </dd>
          {fields.map((f) => (
            <FieldRow key={f.id} def={f} draft={draft} setDraft={setDraft} value={ticket[f.id]} />
          ))}
          <dt>依存先</dt>
          <dd>
            {dependsOn.length ? (
              dependsOn.map((d) => (
                <div key={d.id}>
                  <TicketLink id={d.id} title={d.title} />
                  {"status" in d ? (
                    <>
                      {" "}
                      <StatusBadge status={d.status} />
                    </>
                  ) : null}
                </div>
              ))
            ) : (
              <span className="muted">なし</span>
            )}
            {!ticket.deps_done && <div className="muted">依存先が終わっていない</div>}
          </dd>
          <dt>依存元</dt>
          <dd>
            {dependents.length ? (
              dependents.map((d) => (
                <div key={d.id}>
                  <TicketLink id={d.id} title={d.title} />
                </div>
              ))
            ) : (
              <span className="muted">なし</span>
            )}
          </dd>
          <dt>担当</dt>
          <dd>
            {draft ? (
              <input
                value={draft.assignee}
                onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
                placeholder="eiki か eiki/agent"
                aria-label="担当"
              />
            ) : (
              (ticket.assignee ?? <span className="muted">なし</span>)
            )}
          </dd>
          <dt>ブランチ</dt>
          <dd>
            {ticket.branch ? <code>{ticket.branch}</code> : <span className="muted">なし</span>}
          </dd>
          <dt>PR</dt>
          <dd>{ticket.pr ? `#${ticket.pr}` : <span className="muted">なし</span>}</dd>
          <dt>起票者</dt>
          <dd>{ticket.created_by ?? <span className="muted">不明</span>}</dd>
          <dt>作成</dt>
          <dd>{ticket.created_at}</dd>
          <dt>更新</dt>
          <dd>{ticket.updated_at}</dd>
        </dl>
      </aside>
    </section>
  );
}

function FieldRow({
  def,
  draft,
  setDraft,
  value,
}: {
  def: FieldDefinition;
  draft: Draft | null;
  setDraft: (d: Draft) => void;
  value: unknown;
}) {
  const label = def.label ?? def.id;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {draft ? (
          def.type === "enum" || def.type === "boolean" ? (
            <select
              value={draft.fields[def.id] ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, fields: { ...draft.fields, [def.id]: e.target.value } })
              }
              aria-label={label}
            >
              <option value="">未設定</option>
              {(def.type === "boolean" ? ["true", "false"] : (def.options ?? [])).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
              value={draft.fields[def.id] ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, fields: { ...draft.fields, [def.id]: e.target.value } })
              }
              aria-label={label}
            />
          )
        ) : value === undefined ? (
          <span className="muted">未設定</span>
        ) : (
          String(value)
        )}
      </dd>
    </>
  );
}
