// チケット詳細（UI-4）。本文（概要・受け入れ条件）、属性、Epic、依存先と依存元、作業ブランチ、Run の一覧と、経過（deguboard ブランチの履歴）。
// 属性と本文を編集でき、Status は ticket.move と同じ検査を通る。パネルの Status の選択には Workflow で今から移れる Status だけを並べる。
// Status の選択・表示名と任意フィールドは、チケット自身の Workflow（なければ Project の既定）で決める。
// VS Code のパネルでは、タイトルの下に Status・優先度・Iteration・担当・PR の 1 行と編集のボタンを置いてスクロールしても上に残す。
// パネルでは依存先が終わっていなければ本文の上の帯で知らせ、依存先・依存元に Status の丸印を付ける（終わった依存先は薄く）。
// 右の列は幅を固定し、Status の選択を先頭に、属性を「計画・つながり・作業・記録」の見出しで分け、値のない属性は最後の 1 行にまとめる。
// パネルの編集のボタンはタイトルと本文だけを入力欄にし、属性は右の列の値を押してその場で直す（確定で ticket.update に 1 属性だけ渡す）。
// 値のない属性は「なし」の行の「＋足す」から選んで値を入れる。ブラウザでは編集のボタンでタイトル・本文・属性をまとめて直す。
// 作成・更新は経過と同じ手元時刻で、今年なら年を省く。ブランチ名の右にコピーのボタンを置く

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { CopyableCode } from "../components/copyable-code.js";
import { ConfirmSelect, InlineEdit, optionsOf, type Choice } from "../components/inline-edit.js";
import { PriorityBadge, StatusBadge, StatusDot, Tags, TicketLink } from "../components/parts.js";
import { TicketRuns } from "../components/ticket-runs.js";
import { formatTime, TicketTimeline } from "../components/timeline.js";
import { useHost } from "../host.js";
import { Markdown } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore, type Store } from "../store.js";
import {
  isFinished,
  movableStatuses,
  PRIORITIES,
  STATUSES,
  type FieldDefinition,
  type Priority,
  type Status,
  type TicketDetail,
  type WorkflowView,
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
    fields: Object.fromEntries(fields.map((f) => [f.id, fieldText(t[f.id])])),
  };
}

/** 任意フィールドの値の文字列（入力欄の値）。未設定は空 */
function fieldText(value: unknown): string {
  return value === undefined ? "" : String(value);
}

/** 任意フィールドの入力を Workflow の型に合わせる。空は未指定 */
function parseFieldValue(def: FieldDefinition, raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  if (def.type === "number") return Number(text);
  if (def.type === "boolean") return text === "true";
  return text;
}

