// 小さな表示部品：チケットへのリンク、優先度・Status の印、ラベル、進捗

import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import type { EpicProgress, Priority, Status, Ticket } from "../types.js";

export function TicketLink({ id, title }: { id: string; title?: string | undefined }) {
  return (
    <a href={hrefOf({ page: "ticket", id })}>
      <code>{id}</code>
      {title ? ` ${title}` : ""}
    </a>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge priority-${priority}`}>{priority}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  const store = useStore();
  return <span className={`badge status-${status}`}>{store.labelOf(status)}</span>;
}

export function Tags({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="tags">
      {labels.map((l) => (
        <span key={l} className="badge">
          {l}
        </span>
      ))}
    </span>
  );
}

/** Epic の進捗（done の件数 / abandoned を除く件数。EP-3） */
export function ProgressBar({ progress }: { progress: EpicProgress }) {
  const ratio = progress.total === 0 ? 0 : progress.done / progress.total;
  return (
    <span className="progress" title={`done ${progress.done} / ${progress.total}`}>
      <span className="bar">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
      <span className="muted">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

/** チケットの一覧の表。列は固定で、行の先頭のリンクで詳細へ */
export function TicketTable({
  tickets,
  extra,
}: {
  tickets: readonly Ticket[];
  extra?: ((t: Ticket) => React.ReactNode) | undefined;
}) {
  const store = useStore();
  if (tickets.length === 0) return <p className="muted">該当するチケットはない</p>;
  return (
    <table className="list">
      <thead>
        <tr>
          <th>番号</th>
          <th>タイトル</th>
          <th>Status</th>
          <th>優先度</th>
          <th>Iteration</th>
          <th>Epic</th>
          <th>ラベル</th>
          {extra ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => (
          <tr key={t.id}>
            <td>
              <TicketLink id={t.id} />
            </td>
            <td>
              <a href={hrefOf({ page: "ticket", id: t.id })}>{t.title}</a>
            </td>
            <td>{store.labelOf(t.status)}</td>
            <td>
              <PriorityBadge priority={t.priority} />
            </td>
            <td>{t.iteration ?? ""}</td>
            <td>{t.epic ? <a href={hrefOf({ page: "epics", id: t.epic })}>{t.epic}</a> : ""}</td>
            <td>
              <Tags labels={t.labels} />
            </td>
            {extra ? <td>{extra(t)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
