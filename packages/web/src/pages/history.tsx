// 履歴（UI-5）。終わったものを見る画面で、見方を「Iteration / Epic / チケット」で切り替える（見方はハッシュの ?view= に持つ）。検索欄は共通。
// Iteration の見方：closed の Iteration を閉じた新しい順に 2 段の行で出す（KanbanForge の History のタブと同じ形）。
// 1 段目は番号・名前と、閉じたときに記録した完了・持ち越しの件数、2 段目は期間・目標と、含む Epic ごとの件数。
// 行を開くと中の done・abandoned のチケットを出す。Run の実績はここに出さず、Run の画面（#/runs?by=iteration）で見る。
// Epic の見方：closed の Epic を閉じた新しい順に、進捗・閉じた日と、チケットが入っていた Iteration を出す。
// チケットの見方：done・abandoned のチケットを終えた新しい順に、結果・Iteration・Epic・PR・終えた日を出す。終えた時刻は
// history のコマンド（deguboard ブランチの履歴）から求め、履歴が浅くて分からないものは updated_at で代え、そう出す。
// 番号を押すと詳細を開く（サイドバーとパネルでは拡張ホストに頼んでエディタに、ブラウザではハッシュ遷移）。
// サイドバーでは狭い幅で読めるよう描き方を変える：Iteration の行は開閉の印を付け、開くと Epic ごとの小見出しでまとめ、持ち越しを分ける。
// Epic の見方は進捗バーをやめてタイトルを 2 行まで出す。チケットの見方は終えた日を小見出しにし、行には値のある Iteration・Epic・PR だけを書く

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DetailLink,
  ProgressBar,
  StatusDot,
  Tags,
  TicketLink,
  TicketRow,
} from "../components/parts.js";
import { useHost } from "../host.js";
import { NO_VALUE } from "../components/run-parts.js";
import { formatTime } from "../components/timeline.js";
import { navigate, type HistoryView } from "../router.js";
import { useStore } from "../store.js";
import {
  byNumber,
  type EpicRow,
  type HistoryEvent,
  type HistoryLog,
  type Iteration,
  type Ticket,
} from "../types.js";

/** 閉じた新しい順。closed_at がなければ番号の新しい順 */
function byClosedDesc<T extends { id: string; closed_at?: string | undefined }>(
  a: T,
  b: T,
): number {
  if (a.closed_at && b.closed_at) return b.closed_at.localeCompare(a.closed_at);
  if (a.closed_at || b.closed_at) return a.closed_at ? -1 : 1;
  return byNumber(b, a);
}

/**
 * 完了と持ち越しの件数。iteration.close が記録した値（core が数える）をそのまま出し、web では数え直さない。
 * 記録のないもの（閉じる前のデータ）は「—」
 */
function countsText(iteration: Iteration): string {
  return `完了 ${iteration.completed ?? NO_VALUE} ・ 持ち越し ${iteration.carried_over ?? NO_VALUE}`;
}

/**
 * 検索：チケットの番号かタイトル（labels なら加えてラベル）に当たるチケットを含むものだけ残す。key はチケットの iteration か epic
 */
function filterHistory<T extends { id: string }>(
  rows: readonly T[],
  tickets: readonly Ticket[],
  query: string,
  key: "iteration" | "epic" = "iteration",
  labels = false,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const hit = new Set<string>(
    tickets
      .filter(
        (t) =>
          t[key] &&
          (t.id.toLowerCase() === q ||
            t.title.toLowerCase().includes(q) ||
            (labels && t.labels.some((l) => l.toLowerCase().includes(q)))),
      )
      .map((t) => t[key]!),
  );
  return rows.filter((r) => hit.has(r.id));
}

