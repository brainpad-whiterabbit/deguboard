// ブラウザのチケット詳細の右の列（属性）。Status は Workflow によらずすべてを並べ、属性を 1 つの一覧に出す。
// 編集のボタンを押している間（draft があるとき）は、優先度・ラベル・Epic・Iteration・任意フィールド・担当を入力欄にし、保存でまとめて ticket.update に渡す

import type { Store } from "../store.js";
import {
  STATUSES,
  type FieldDefinition,
  type Priority,
  type Status,
  type TicketDetail,
} from "../types.js";
import { optionsOf } from "./inline-edit.js";
import { FieldInput, FieldView, parseFieldValue } from "./ticket-fields.js";
import {
  type Draft,
  parseLabels,
  PRIORITY_CHOICES,
  propRow,
  StatusSelect,
  ticketAttrs,
} from "./ticket-props.js";
import { tr } from "../l10n.js";

/** ブラウザの保存で、タイトルと本文に足して ticket.update に渡す属性。任意フィールドは値のあるものだけ */
export function attrPatchOf(
  draft: Draft,
  fields: readonly FieldDefinition[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    priority: draft.priority,
    labels: parseLabels(draft.labels),
    epic: draft.epic || null,
    iteration: draft.iteration || null,
    assignee: draft.assignee.trim() || null,
  };
  const values = Object.fromEntries(
    fields
      .map((f) => [f.id, parseFieldValue(f, draft.fields[f.id] ?? "")])
      .filter(([, v]) => v !== undefined),
  );
  if (Object.keys(values).length) patch["fields"] = values;
  return patch;
}

export function BrowserProps({
  store,
  ticket,
  fields,
  labelOf,
  draft,
  setDraft,
}: {
  store: Store;
  ticket: TicketDetail;
  fields: readonly FieldDefinition[];
  labelOf: (s: Status) => string;
  draft: Draft | null;
  setDraft: (d: Draft) => void;
}) {
  const a = ticketAttrs(store, ticket, false);
  return (
    <dl className="props">
      {propRow(
        "status",
        "Status",
        <StatusSelect store={store} ticket={ticket} statuses={STATUSES} labelOf={labelOf} />,
      )}
      {propRow(
        "priority",
        tr("優先度"),
        draft ? (
          <>
            <select
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}
              aria-label={tr("優先度")}
            >
              {optionsOf(PRIORITY_CHOICES)}
            </select>
            <div className="inline-hint muted">{store.priorityCriteria[draft.priority]}</div>
          </>
        ) : (
          a.priorityView
        ),
      )}
      {propRow(
        "labels",
        tr("ラベル"),
        draft ? (
          <input
            value={draft.labels}
            onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
            placeholder={tr("カンマ区切り")}
            aria-label={tr("ラベル")}
          />
        ) : (
          a.labelsView
        ),
      )}
      {propRow(
        "epic",
        "Epic",
        draft ? (
          <select
            value={draft.epic}
            onChange={(e) => setDraft({ ...draft, epic: e.target.value })}
            aria-label="Epic"
          >
            {optionsOf(a.epicChoices)}
          </select>
        ) : (
          a.epicView
        ),
      )}
      {propRow(
        "iteration",
        "Iteration",
        draft ? (
          <select
            value={draft.iteration}
            onChange={(e) => setDraft({ ...draft, iteration: e.target.value })}
            aria-label="Iteration"
          >
            {optionsOf(a.iterationChoices)}
          </select>
        ) : (
          a.iterationView
        ),
      )}
      {fields.map((f) =>
        propRow(
          `field:${f.id}`,
          f.label ?? f.id,
          draft ? (
            <FieldInput
              def={f}
              value={draft.fields[f.id] ?? ""}
              onChange={(v) => setDraft({ ...draft, fields: { ...draft.fields, [f.id]: v } })}
            />
          ) : (
            <FieldView value={ticket[f.id]} />
          ),
        ),
      )}
      {propRow(
        "dependsOn",
        tr("依存先"),
        <>
          {a.dependsOnView}
          {!ticket.deps_done && <div className="muted">{tr("依存先が終わっていない")}</div>}
        </>,
      )}
      {propRow("dependents", tr("依存元"), a.dependentsView)}
      {propRow(
        "assignee",
        tr("担当"),
        draft ? (
          <input
            value={draft.assignee}
            onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
            placeholder={tr("eiki か eiki/agent")}
            aria-label={tr("担当")}
          />
        ) : (
          a.assigneeView
        ),
      )}
      {propRow("branch", tr("ブランチ"), a.branchView)}
      {propRow("pr", "PR", a.prView)}
      {propRow("createdBy", tr("起票者"), a.createdByView)}
      {propRow("created", tr("作成"), a.createdView)}
      {propRow("updated", tr("更新"), a.updatedView)}
    </dl>
  );
}
