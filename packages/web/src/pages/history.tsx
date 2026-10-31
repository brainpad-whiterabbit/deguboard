// 履歴（UI-5）。closed の Iteration を閉じた新しい順に 2 段の行で出す（KanbanForge の History のタブと同じ形）。
// 1 段目は番号・名前と、閉じたときに記録した完了・持ち越しの件数、2 段目は期間と目標。
// チケットの番号かタイトルで探すと、そのチケットが入っている Iteration の行だけになる。行を押すと詳細を開く
// （サイドバーとパネルでは拡張ホストに頼んでエディタに、ブラウザではハッシュ遷移）。Run の実績（e3）が入ったら 1 段目の右に出す

import { useMemo, useState } from "react";
import { useHost } from "../host.js";
import { useStore } from "../store.js";
import { byNumber, type Iteration, type Ticket } from "../types.js";

/** 閉じた新しい順。closed_at がなければ番号の新しい順 */
export function byClosedDesc(a: Iteration, b: Iteration): number {
  if (a.closed_at && b.closed_at) return b.closed_at.localeCompare(a.closed_at);
  if (a.closed_at || b.closed_at) return a.closed_at ? -1 : 1;
  return byNumber(b, a);
}

/** 完了と持ち越しの件数。閉じたときの記録がなければ今のチケットから求める */
export function countsOf(
  iteration: Iteration,
  tickets: readonly Ticket[],
): { done: number; carried: number } {
  if (iteration.completed !== undefined || iteration.carried_over !== undefined) {
    return { done: iteration.completed ?? 0, carried: iteration.carried_over ?? 0 };
  }
  const members = tickets.filter((t) => t.iteration === iteration.id && t.status !== "abandoned");
  const done = members.filter((t) => t.status === "done").length;
  return { done, carried: members.length - done };
}

/** 検索：チケットの番号かタイトルに当たるチケットを含む Iteration だけ残す */
export function filterHistory(
  iterations: readonly Iteration[],
  tickets: readonly Ticket[],
  query: string,
): Iteration[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...iterations];
  const hit = new Set(
    tickets
      .filter((t) => t.iteration && (t.id.toLowerCase() === q || t.title.toLowerCase().includes(q)))
      .map((t) => t.iteration!),
  );
  return iterations.filter((i) => hit.has(i.id));
}

export function HistoryPage() {
  const store = useStore();
  const host = useHost();
  const [query, setQuery] = useState("");
  const closed = useMemo(
    () => store.iterations.filter((i) => i.status === "closed").sort(byClosedDesc),
    [store.iterations],
  );
  const rows = useMemo(
    () => filterHistory(closed, store.tickets, query),
    [closed, store.tickets, query],
  );
  return (
    <section>
      <div className="toolbar">
        <h1>履歴</h1>
        <input
          type="search"
          placeholder="チケットの番号・タイトルで探す"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="チケットを探す"
        />
        <span className="muted">
          {query.trim() ? `${rows.length} / ${closed.length} 件` : `${closed.length} 件`}
        </span>
      </div>
      {closed.length === 0 ? (
        <p className="empty">閉じた Iteration はない</p>
      ) : rows.length === 0 ? (
        <p className="empty">当たる Iteration はない</p>
      ) : (
        <ul className="history">
          {rows.map((i) => {
            const c = countsOf(i, store.tickets);
            return (
              <li key={i.id}>
                <a
                  className="history-row"
                  href={`#/iterations/${i.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    host.open({ page: "iterations", id: i.id });
                  }}
                >
                  <code>{i.id}</code>
                  <span className="name" title={i.name}>
                    {i.name}
                  </span>
                  <span className="counts" title="閉じたときの完了と持ち越しの件数">
                    完了 {c.done} ・ 持ち越し {c.carried}
                  </span>
                  <small>
                    {i.start || i.end ? `${i.start ?? "?"} 〜 ${i.end ?? "?"}` : ""}
                    {(i.start || i.end) && i.goal ? " ・ " : ""}
                    {i.goal}
                  </small>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
