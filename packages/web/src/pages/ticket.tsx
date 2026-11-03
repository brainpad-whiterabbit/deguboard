// チケット詳細（UI-4）。本文（概要・受け入れ条件）、属性、Epic、依存先と依存元、作業ブランチ、Run の一覧と、経過（deguboard ブランチの履歴）。
// 属性と本文を編集でき、Status は ticket.move と同じ検査を通る。パネルの Status の選択には Workflow で今から移れる Status だけを並べる。
// VS Code のパネルでは、タイトルの下に Status・優先度・Iteration・担当・PR の 1 行と編集のボタンを置いてスクロールしても上に残す。
// パネルでは依存先が終わっていなければ本文の上の帯で知らせ、依存先・依存元に Status の丸印を付ける（終わった依存先は薄く）。
// 右の列は幅を固定し、Status の選択を先頭に、属性を「計画・つながり・作業・記録」の見出しで分け、値のない属性は最後の 1 行にまとめる。
// 作成・更新は経過と同じ手元時刻で、今年なら年を省く。ブランチ名の右にコピーのボタンを置く

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { CopyableCode } from "../components/copyable-code.js";
import { PriorityBadge, StatusBadge, StatusDot, Tags, TicketLink } from "../components/parts.js";
import { TicketRuns } from "../components/ticket-runs.js";
import { formatTime, TicketTimeline } from "../components/timeline.js";
import { useHost } from "../host.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import {
  movableStatuses,
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
function parseFieldValue(def: FieldDefinition, raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  if (def.type === "number") return Number(text);
  if (def.type === "boolean") return text === "true";
  return text;
}