/** Iteration に入っている Epic ごとの件数（多い順、同じなら番号の順）。Epic なしは数えない */
function epicCountsOf(
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
function iterationsOfEpic(epic: string, tickets: readonly Ticket[]): string[] {
  const ids = new Set(
    tickets.filter((t) => t.epic === epic && t.iteration).map((t) => t.iteration!),
  );
  return [...ids].sort((a, b) => byNumber({ id: a }, { id: b }));
}

/** チケットを Epic ごとにまとめる（チケットの多い順、同じなら番号の順。Epic なしは最後）。中は番号の順 */
export function groupByEpic(
  tickets: readonly Ticket[],
): { epic: string | null; tickets: Ticket[] }[] {
  const groups = new Map<string | null, Ticket[]>();
  for (const t of [...tickets].sort(byNumber)) {
    const key = t.epic ?? null;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups]
    .map(([epic, list]) => ({ epic, tickets: list }))
    .sort(
      (a, b) =>
        Number(a.epic === null) - Number(b.epic === null) ||
        b.tickets.length - a.tickets.length ||
        byNumber({ id: a.epic ?? "" }, { id: b.epic ?? "" }),
    );
}

/**
 * Iteration から持ち越したチケットの ID（番号の順）。閉じると持ち越したチケットの iteration は外れるので、今のファイルからは分からない。
 * 履歴（history のコマンド）で、その Iteration から外れる・別の Iteration に移る出来事のあったチケットを持ち越しとみなす。
 * 今もその Iteration に入っているものは除く
 */
export function carriedOverFrom(
  iteration: string,
  events: readonly HistoryEvent[],
  tickets: readonly Ticket[],
): string[] {
  const moved = new Set<string>();
  for (const e of events)
    if (
      e.kind === "ticket" &&
      e.changes.some((c) => c.field === "iteration" && c.from === iteration && c.to !== iteration)
    )
      moved.add(e.id);
  const still = new Set<string>(tickets.filter((t) => t.iteration === iteration).map((t) => t.id));
  return [...moved].filter((id) => !still.has(id)).sort((a, b) => byNumber({ id: a }, { id: b }));
}

/** 終えた日（手元の日付）ごとにまとめる。並びは rows の順のまま */
export function groupByDay(rows: readonly FinishedRow[]): { day: string; rows: FinishedRow[] }[] {
  const groups: { day: string; rows: FinishedRow[] }[] = [];
  for (const r of rows) {
    const day = `${r.approximate ? "~" : ""}${formatTime(r.at).slice(0, 10)}`;
    const last = groups.at(-1);
    if (last && last.day === day) last.rows.push(r);
    else groups.push({ day, rows: [r] });
  }
  return groups;
}

/** チケットを終えた時刻：最後に done か abandoned になった出来事の時刻 */
function finishedAtOf(events: readonly HistoryEvent[]): Map<string, string> {
  const at = new Map<string, string>();
  for (const e of events)
    if (
      e.kind === "ticket" &&
      e.changes.some((c) => c.field === "status" && (c.to === "done" || c.to === "abandoned"))
    )
      at.set(e.id, e.at);
  return at;
}

export interface FinishedRow {
  ticket: Ticket;
  /** 終えた時刻。履歴から分からなければ updated_at */
  at: string;
  /** at を updated_at で代えたか */
  approximate: boolean;
}

export interface FinishedFilter {
  query: string;
  /** done か abandoned。空ならどちらも */
  result: string;
  epic: string;
}

/** 終わったチケットを終えた新しい順に。検索は番号・タイトル・ラベル */
function finishedTickets(
  tickets: readonly Ticket[],
  finishedAt: ReadonlyMap<string, string>,
  f: FinishedFilter,
): FinishedRow[] {
  const q = f.query.trim().toLowerCase();
  return tickets
    .filter((t) => t.status === "done" || t.status === "abandoned")
    .filter((t) => !f.result || t.status === f.result)
    .filter((t) => !f.epic || t.epic === f.epic)
    .filter(
      (t) =>
        !q ||
        t.id.toLowerCase() === q ||
        t.title.toLowerCase().includes(q) ||
        t.labels.some((l) => l.toLowerCase().includes(q)),
    )
    .map((t) => {
      const at = finishedAt.get(t.id);
      return { ticket: t, at: at ?? t.updated_at, approximate: at === undefined };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || byNumber(b.ticket, a.ticket));
}

const VIEWS: { view: HistoryView; label: string }[] = [
  { view: "iteration", label: "Iteration" },
  { view: "epic", label: "Epic" },
  { view: "ticket", label: "チケット" },
];

/** サイドバーの検索欄の案内（バックログと同じ言い方） */
const SIDEBAR_SEARCH = "番号・タイトル・ラベルで検索";

export function HistoryPage({ view }: { view: HistoryView }) {
  const store = useStore();
  const sidebar = useHost().surface === "sidebar";
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
    () => (view === "ticket" ? [] : filterHistory(all, store.tickets, query, view, sidebar)),
    [all, store.tickets, query, view, sidebar],
  );
  const toggle = (
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
  );
  if (view === "ticket") return <TicketView toggle={toggle} query={query} setQuery={setQuery} />;
  return (
    <section>
      <div className="toolbar">
        <h1>履歴</h1>
        {toggle}
        <input
          type="search"
          placeholder={sidebar ? SIDEBAR_SEARCH : "チケットの番号・タイトルで探す"}
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
            ? (rows as EpicRow[]).map((e) =>
                sidebar ? (
                  <SidebarEpicItem key={e.id} epic={e} />
                ) : (
                  <EpicItem key={e.id} epic={e} />
                ),
              )
            : (rows as Iteration[]).map((i) => (
                <IterationItem key={i.id} iteration={i} sidebar={sidebar} />
              ))}
        </ul>
      )}
    </section>
  );
}

