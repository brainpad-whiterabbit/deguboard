// 履歴（UI-5）。終わったものを見る画面で、見方を「Iteration / Epic」で切り替える（見方はハッシュの ?view= に持つ）。検索欄は共通。
// Iteration の見方：closed の Iteration を閉じた新しい順に 2 段の行で出す（KanbanForge の History のタブと同じ形）。
// 1 段目は番号・名前と、閉じたときに記録した完了・持ち越しの件数、2 段目は期間・目標と、含む Epic ごとの件数。
// 行を開くと中の done・abandoned のチケットを出す。Run の実績（e3）が入ったら 1 段目の右に出す。
// Epic の見方：closed の Epic を閉じた新しい順に、進捗・閉じた日と、チケットが入っていた Iteration を出す。
// 番号を押すと詳細を開く（サイドバーとパネルでは拡張ホストに頼んでエディタに、ブラウザではハッシュ遷移）

import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ProgressBar, StatusDot, TicketLink } from "../components/parts.js";
import { useHost } from "../host.js";
import { hrefOf, navigate, type HistoryView, type Route } from "../router.js";
import { useStore } from "../store.js";
import { byNumber, type EpicRow, type Iteration, type Ticket } from "../types.js";

/** 閉じた新しい順。closed_at がなければ番号の新しい順 */
export function byClosedDesc<T extends { id: string; closed_at?: string | undefined }>(
  a: T,
  b: T,
): number {
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

/** 検索：チケットの番号かタイトルに当たるチケットを含むものだけ残す。key はチケットの iteration か epic */
export function filterHistory<T extends { id: string }>(
  rows: readonly T[],
  tickets: readonly Ticket[],
  query: string,
  key: "iteration" | "epic" = "iteration",
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const hit = new Set<string>(
    tickets
      .filter((t) => t[key] && (t.id.toLowerCase() === q || t.title.toLowerCase().includes(q)))
      .map((t) => t[key]!),
  );
  return rows.filter((r) => hit.has(r.id));
}

/** Iteration に入っている Epic ごとの件数（多い順、同じなら番号の順）。Epic なしは数えない */
export function epicCountsOf(
  iteration: string,
  tickets: readonly Ticket[],
): { epic: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tickets)
    if (t.iteration === iteration && t.epic) counts.set(t.epic, (counts.get(t.epic) ?? 0) + 1);
  return [...counts]
    .map(([epic, count]) => ({ epic, count }))
    .sort((a, b) => b.count - a.count || byNumber({ id: a.epic }, { id: b.epic }));
}

/** Epic のチケットが入っている Iteration（番号の順）。持ち越しで外されたものは今のファイルからは分からない */
export function iterationsOfEpic(epic: string, tickets: readonly Ticket[]): string[] {
  const ids = new Set(
    tickets.filter((t) => t.epic === epic && t.iteration).map((t) => t.iteration!),
  );
  return [...ids].sort((a, b) => byNumber({ id: a }, { id: b }));
}

const VIEWS: { view: HistoryView; label: string }[] = [
  { view: "iteration", label: "Iteration" },
  { view: "epic", label: "Epic" },
];

export function HistoryPage({ view }: { view: HistoryView }) {
  const store = useStore();
  const [query, setQuery] = useState("");
  const iterations = useMemo(
    () => store.iterations.filter((i) => i.status === "closed").sort(byClosedDesc),
    [store.iterations],
  );
  const epics = useMemo(
    () => store.epics.filter((e) => e.status === "closed").sort(byClosedDesc),
    [store.epics],
  );
  const all: { id: string }[] = view === "epic" ? epics : iterations;
  const rows = useMemo(
    () => filterHistory(all, store.tickets, query, view),
    [all, store.tickets, query, view],
  );
  return (
    <section>
      <div className="toolbar">
        <h1>履歴</h1>
        <span className="segmented" role="group" aria-label="見方">
          {VIEWS.map((v) => (
            <button
              key={v.view}
              type="button"
              aria-pressed={view === v.view}
              onClick={() => navigate({ page: "history", view: v.view })}
            >
              {v.label}
            </button>
          ))}
        </span>
        <input
          type="search"
          placeholder="チケットの番号・タイトルで探す"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="チケットを探す"
        />
        <span className="muted">
          {query.trim() ? `${rows.length} / ${all.length} 件` : `${all.length} 件`}
        </span>
      </div>
      {all.length === 0 ? (
        <p className="empty">
          {view === "epic" ? "閉じた Epic はない" : "閉じた Iteration はない"}
        </p>
      ) : rows.length === 0 ? (
        <p className="empty">
          {view === "epic" ? "当たる Epic はない" : "当たる Iteration はない"}
        </p>
      ) : (
        <ul className="history">
          {view === "epic"
            ? (rows as EpicRow[]).map((e) => <EpicItem key={e.id} epic={e} />)
            : (rows as Iteration[]).map((i) => <IterationItem key={i.id} iteration={i} />)}
        </ul>
      )}
    </section>
  );
}