export function TicketPage({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  const panel = host.surface === "panel";
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
  /** 依存先・依存元の 1 行。パネルでは頭に Status の丸印を付け、終わった（done・abandoned）依存先は薄くする */
  const relation = (d: (typeof dependsOn)[number], dimDone: boolean) => (
    <div
      key={d.id}
      className={
        panel && dimDone && "status" in d && finished(d.status) ? "dep-finished" : undefined
      }
    >
      {panel && "status" in d ? <StatusDot status={d.status} /> : null}
      <TicketLink id={d.id} title={d.title} />
      {!panel && dimDone && "status" in d ? (
        <>
          {" "}
          <StatusBadge status={d.status} />
        </>
      ) : null}
    </div>
  );
  // 終わっていない依存先（WF-2 の deps_done と同じく done・abandoned 以外。一覧にない依存先は Status が分からないので含める）
  const pendingDeps = dependsOn.filter((d) => !("status" in d) || !finished(d.status));
  // パネルで見ているとき（編集中でないとき）は、値のない属性を行にせず最後の「なし」の 1 行にまとめる
  const emptyLabels =
    panel && !draft
      ? [
          ticket.labels.length === 0 && "ラベル",
          !ticket.epic && "Epic",
          !ticket.iteration && "Iteration",
          ...fields.filter((f) => ticket[f.id] === undefined).map((f) => f.label ?? f.id),
          dependsOn.length === 0 && "依存先",
          dependents.length === 0 && "依存元",
          !ticket.assignee && "担当",
          !ticket.branch && "ブランチ",
          !ticket.pr && "PR",
        ].filter((l): l is string => typeof l === "string")
      : [];
  const shown = (label: string) => !emptyLabels.includes(label);
  const editButtons = draft ? (
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
      {panel ? "本文と属性を編集" : "編集"}
    </button>
  );

  /** 属性の 1 行（dt と dd）。パネルで値がなく「なし」にまとめた属性は出さない */
  const row = (label: string, value: ReactNode) =>
    shown(label) ? (
      <Fragment key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </Fragment>
    ) : null;
  const rows = {
    status: row(
      "Status",
      <select
        value={ticket.status}
        onChange={(e) => void move(e.target.value as Status)}
        aria-label="Status"
      >
        {(panel
          ? movableStatuses(ticket.status, store.workflow?.transitions ?? [], store.me?.kind)
          : STATUSES
        ).map((s) => (
          <option key={s} value={s}>
            {store.labelOf(s)}
          </option>
        ))}
      </select>,
    ),
    priority: row(
      "優先度",
      draft ? (
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
      ),
    ),
    labels: row(
      "ラベル",
      draft ? (
        <input
          value={draft.labels}
          onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
          placeholder="カンマ区切り"
          aria-label="ラベル"
        />
      ) : (
        <Tags labels={ticket.labels} />
      ),
    ),
    epic: row(
      "Epic",
      draft ? (
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
      ),
    ),
    iteration: row(
      "Iteration",
      draft ? (
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
      ),
    ),
    fields: fields.map((f) =>
      row(
        f.label ?? f.id,
        <FieldValue def={f} draft={draft} setDraft={setDraft} value={ticket[f.id]} />,
      ),
    ),
    dependsOn: row(
      "依存先",
      <>
        {dependsOn.length ? (
          dependsOn.map((d) => relation(d, true))
        ) : (
          <span className="muted">なし</span>
        )}
        {!ticket.deps_done && !panel && <div className="muted">依存先が終わっていない</div>}
      </>,
    ),
    dependents: row(
      "依存元",
      dependents.length ? (
        dependents.map((d) => relation(d, false))
      ) : (
        <span className="muted">なし</span>
      ),
    ),
    assignee: row(
      "担当",
      draft ? (
        <input
          value={draft.assignee}
          onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
          placeholder="eiki か eiki/agent"
          aria-label="担当"
        />
      ) : (
        (ticket.assignee ?? <span className="muted">なし</span>)
      ),
    ),
    branch: row(
      "ブランチ",
      ticket.branch ? (
        <CopyableCode text={ticket.branch} label="ブランチ名をコピー" />
      ) : (
        <span className="muted">なし</span>
      ),
    ),
    pr: row(
      "PR",
      ticket.pr ? (
        <PrLink pr={ticket.pr} webUrl={store.status?.web_url} />
      ) : (
        <span className="muted">なし</span>
      ),
    ),
    createdBy: row("起票者", ticket.created_by ?? <span className="muted">不明</span>),
    created: row("作成", <DateTime iso={ticket.created_at} local={panel} />),
    updated: row("更新", <DateTime iso={ticket.updated_at} local={panel} />),
    empty:
      emptyLabels.length > 0 ? (
        <>
          <dt>なし</dt>
          <dd className="muted props-empty">{emptyLabels.join("・")}</dd>
        </>
      ) : null,
  };
  // パネルでは属性を「計画・つながり・作業・記録」の見出しで分ける。値のある行が 1 つもない見出しは出さない
  const groups = [
    {
      title: "計画",
      items: [rows.iteration, rows.epic, rows.assignee, rows.priority, rows.labels, ...rows.fields],
    },
    { title: "つながり", items: [rows.dependsOn, rows.dependents] },
    { title: "作業", items: [rows.branch, rows.pr] },
    { title: "記録", items: [rows.createdBy, rows.created, rows.updated] },
  ];

  const header = (
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
  );

  return (
    <section className="detail">
      <div className="detail-main">
        {panel ? (
          // 見出しの帯。表示だけで、Status を変えるのは右の列の選択
          <div className="detail-head">
            {header}
            <div className="detail-meta">
              <span className="detail-meta-status">
                <StatusDot status={ticket.status} />
                {store.labelOf(ticket.status)}
              </span>
              <PriorityBadge priority={ticket.priority} />
              {ticket.iteration ? (
                <a href={hrefOf({ page: "iterations", id: ticket.iteration })}>
                  {ticket.iteration}
                </a>
              ) : null}
              {ticket.assignee ? <span>{ticket.assignee}</span> : null}
              {ticket.pr ? <PrLink pr={ticket.pr} webUrl={store.status?.web_url} /> : null}
              <div className="actions header-actions">{editButtons}</div>
            </div>
          </div>
        ) : (
          header
        )}
        {panel && !ticket.deps_done ? (
          <p className="notice info deps-band" role="status">
            <span>
              依存先が終わっていない：
              {pendingDeps.map((d) => (
                <span key={d.id} className="deps-band-item">
                  {"status" in d ? <StatusDot status={d.status} /> : null}
                  <TicketLink id={d.id}>
                    <code>{d.id}</code>
                  </TicketLink>
                  {"status" in d ? store.labelOf(d.status) : null}
                </span>
              ))}
            </span>
          </p>
        ) : null}
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
        {panel ? null : <div className="actions">{editButtons}</div>}
        <TicketRuns id={ticket.id} />
        <TicketTimeline id={ticket.id} />
      </div>
      <aside>
        {panel ? (
          // パネル：Status の選択を先頭に置き、属性は見出しで分ける。値のない属性の「なし」は最後
          <div className="props props-groups">
            <dl>{rows.status}</dl>
            {groups
              .filter(({ items }) => items.some(Boolean))
              .map(({ title, items }) => (
                <section key={title} aria-label={title}>
                  <h2 className="props-group-title">{title}</h2>
                  <dl>{items}</dl>
                </section>
              ))}
            <dl>{rows.empty}</dl>
          </div>
        ) : (
          <dl className="props">
            {rows.status}
            {rows.priority}
            {rows.labels}
            {rows.epic}
            {rows.iteration}
            {rows.fields}
            {rows.dependsOn}
            {rows.dependents}
            {rows.assignee}
            {rows.branch}
            {rows.pr}
            {rows.createdBy}
            {rows.created}
            {rows.updated}
          </dl>
        )}
      </aside>
    </section>
  );
}

/** 依存を待たない Status か（WF-2。やめたチケットは待たない） */
function finished(status: Status): boolean {
  return status === "done" || status === "abandoned";
}

function FieldValue({
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
  if (!draft)
    return value === undefined ? <span className="muted">未設定</span> : <>{String(value)}</>;
  const set = (v: string) => setDraft({ ...draft, fields: { ...draft.fields, [def.id]: v } });
  return def.type === "enum" || def.type === "boolean" ? (
    <select
      value={draft.fields[def.id] ?? ""}
      onChange={(e) => set(e.target.value)}
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
      onChange={(e) => set(e.target.value)}
      aria-label={label}
    />
  );
}

/** PR の番号。リモートの Web の URL が分かればそのページへのリンクにする */
function PrLink({ pr, webUrl }: { pr: number; webUrl?: string | null | undefined }) {
  if (!webUrl) return <>#{pr}</>;
  return (
    <a href={`${webUrl}/pull/${pr}`} target="_blank" rel="noreferrer">
      #{pr}
    </a>
  );
}

/** 手元時刻の日時（2026-11-01 13:48）。now と同じ年なら年を省く（11-01 13:48） */
export function formatShortTime(iso: string, now: Date = new Date()): string {
  const text = formatTime(iso);
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getFullYear() === now.getFullYear()
    ? text.slice(text.indexOf("-") + 1)
    : text;
}

/** 日時。local なら手元時刻で今年なら年を省いて出し、ISO の値はツールチップに。そうでなければ ISO のまま */
function DateTime({ iso, local }: { iso: string; local: boolean }) {
  if (!local) return <>{iso}</>;
  return (
    <time dateTime={iso} title={iso}>
      {formatShortTime(iso)}
    </time>
  );
}