/** Iteration の行。開くと中の done・abandoned のチケットを出す。サイドバーでは開閉の印を付け、中を Epic ごとにまとめる */
function IterationItem({ iteration: i, sidebar }: { iteration: Iteration; sidebar: boolean }) {
  const store = useStore();
  const [opened, setOpened] = useState(false);
  const epics = epicCountsOf(i.id, store.tickets);
  const finished = store.tickets
    .filter((t) => t.iteration === i.id && (t.status === "done" || t.status === "abandoned"))
    .sort(byNumber);
  const period =
    i.start || i.end ? `${i.start ?? "?"} 〜 ${i.end ?? "?"}` : sidebar ? "期間の記録なし" : "";
  const meta = [period, i.goal].filter(Boolean).join(" ・ ");
  return (
    <li>
      <details
        className={`history-item${sidebar ? " fold" : ""}`}
        onToggle={(e) => e.currentTarget.open && setOpened(true)}
      >
        <summary className="history-row">
          <DetailLink route={{ page: "iterations", id: i.id }}>
            <code>{i.id}</code>
          </DetailLink>
          <span className="name" title={i.name}>
            {i.name}
          </span>
          <span className="counts" title="閉じたときに記録した完了と持ち越しの件数">
            {countsText(i)}
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
        {sidebar ? (
          opened ? (
            <SidebarIterationTickets iteration={i.id} finished={finished} />
          ) : null
        ) : finished.length === 0 ? (
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

/**
 * サイドバーで開いた Iteration の中：終わったチケットを Epic ごとの小見出しでまとめ、最後に持ち越したチケットを出す。
 * 持ち越しは履歴から求めるので、開いたときに 1 回だけ history を読む
 */
function SidebarIterationTickets({
  iteration,
  finished,
}: {
  iteration: string;
  finished: readonly Ticket[];
}) {
  const store = useStore();
  const [carried, setCarried] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    store.client
      .run<HistoryLog>("history", {})
      .then((r) => alive && setCarried(carriedOverFrom(iteration, r.data.events, store.tickets)))
      .catch(() => alive && setCarried([]));
    return () => {
      alive = false;
    };
  }, [iteration, store.client, store.tickets]);
  const byId = new Map<string, Ticket>(store.tickets.map((t) => [t.id, t]));
  const carriedTickets = (carried ?? []).flatMap((id) => byId.get(id) ?? []);
  return (
    <div className="history-groups">
      {finished.length === 0 ? <p className="empty">終わったチケットはない</p> : null}
      {groupByEpic(finished).map((g) => (
        <section key={g.epic ?? "-"} className="history-group">
          <h3>
            {g.epic ? (
              <>
                <DetailLink route={{ page: "epics", id: g.epic }}>{g.epic}</DetailLink>{" "}
                {store.epics.find((e) => e.id === g.epic)?.title ?? ""}
              </>
            ) : (
              "Epic なし"
            )}{" "}
            <span className="muted">{g.tickets.length} 件</span>
          </h3>
          <div className="rows">
            {g.tickets.map((t) => (
              <TicketRow key={t.id} ticket={t} hideAssignee />
            ))}
          </div>
        </section>
      ))}
      {carriedTickets.length > 0 ? (
        <section className="history-group">
          <h3>
            持ち越し <span className="muted">{carriedTickets.length} 件</span>
          </h3>
          <div className="rows">
            {carriedTickets.map((t) => (
              <div key={t.id} className="history-ticket">
                <TicketRow ticket={t} hideAssignee />
                <small className="history-ticket-meta">
                  {t.iteration ? (
                    <>
                      今は{" "}
                      <DetailLink route={{ page: "iterations", id: t.iteration }}>
                        {t.iteration}
                      </DetailLink>
                    </>
                  ) : (
                    "今は Iteration なし"
                  )}
                </small>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** サイドバーの閉じた Epic の行：番号・タイトル（2 行まで）、2 段目に件数・閉じた日・チケットが入っていた Iteration。進捗バーは出さない */
function SidebarEpicItem({ epic: e }: { epic: EpicRow }) {
  const store = useStore();
  const iterations = iterationsOfEpic(e.id, store.tickets);
  return (
    <li className="history-row history-epic">
      <DetailLink route={{ page: "epics", id: e.id }}>
        <code>{e.id}</code>
      </DetailLink>
      <span className="name" title={e.title}>
        {e.title}
      </span>
      <small>
        {e.progress.total > 0 ? `${e.progress.total} 件` : "チケットなし"}
        {" ・ "}
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

/** チケットの見方：終わったチケットの一覧。history のコマンドで終えた時刻を求める */
function TicketView({
  toggle,
  query,
  setQuery,
}: {
  toggle: ReactNode;
  query: string;
  setQuery: (q: string) => void;
}) {
  const store = useStore();
  const sidebar = useHost().surface === "sidebar";
  const [log, setLog] = useState<HistoryLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [epic, setEpic] = useState("");
  useEffect(() => {
    let alive = true;
    store.client
      .run<HistoryLog>("history", {})
      .then((r) => alive && (setLog(r.data), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [store.client, store.tickets]);
  const finishedAt = useMemo(() => finishedAtOf(log?.events ?? []), [log]);
  const all = useMemo(
    () => finishedTickets(store.tickets, finishedAt, { query: "", result: "", epic: "" }),
    [store.tickets, finishedAt],
  );
  const rows = useMemo(
    () => finishedTickets(store.tickets, finishedAt, { query, result, epic }),
    [store.tickets, finishedAt, query, result, epic],
  );
  const epics = useMemo(
    () =>
      [...new Set(all.flatMap((r) => (r.ticket.epic ? [r.ticket.epic] : [])))].sort((a, b) =>
        byNumber({ id: a }, { id: b }),
      ),
    [all],
  );
  const filtered = query.trim() || result || epic;
  return (
    <section>
      <div className="toolbar">
        <h1>履歴</h1>
        {toggle}
        <input
          type="search"
          placeholder={sidebar ? SIDEBAR_SEARCH : "番号・タイトル・ラベルで探す"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="チケットを探す"
        />
        <label>
          結果
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">すべて</option>
            <option value="done">{store.labelOf("done")}</option>
            <option value="abandoned">{store.labelOf("abandoned")}</option>
          </select>
        </label>
        {epics.length > 0 ? (
          <label>
            Epic
            <select value={epic} onChange={(e) => setEpic(e.target.value)}>
              <option value="">すべて</option>
              {epics.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="muted">
          {filtered ? `${rows.length} / ${all.length} 件` : `${all.length} 件`}
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {log && (log.shallow || all.some((r) => r.approximate)) ? (
        <p className="muted">
          履歴が浅いか欠けているので、終えた日の分からないチケットは更新日（updated_at）で並べている（日付に
          ~ を付けた）
        </p>
      ) : null}
      {!log && !error ? (
        <p className="muted">読み込み中…</p>
      ) : all.length === 0 ? (
        <p className="empty">終わったチケットはない</p>
      ) : rows.length === 0 ? (
        <p className="empty">当たるチケットはない</p>
      ) : sidebar ? (
        <SidebarFinished rows={rows} />
      ) : (
        <ul className="rows history-finished">
          {rows.map(({ ticket: t, at, approximate }) => (
            <li key={t.id}>
              <StatusDot status={t.status} />
              <TicketLink id={t.id} />
              <span className="row-title" title={t.title}>
                {t.title} <Tags labels={t.labels} />
              </span>
              <span className="muted">{store.labelOf(t.status)}</span>
              {t.iteration ? (
                <DetailLink route={{ page: "iterations", id: t.iteration }}>
                  {t.iteration}
                </DetailLink>
              ) : (
                <span className="muted">—</span>
              )}
              {t.epic ? (
                <DetailLink route={{ page: "epics", id: t.epic }}>{t.epic}</DetailLink>
              ) : (
                <span className="muted">—</span>
              )}
              <span className="muted">{t.pr ? `#${t.pr}` : "—"}</span>
              <time
                dateTime={at}
                className="muted"
                title={approximate ? "履歴から分からないので更新日" : "終えた日時"}
              >
                {approximate ? "~" : ""}
                {formatTime(at).slice(0, 10)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * サイドバーのチケットの見方：終えた日を小見出しにし、行は丸印・番号・タイトル（2 行まで）と、2 段目に値のある Iteration・Epic・PR だけ。
 * 中止の行は薄く出す
 */
function SidebarFinished({ rows }: { rows: readonly FinishedRow[] }) {
  return (
    <div className="history-groups">
      {groupByDay(rows).map((g) => (
        <section key={g.day} className="history-group">
          <h3>
            {g.day} <span className="muted">{g.rows.length} 件</span>
          </h3>
          <div className="rows">
            {g.rows.map(({ ticket: t }) => {
              const hasMeta = !!(t.iteration || t.epic || t.pr);
              return (
                <div
                  key={t.id}
                  className={`history-ticket${t.status === "abandoned" ? " abandoned" : ""}`}
                >
                  <TicketRow ticket={t} hideAssignee />
                  {hasMeta ? (
                    <small className="history-ticket-meta">
                      {[
                        t.iteration ? (
                          <DetailLink key="i" route={{ page: "iterations", id: t.iteration }}>
                            {t.iteration}
                          </DetailLink>
                        ) : null,
                        t.epic ? (
                          <DetailLink key="e" route={{ page: "epics", id: t.epic }}>
                            {t.epic}
                          </DetailLink>
                        ) : null,
                        t.pr ? <span key="p">#{t.pr}</span> : null,
                      ]
                        .filter(Boolean)
                        .flatMap((el, n) => (n > 0 ? [" ・ ", el] : [el]))}
                    </small>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
