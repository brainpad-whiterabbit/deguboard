// チケット詳細（pages/ticket.tsx）と右の列（属性。ticket-props-panel.tsx）が使う部品。
// 編集のボタンで直している間の値（Draft）、属性の 1 行、Status の選択、依存先・依存元の行、Epic・Iteration の選択の項目、読むだけの属性の値と、PR のリンク。
// 依存先が終わったかは ticket.show の pending_deps で決める（別の Project の依存先も見る。パネルの帯と同じ判定）

import { Fragment, type ReactNode } from "react";
import type { Store } from "../store.js";
import { PRIORITIES, type Priority, type Status, type TicketDetail } from "../types.js";
import { hrefOf } from "../router.js";
import { CopyableCode } from "./copyable-code.js";
import { DateTime } from "./date-time.js";
import type { Choice } from "./inline-edit.js";
import { PriorityMark, StatusDot, Tags, TicketLink } from "./parts.js";
import { WorktreeRow } from "./worktree-row.js";
import { tr } from "../l10n.js";

/** 編集のボタンで直している間の値（タイトルと本文。属性は右の列でその場で直す） */
export interface Draft {
  title: string;
  body: string;
}

export function draftOf(t: TicketDetail): Draft {
  return { title: t.title, body: t.body };
}

/** 詳細の優先度の選択の記号（option には SVG を置けないので文字で添える。印の矢印・= に合わせる） */
const PRIORITY_SYMBOL: Record<Priority, string> = { high: "↑", medium: "=", low: "↓" };

export const PRIORITY_CHOICES: Choice[] = PRIORITIES.map((p) => ({
  value: p,
  label: `${PRIORITY_SYMBOL[p]} ${p}`,
}));

/** カンマ区切りのラベルを一覧にする */
export function parseLabels(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 属性の 1 行（dt と dd） */
export function propRow(key: string, label: string, value: ReactNode) {
  return (
    <Fragment key={key}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </Fragment>
  );
}

/** 値のない属性の「なし」。描くときに訳す（表示言語は起動のときに決まるので、読み込んだときに訳さない） */
function NoneText() {
  return <>{tr("なし")}</>;
}

export const none = (
  <span className="muted">
    <NoneText />
  </span>
);

/** Status の選択。選ぶと ticket.move（Workflow の検査を通る）。statuses は並べる Status */
export function StatusSelect({
  store,
  ticket,
  statuses,
  labelOf,
}: {
  store: Store;
  ticket: TicketDetail;
  statuses: readonly Status[];
  labelOf: (s: Status) => string;
}) {
  const move = async (status: Status) => {
    if (status !== ticket.status) await store.run("ticket.move", { ticket: ticket.id, status });
  };
  return (
    <select
      value={ticket.status}
      onChange={(e) => void move(e.target.value as Status)}
      aria-label="Status"
    >
      {statuses.map((s) => (
        <option key={s} value={s}>
          {labelOf(s)}
        </option>
      ))}
    </select>
  );
}

/** 依存先・依存元の 1 行に出すもの。status は分からなければ null、finished は終わった依存先か */
interface Relation {
  id: string;
  title: string;
  status: Status | null;
  finished: boolean;
}

/** 依存先・依存元の 1 行。頭に Status の丸印を付け、終わった（done・abandoned）依存先は薄くする */
function RelationRow({ d, dimDone }: { d: Relation; dimDone: boolean }) {
  return (
    <div className={dimDone && d.finished ? "dep-finished" : undefined}>
      {d.status ? <StatusDot status={d.status} /> : null}
      <TicketLink id={d.id} title={d.title} />
    </div>
  );
}

/**
 * 属性の値の表示と、Epic・Iteration の選択の項目。
 * 依存先の丸印の Status は、終わっていない依存先は pending_deps のものを使い、一覧にない終わった依存先には丸印を付けない
 */
export function ticketAttrs(store: Store, ticket: TicketDetail) {
  const rowOf = (id: string) => store.tickets.find((t) => t.id === id);
  const dependsOn: Relation[] = ticket.depends_on.map((id) => {
    const pending = ticket.pending_deps.find((p) => p.id === id);
    const row = rowOf(id);
    return {
      id,
      title: row?.title ?? "",
      status: pending ? pending.status : (row?.status ?? null),
      finished: !pending,
    };
  });
  const dependents: Relation[] = ticket.dependents.map((id) => {
    const row = rowOf(id);
    return { id, title: row?.title ?? "", status: row?.status ?? null, finished: false };
  });
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
  return {
    epicChoices: [
      { value: "", label: tr("なし") },
      ...store.epics
        .filter((e) => e.status === "open" || e.id === ticket.epic)
        .map((e) => ({ value: e.id, label: `${e.id} ${e.title}` })),
    ] satisfies Choice[],
    iterationChoices: [
      { value: "", label: tr("なし") },
      ...store.iterations
        .filter((i) => i.status !== "closed" || i.id === ticket.iteration)
        .map((i) => ({ value: i.id, label: `${i.id} ${i.name}` })),
    ] satisfies Choice[],
    priorityView: <PriorityMark priority={ticket.priority} />,
    labelsView: <Tags labels={ticket.labels} />,
    epicView,
    iterationView,
    assigneeView: ticket.assignee ?? none,
    // ここから下は読むだけの属性（その場で直さない）
    dependsOnView: dependsOn.length
      ? dependsOn.map((d) => <RelationRow key={d.id} d={d} dimDone />)
      : none,
    dependentsView: dependents.length
      ? dependents.map((d) => <RelationRow key={d.id} d={d} dimDone={false} />)
      : none,
    branchView: ticket.branch ? (
      <>
        <CopyableCode text={ticket.branch} label={tr("ブランチ名をコピー")} />
        {ticket.worktree ? <WorktreeRow path={ticket.worktree} /> : null}
      </>
    ) : (
      none
    ),
    prView: ticket.pr ? <PrLink pr={ticket.pr} webUrl={store.status?.web_url} /> : none,
    createdByView: ticket.created_by ?? <span className="muted">{tr("不明")}</span>,
    createdView: <DateTime iso={ticket.created_at} />,
    updatedView: <DateTime iso={ticket.updated_at} />,
  };
}

/** PR の番号。リモートの Web の URL が分かればそのページへのリンクにする */
export function PrLink({ pr, webUrl }: { pr: number; webUrl?: string | null | undefined }) {
  if (!webUrl) return <>#{pr}</>;
  return (
    <a href={`${webUrl}/pull/${pr}`} target="_blank" rel="noreferrer">
      #{pr}
    </a>
  );
}