/** カンマ区切りのラベルを一覧にする */
function parseLabels(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 任意フィールドの選択の項目。enum と boolean だけで、ほかは入力欄（undefined） */
function fieldChoices(def: FieldDefinition): Choice[] | undefined {
  if (def.type !== "enum" && def.type !== "boolean") return undefined;
  const options = def.type === "boolean" ? ["true", "false"] : (def.options ?? []);
  return [{ value: "", label: "未設定" }, ...options.map((o) => ({ value: o, label: o }))];
}

/** 任意フィールドの入力欄の型 */
function fieldInputType(def: FieldDefinition): "text" | "number" | "date" {
  return def.type === "number" ? "number" : def.type === "date" ? "date" : "text";
}

/** パネルで値がなければ「なし」の行にまとめる属性 */
interface OptionalAttr {
  /** 行の key と、その場で直している属性の key */
  key: string;
  label: string;
  empty: boolean;
  /** 「＋足す」から値を入れられるか（依存・ブランチ・PR は入れない） */
  addable: boolean;
}

/**
 * チケットの Workflow。チケットの workflow、なければ Project の既定で、core の requireWorkflowFor と同じ解決にする。
 * 一覧が読んだ Project の既定（store.workflow）と同じなら引き直さない。別の Workflow は読み終えるまで null
 */
function useTicketWorkflow(store: Store, ticket: TicketDetail | null): WorkflowView | null {
  const id = ticket
    ? (ticket.workflow ?? store.projects.find((p) => p.id === ticket.project)?.workflow)
    : undefined;
  const other = id !== undefined && id !== store.project?.workflow ? id : null;
  const [loaded, setLoaded] = useState<{ id: string; view: WorkflowView } | null>(null);
  useEffect(() => {
    if (!other) return;
    let alive = true;
    store.client
      .run<WorkflowView>("workflow.show", { workflow: other })
      .then((r) => alive && setLoaded({ id: other, view: r.data }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [other, store.client]);
  if (!other) return store.workflow;
  return loaded?.id === other ? loaded.view : null;
}

const PRIORITY_CHOICES: Choice[] = PRIORITIES.map((p) => ({ value: p, label: p }));

export function TicketPage({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  const panel = host.surface === "panel";
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // パネルでその場で直している属性の key（OptionalAttr の key か "priority"）と、「＋足す」の選択を開いているか
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // その場で直した属性を保存している間は、次の確定を受けない（Enter を素早く 2 回押しても 1 回だけ渡す）
  const saving = useRef(false);
  const workflow = useTicketWorkflow(store, ticket);
  const fields = workflow?.definition.fields ?? [];
  /** このチケットの Status の表示名（依存先・依存元はそれぞれの一覧の表示名のまま） */
  const labelOf = (s: Status) => workflow?.labels[s] ?? store.labelOf(s);

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

  // パネルの編集はタイトルと本文だけ。ブラウザは属性もまとめて渡す
  const save = async () => {
    if (!draft) return;
    const patch: Record<string, unknown> = {
      ticket: ticket.id,
      title: draft.title,
      body: draft.body,
    };
    if (!panel) {
      Object.assign(patch, {
        priority: draft.priority,
        labels: parseLabels(draft.labels),
        epic: draft.epic || null,
        iteration: draft.iteration || null,
        assignee: draft.assignee.trim() || null,
      });
      const values = Object.fromEntries(
        fields
          .map((f) => [f.id, parseFieldValue(f, draft.fields[f.id] ?? "")])
          .filter(([, v]) => v !== undefined),
      );
      if (Object.keys(values).length) patch["fields"] = values;
    }
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
        panel && dimDone && "status" in d && isFinished(d.status) ? "dep-finished" : undefined
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
  const optional: OptionalAttr[] = [
    { key: "labels", label: "ラベル", empty: ticket.labels.length === 0, addable: true },
    { key: "epic", label: "Epic", empty: !ticket.epic, addable: true },
    { key: "iteration", label: "Iteration", empty: !ticket.iteration, addable: true },
    ...fields.map((f) => ({
      key: `field:${f.id}`,
      label: f.label ?? f.id,
      empty: ticket[f.id] === undefined,
      addable: true,
    })),
    { key: "dependsOn", label: "依存先", empty: dependsOn.length === 0, addable: false },
    { key: "dependents", label: "依存元", empty: dependents.length === 0, addable: false },
    { key: "assignee", label: "担当", empty: !ticket.assignee, addable: true },
    { key: "branch", label: "ブランチ", empty: !ticket.branch, addable: false },
    { key: "pr", label: "PR", empty: !ticket.pr, addable: false },
  ];
  // パネルでは値のない属性を行にせず最後の「なし」の 1 行にまとめる（「＋足す」で選んで直している属性は行に出す）
  const emptyAttrs = panel ? optional.filter((a) => a.empty && a.key !== editing) : [];
  const shown = (key: string) => !emptyAttrs.some((a) => a.key === key);

  /**
   * パネルで属性 1 つをその場で直す部品。確定した値を toPatch で ticket.update の入力にし、その属性だけを渡す。
   * 失敗なら欄を開いたままにする。成功なら直したチケットを読み直してから閉じる（「＋足す」で入れた属性が一瞬「なし」に戻らないよう）
   */
  const inline = (
    key: string,
    label: string,
    value: string,
    toPatch: (raw: string) => Record<string, unknown>,
    display: ReactNode,
    opts: {
      choices?: Choice[];
      inputType?: "text" | "number" | "date";
      placeholder?: string;
      normalize?: (raw: string) => string;
    } = {},
  ) => (
    <InlineEdit
      label={label}
      value={value}
      editing={editing === key}
      onStart={() => setEditing(key)}
      onCancel={() => setEditing(null)}
      onCommit={async (raw) => {
        if (saving.current) return false;
        saving.current = true;
        try {
          const r = await store.run("ticket.update", { ticket: ticket.id, ...toPatch(raw) });
          if (!r.ok) return false;
          await store.client
            .run<TicketDetail>("ticket.show", { ticket: ticket.id })
            .then((shown) => setTicket(shown.data))
            .catch(() => {});
          // 保存の間に別の属性を直し始めていたら、その欄は閉じない
          setEditing((current) => (current === key ? null : current));
          return true;
        } finally {
          saving.current = false;
        }
      }}
      {...opts}
    >
      {display}
    </InlineEdit>
  );

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
    <button
      type="button"
      title={panel ? "タイトルと本文を編集" : undefined}
      onClick={() => setDraft(draftOf(ticket, fields))}
    >
      編集
    </button>
  );

  /** 属性の 1 行（dt と dd）。パネルで値がなく「なし」にまとめた属性は出さない */
  const row = (key: string, label: string, value: ReactNode) =>
    shown(key) ? (
      <Fragment key={key}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </Fragment>
    ) : null;
  const epicChoices: Choice[] = [
    { value: "", label: "なし" },
    ...store.epics
      .filter((e) => e.status === "open" || e.id === ticket.epic)
      .map((e) => ({ value: e.id, label: `${e.id} ${e.title}` })),
  ];
  const iterationChoices: Choice[] = [
    { value: "", label: "なし" },
    ...store.iterations
      .filter((i) => i.status !== "closed" || i.id === ticket.iteration)
      .map((i) => ({ value: i.id, label: `${i.id} ${i.name}` })),
  ];
  const none = <span className="muted">なし</span>;
  const priorityView = <PriorityBadge priority={ticket.priority} />;
  const labelsView = <Tags labels={ticket.labels} />;
  const epicView = ticket.epic ? (
    <a href={hrefOf({ page: "epics", id: ticket.epic })}>
      {ticket.epic} {store.epics.find((e) => e.id === ticket.epic)?.title ?? ""}
    </a>
  ) : (
    none
  );
  const iterationView = ticket.iteration ? (
    <a href={hrefOf({ page: "iterations", id: ticket.iteration })}>{ticket.iteration}</a>
  ) : (
    none
  );
  const assigneeView = ticket.assignee ?? none;
  const rows = {
    status: row(
      "status",
      "Status",
      <select
        value={ticket.status}
        onChange={(e) => void move(e.target.value as Status)}
        aria-label="Status"
      >
        {(panel
          ? workflow
            ? movableStatuses(ticket.status, workflow.transitions, store.me?.kind)
            : [ticket.status]
          : STATUSES
        ).map((s) => (
          <option key={s} value={s}>
            {labelOf(s)}
          </option>
        ))}
      </select>,
    ),
    priority: row(
      "priority",
      "優先度",
      panel ? (
        inline("priority", "優先度", ticket.priority, (raw) => ({ priority: raw }), priorityView, {
          choices: PRIORITY_CHOICES,
        })
      ) : draft ? (
        <select
          value={draft.priority}
          onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}
          aria-label="優先度"
        >
          {optionsOf(PRIORITY_CHOICES)}
        </select>
      ) : (
        priorityView
      ),
    ),
    labels: row(
      "labels",
      "ラベル",
      panel ? (
        inline(
          "labels",
          "ラベル",
          ticket.labels.join(", "),
          (raw) => ({ labels: parseLabels(raw) }),
          ticket.labels.length ? labelsView : none,
          { placeholder: "カンマ区切り", normalize: (raw) => parseLabels(raw).join(", ") },
        )
      ) : draft ? (
        <input
          value={draft.labels}
          onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
          placeholder="カンマ区切り"
          aria-label="ラベル"
        />
      ) : (
        labelsView
      ),
    ),
    epic: row(
      "epic",
      "Epic",
      panel ? (
        inline("epic", "Epic", ticket.epic ?? "", (raw) => ({ epic: raw || null }), epicView, {
          choices: epicChoices,
        })
      ) : draft ? (
        <select
          value={draft.epic}
          onChange={(e) => setDraft({ ...draft, epic: e.target.value })}
          aria-label="Epic"
        >
          {optionsOf(epicChoices)}
        </select>
      ) : (
        epicView
      ),
    ),
    iteration: row(
      "iteration",
      "Iteration",
      panel ? (
        inline(
          "iteration",
          "Iteration",
          ticket.iteration ?? "",
          (raw) => ({ iteration: raw || null }),
          iterationView,
          { choices: iterationChoices },
        )
      ) : draft ? (
        <select
          value={draft.iteration}
          onChange={(e) => setDraft({ ...draft, iteration: e.target.value })}
          aria-label="Iteration"
        >
          {optionsOf(iterationChoices)}
        </select>
      ) : (
        iterationView
      ),
    ),
    fields: fields.map((f) => {
      const label = f.label ?? f.id;
      const value = ticket[f.id];
      const choices = fieldChoices(f);
      return row(
        `field:${f.id}`,
        label,
        panel ? (
          inline(
            `field:${f.id}`,
            label,
            fieldText(value),
            // 空にすると null を渡して外す
            (raw) => ({ fields: { [f.id]: parseFieldValue(f, raw) ?? null } }),
            <FieldView value={value} />,
            choices ? { choices } : { inputType: fieldInputType(f) },
          )
        ) : draft ? (
          <FieldInput def={f} draft={draft} setDraft={setDraft} />
        ) : (
          <FieldView value={value} />
        ),
      );
    }),
    dependsOn: row(
      "dependsOn",
      "依存先",
      <>
        {dependsOn.length ? dependsOn.map((d) => relation(d, true)) : none}
        {!ticket.deps_done && !panel && <div className="muted">依存先が終わっていない</div>}
      </>,
    ),
    dependents: row(
      "dependents",
      "依存元",
      dependents.length ? dependents.map((d) => relation(d, false)) : none,
    ),
    assignee: row(
      "assignee",
      "担当",
      panel ? (
        inline(
          "assignee",
          "担当",
          ticket.assignee ?? "",
          (raw) => ({ assignee: raw.trim() || null }),
          assigneeView,
          { placeholder: "eiki か eiki/agent" },
        )
      ) : draft ? (
        <input
          value={draft.assignee}
          onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
          placeholder="eiki か eiki/agent"
          aria-label="担当"
        />
      ) : (
        assigneeView
      ),
    ),
    branch: row(
      "branch",
      "ブランチ",
      ticket.branch ? <CopyableCode text={ticket.branch} label="ブランチ名をコピー" /> : none,
    ),
    pr: row(
      "pr",
      "PR",
      ticket.pr ? <PrLink pr={ticket.pr} webUrl={store.status?.web_url} /> : none,
    ),
    createdBy: row("createdBy", "起票者", ticket.created_by ?? <span className="muted">不明</span>),
    created: row("created", "作成", <DateTime iso={ticket.created_at} local={panel} />),
    updated: row("updated", "更新", <DateTime iso={ticket.updated_at} local={panel} />),
    empty: emptyAttrs.length ? (
      <>
        <dt>なし</dt>
        <dd className="muted props-empty">
          <span>{emptyAttrs.map((a) => a.label).join("・")}</span>
          <AddAttr
            attrs={emptyAttrs.filter((a) => a.addable)}
            open={adding}
            onOpen={() => setAdding(true)}
            onClose={() => setAdding(false)}
            onPick={(key) => {
              setAdding(false);
              setEditing(key);
            }}
          />
        </dd>
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
                {labelOf(ticket.status)}
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
        {panel && ticket.pending_deps.length > 0 ? (
          <p className="notice info deps-band" role="status">
            <span>
              依存先が終わっていない：
              {ticket.pending_deps.map((d) => (
                <span key={d.id} className="deps-band-item">
                  {d.status ? <StatusDot status={d.status} /> : null}
                  <TicketLink id={d.id}>
                    <code>{d.id}</code>
                  </TicketLink>
                  {d.status ? store.labelOf(d.status) : null}
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

/** 「なし」の行の「＋足す」。押すと値のない属性の選択になり、選んだ属性をその場で直す欄にする。Esc か外れたら閉じる */
function AddAttr({
  attrs,
  open,
  onOpen,
  onClose,
  onPick,
}: {
  attrs: readonly OptionalAttr[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (key: string) => void;
}) {
  if (attrs.length === 0) return null;
  if (!open)
    return (
      <button type="button" className="link props-add" onClick={onOpen}>
        ＋足す
      </button>
    );
  // ↑↓ では選ばず、Enter かマウスで選んだときだけその属性の欄を開く
  return (
    <ConfirmSelect
      className="props-add"
      label="値を入れる属性"
      value=""
      choices={[
        { value: "", label: "属性を選ぶ", disabled: true },
        ...attrs.map((a) => ({ value: a.key, label: a.label })),
      ]}
      onConfirm={(key) => (key ? onPick(key) : onClose())}
      onCancel={onClose}
      onBlur={onClose}
    />
  );
}

/** 任意フィールドの値。未設定は「未設定」 */
function FieldView({ value }: { value: unknown }) {
  return value === undefined ? <span className="muted">未設定</span> : <>{String(value)}</>;
}

/** ブラウザの編集中の任意フィールドの入力 */
function FieldInput({
  def,
  draft,
  setDraft,
}: {
  def: FieldDefinition;
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const label = def.label ?? def.id;
  const set = (v: string) => setDraft({ ...draft, fields: { ...draft.fields, [def.id]: v } });
  const choices = fieldChoices(def);
  return choices ? (
    <select
      value={draft.fields[def.id] ?? ""}
      onChange={(e) => set(e.target.value)}
      aria-label={label}
    >
      {optionsOf(choices)}
    </select>
  ) : (
    <input
      type={fieldInputType(def)}
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
