// VS Code のパネルのチケット詳細の右の列（属性）。Status の選択を先頭に、属性を「計画・つながり・作業・記録」の見出しで分け、
// 値のない属性は最後の「なし」の 1 行にまとめる。Status の選択には Workflow で今から移れる Status だけを並べる。
// 属性は値を押してその場で直し、確定で ticket.update に 1 属性だけ渡す。値のない属性は「なし」の行の「＋足す」から選んで値を入れる

import { useRef, useState, type ReactNode } from "react";
import type { Store } from "../store.js";
import {
  movableStatuses,
  type FieldDefinition,
  type Status,
  type Ticket,
  type TicketDetail,
  type WorkflowView,
} from "../types.js";
import { ConfirmSelect, InlineEdit, type Choice } from "./inline-edit.js";
import {
  fieldChoices,
  fieldInputType,
  fieldText,
  FieldView,
  parseFieldValue,
} from "./ticket-fields.js";
import {
  none,
  parseLabels,
  PRIORITY_CHOICES,
  propRow,
  StatusSelect,
  ticketAttrs,
} from "./ticket-props.js";

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
 * ticket.update の結果（チケットの属性と本文）に、ticket.show だけが出す値（受け入れ条件・依存元・依存先の状態・Plan）を前の詳細から足す。
 * 外した属性（epic など）は結果にないので、前の詳細に重ねず結果を土台にする
 */
function withDerived(updated: Ticket & { body: string }, prev: TicketDetail): TicketDetail {
  return {
    ...updated,
    acceptance: prev.acceptance,
    dependents: prev.dependents,
    deps_done: prev.deps_done,
    pending_deps: prev.pending_deps,
    plan: prev.plan,
  };
}

/**
 * パネルの右の列。workflow が読めていなければ Status の選択は今の Status だけ。
 * その場で直して保存できたら、ticket.update の結果を setTicket で詳細に入れる
 */