/** 詳細へのリンク。Webview では拡張ホストに頼んでエディタ領域に開く */
function DetailLink({ route, children }: { route: Route; children: ReactNode }) {
  const host = useHost();
  return (
    <a
      href={hrefOf(route)}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        host.open(route);
      }}
    >
      {children}
    </a>
  );
}

/** Iteration の行。開くと中の done・abandoned のチケットを出す */
function IterationItem({ iteration: i }: { iteration: Iteration }) {
  const store = useStore();
  const c = countsOf(i, store.tickets);
  const epics = epicCountsOf(i.id, store.tickets);
  const finished = store.tickets
    .filter((t) => t.iteration === i.id && (t.status === "done" || t.status === "abandoned"))
    .sort(byNumber);
  const period = i.start || i.end ? `${i.start ?? "?"} 〜 ${i.end ?? "?"}` : "";
  const meta = [period, i.goal].filter(Boolean).join(" ・ ");
  return (
    <li>
      <details className="history-item">
        <summary className="history-row">
          <DetailLink route={{ page: "iterations", id: i.id }}>
            <code>{i.id}</code>
          </DetailLink>
          <span className="name" title={i.name}>
            {i.name}
          </span>
          <span className="counts" title="閉じたときの完了と持ち越しの件数">
            完了 {c.done} ・ 持ち越し {c.carried}
          </span>
          {meta || epics.length > 0 ? (
            <small>
              {meta}
              {epics.length > 0 ? (
                <span className="epics">
                  {meta ? " ・ " : ""}Epic:{" "}
                  {epics.map((e, n) => (
                    <span key={e.epic}>
                      {n > 0 ? ", " : ""}
                      <DetailLink route={{ page: "epics", id: e.epic }}>{e.epic}</DetailLink>{" "}
                      {e.count}
                    </span>
                  ))}
                </span>
              ) : null}
            </small>
          ) : null}
        </summary>
        {finished.length === 0 ? (
          <p className="empty">終わったチケットはない</p>
        ) : (
          <ul className="rows history-tickets">
            {finished.map((t) => (
              <li key={t.id}>
                <StatusDot status={t.status} />
                <TicketLink id={t.id} />
                <span className="row-title" title={t.title}>
                  {t.title}
                </span>
                {t.epic ? (
                  <DetailLink route={{ page: "epics", id: t.epic }}>{t.epic}</DetailLink>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

/** 閉じた Epic の行：番号・タイトル・進捗、2 段目に閉じた日とチケットが入っていた Iteration */
function EpicItem({ epic: e }: { epic: EpicRow }) {
  const store = useStore();
  const iterations = iterationsOfEpic(e.id, store.tickets);
  return (
    <li className="history-row">
      <DetailLink route={{ page: "epics", id: e.id }}>
        <code>{e.id}</code>
      </DetailLink>
      <span className="name" title={e.title}>
        {e.title}
      </span>
      <ProgressBar progress={e.progress} />
      <small>
        {e.closed_at ? `${e.closed_at.slice(0, 10)} に閉じた` : "閉じた日は不明"}
        {iterations.map((id) => (
          <span key={id}>
            {" ・ "}
            <DetailLink route={{ page: "iterations", id }}>{id}</DetailLink>
          </span>
        ))}
      </small>
    </li>
  );
}