export function PanelProps({
  store,
  ticket,
  fields,
  workflow,
  labelOf,
  setTicket,
}: {
  store: Store;
  ticket: TicketDetail;
  fields: readonly FieldDefinition[];
  workflow: WorkflowView | null;
  labelOf: (s: Status) => string;
  setTicket: (update: (prev: TicketDetail | null) => TicketDetail | null) => void;
}) {
  // その場で直している属性の key（OptionalAttr の key か "priority"）と、「＋足す」の選択を開いているか
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // その場で直した属性を保存している間は、次の確定を受けない（Enter を素早く 2 回押しても 1 回だけ渡す）
  const saving = useRef(false);
  const a = ticketAttrs(store, ticket, true);

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
    { key: "dependsOn", label: "依存先", empty: ticket.depends_on.length === 0, addable: false },
    { key: "dependents", label: "依存元", empty: ticket.dependents.length === 0, addable: false },
    { key: "assignee", label: "担当", empty: !ticket.assignee, addable: true },
    { key: "branch", label: "ブランチ", empty: !ticket.branch, addable: false },
    { key: "pr", label: "PR", empty: !ticket.pr, addable: false },
  ];
  // 値のない属性は行にせず最後の「なし」の 1 行にまとめる（「＋足す」で選んで直している属性は行に出す）
  const emptyAttrs = optional.filter((o) => o.empty && o.key !== editing);
  /** 属性の 1 行。値がなく「なし」にまとめた属性は出さない */
  const row = (key: string, label: string, value: ReactNode) =>
    emptyAttrs.some((o) => o.key === key) ? null : propRow(key, label, value);

  /**
   * 属性 1 つをその場で直す部品。確定した値を toPatch で ticket.update の入力にし、その属性だけを渡す。
   * 失敗なら欄を開いたままにする。成功なら ticket.update の結果を詳細に入れてから閉じる（「＋足す」で入れた属性が一瞬「なし」に戻らないよう）
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
      link?: ReactNode;
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
          const r = await store.run<Ticket & { body: string }>("ticket.update", {
            ticket: ticket.id,
            ...toPatch(raw),
          });
          if (!r.ok) return false;
          // 直した属性は ticket.update の結果（チケットの属性と本文）で先に入れる。依存や受け入れ条件などは
          // 一覧の読み直しで走る ticket.show（チケット詳細の effect）が入れ直すので、ここでは ticket.show を呼ばない
          setTicket((prev) => (prev ? withDerived(r.data, prev) : prev));
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

  const statuses = workflow
    ? movableStatuses(ticket.status, workflow.transitions, store.me?.kind)
    : [ticket.status];
  const groups = [
    {
      title: "計画",
      items: [
        row(
          "iteration",
          "Iteration",
          inline(
            "iteration",
            "Iteration",
            ticket.iteration ?? "",
            (raw) => ({ iteration: raw || null }),
            a.iterationView,
            { choices: a.iterationChoices, link: ticket.iteration && a.iterationView },
          ),
        ),
        row(
          "epic",
          "Epic",
          inline("epic", "Epic", ticket.epic ?? "", (raw) => ({ epic: raw || null }), a.epicView, {
            choices: a.epicChoices,
            link: ticket.epic && a.epicView,
          }),
        ),
        row(
          "assignee",
          "担当",
          inline(
            "assignee",
            "担当",
            ticket.assignee ?? "",
            (raw) => ({ assignee: raw.trim() || null }),
            a.assigneeView,
            { placeholder: "eiki か eiki/agent" },
          ),
        ),
        row(
          "priority",
          "優先度",
          inline(
            "priority",
            "優先度",
            ticket.priority,
            (raw) => ({ priority: raw }),
            a.priorityView,
            { choices: PRIORITY_CHOICES },
          ),
        ),
        row(
          "labels",
          "ラベル",
          inline(
            "labels",
            "ラベル",
            ticket.labels.join(", "),
            (raw) => ({ labels: parseLabels(raw) }),
            ticket.labels.length ? a.labelsView : none,
            { placeholder: "カンマ区切り", normalize: (raw) => parseLabels(raw).join(", ") },
          ),
        ),
        ...fields.map((f) => {
          const label = f.label ?? f.id;
          const value = ticket[f.id];
          const choices = fieldChoices(f);
          return row(
            `field:${f.id}`,
            label,
            inline(
              `field:${f.id}`,
              label,
              fieldText(value),
              // 空にすると null を渡して外す
              (raw) => ({ fields: { [f.id]: parseFieldValue(f, raw) ?? null } }),
              <FieldView value={value} />,
              choices ? { choices } : { inputType: fieldInputType(f) },
            ),
          );
        }),
      ],
    },
    {
      title: "つながり",
      items: [
        row("dependsOn", "依存先", a.dependsOnView),
        row("dependents", "依存元", a.dependentsView),
      ],
    },
    {
      title: "作業",
      items: [row("branch", "ブランチ", a.branchView), row("pr", "PR", a.prView)],
    },
    {
      title: "記録",
      items: [
        row("createdBy", "起票者", a.createdByView),
        row("created", "作成", a.createdView),
        row("updated", "更新", a.updatedView),
      ],
    },
  ];

  return (
    <div className="props props-groups">
      <dl>
        {propRow(
          "status",
          "Status",
          <StatusSelect store={store} ticket={ticket} statuses={statuses} labelOf={labelOf} />,
        )}
      </dl>
      {/* 値のある行が 1 つもない見出しは出さない */}
      {groups
        .filter(({ items }) => items.some(Boolean))
        .map(({ title, items }) => (
          <section key={title} aria-label={title}>
            <h2 className="props-group-title">{title}</h2>
            <dl>{items}</dl>
          </section>
        ))}
      <dl>
        {emptyAttrs.length ? (
          <>
            <dt>なし</dt>
            <dd className="muted props-empty">
              <span>{emptyAttrs.map((o) => o.label).join("・")}</span>
              <AddAttr
                attrs={emptyAttrs.filter((o) => o.addable)}
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
        ) : null}
      </dl>
    </div>
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
        ...attrs.map((o) => ({ value: o.key, label: o.label })),
      ]}
      onConfirm={(key) => (key ? onPick(key) : onClose())}
      onCancel={onClose}
      onBlur={onClose}
    />
  );
}
