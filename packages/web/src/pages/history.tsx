// 履歴（UI-5）。終わったものを見る画面で、見方を「Iteration / Epic / チケット」で切り替える。検索欄は共通。
// 見方・検索語・結果の絞り込みはハッシュ（?view=・?q=・?result=）に持ち、開いた行は見た目の状態（useUiState）に持つ。
// どちらもタブを移って戻ったときに残す（履歴のタブのリンクは最後に見た履歴のハッシュを指す。app.tsx）
// Iteration の見方：closed の Iteration を閉じた新しい順に 2 段の行で出す（KanbanForge の History のタブと同じ形）。
// 1 段目は番号・目標（目標がなければ名前）と件数のチップ（完了・中止・持ち越し）、2 段目は名前（目標を 1 段目に出したとき）・期間と、
// 終わったチケットの Epic ごとの内訳（Epic なしを含み、合計は終わったチケットの件数に合う）。
// 行を開くと中の done・abandoned のチケットを出す。Run の実績はここに出さず、2 段目の「Run の集計」から
// その Iteration で絞った Run の画面（#/runs?by=iteration&iteration=s5）を開いて見る（左パネルには Run の画面がなく、リンクも出さない）。
// Epic の見方：closed の Epic を閉じた新しい順に、進捗・閉じた日と、チケットが入っていた Iteration を出す。
// チケットの見方：done・abandoned のチケットを終えた新しい順に、結果・Iteration・Epic・PR・終えた日を出す。終えた時刻は
// history のコマンド（deguboard ブランチの履歴）から求め、履歴が浅くて分からないものは updated_at で代え、そう出す。
// 絞り込みは検索と結果（完了・中止）だけ。Iteration・Epic で分けて見るのはそれぞれの見方に任せる。
// 番号を押すと詳細を開く（サイドバーとパネルでは拡張ホストに頼んでエディタに、ブラウザではハッシュ遷移）。
// サイドバーでは狭い幅で読めるよう描き方を変える：Iteration の行は開閉の印を付け、開くと番号の順の 1 本の一覧（履歴用の行。
// components/history-rows.tsx）で出し、持ち越しを最後に分ける。
// Epic の見方は進捗バーをやめてタイトルを 2 行まで出し、Iteration の行と同じ件数のチップを付ける。行を開くと中の終わったチケットを
// 番号の順の 1 本の一覧（2 段目は Iteration・PR）で出し、終わったチケットのない Epic は薄く出して開けない。
// チケットの見方は日付の見出しを付けず、終えた新しい順の 1 本の一覧（履歴用の行。2 段目は Iteration・PR・終えた日）で出す。
// 検索欄と結果の絞り込みは 1 行に並べる。
// サイドバーの Iteration と Epic の見方では、検索語があるあいだ残った行を開き、当たったチケットだけを印付きで出す。
// 「すべて見る」でその行の全件の一覧に戻せる。検索中に閉じた行や「すべて見る」は検索語を変えると捨て、検索語を消すと検索前の開閉に戻る

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useCommandData } from "../command-data.js";
import { ASK_SECTIONS, useAskSpot } from "../components/ask-menu.js";
import { DetailLink, ProgressBar, StatusDot, Tags, TicketLink } from "../components/parts.js";
import { HistoryTicketList, HistoryTicketRow } from "../components/history-rows.js";
import { useAskCurrent, useHost, useUiState } from "../host.js";
import { NO_VALUE } from "../components/run-parts.js";
import { formatTime } from "../components/timeline.js";
import { hrefOf, navigate, replaceRoute, type HistoryQuery, type HistoryView } from "../router.js";
import { useStore } from "../store.js";
import {
  byNumber,
  isFinished,
  isStatus,
  ticketMatchesQuery,
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
 * 件数のチップ（Iteration と Epic の行で共用）。完了は記録がなければ「—」で出す。
 * 中止と持ち越しは 1 件以上のときだけ色付きで出す
 */
function CountChips({
  completed,
  abandoned,
  carried = 0,
  title,
}: {
  completed: number | undefined;
  abandoned: number;
  carried?: number | undefined;
  title?: string | undefined;
}) {
  return (
    <span className="counts" title={title}>
      <span className="badge">完了 {completed ?? NO_VALUE}</span>
      {abandoned > 0 ? <span className="badge count-abandoned">中止 {abandoned}</span> : null}
      {carried > 0 ? <span className="badge warn">持ち越し {carried}</span> : null}
    </span>
  );
}

/**
 * 検索：当たるチケットを含むものだけ残す。key はチケットの iteration か epic。
 * サイドバーではラベルにも当て、行を開いて当たったチケットを出すので、終わったチケット（行の中に出るもの）だけを見る
 */
function filterHistory<T extends { id: string }>(
  rows: readonly T[],
  tickets: readonly Ticket[],
  query: string,
  key: "iteration" | "epic" = "iteration",
  sidebar = false,
): T[] {
  if (!query.trim()) return [...rows];
  const hit = new Set<string>(
    tickets
      .filter(
        (t) =>
          t[key] && (!sidebar || isFinished(t.status)) && ticketMatchesQuery(t, query, sidebar),
      )
      .map((t) => t[key]!),
  );
  return rows.filter((r) => hit.has(r.id));
}

/** 行の開閉。open は開いているか、all は検索中に「すべて見る」にしたか（検索していなければ常に true） */
interface RowFold {
  /** 検索で開いているか（検索語があり、検索で開く画面のとき） */
  searching: boolean;
  open: boolean;
  all: boolean;
  setOpen: (open: boolean) => void;
  setAll: (all: boolean) => void;
}

const toggled = (ids: readonly string[], id: string, on: boolean): string[] =>
  on ? (ids.includes(id) ? [...ids] : [...ids, id]) : ids.filter((x) => x !== id);

/**
 * 履歴の行（Iteration・Epic の番号）ごとの開閉。検索前の開いた行（opened）と、検索中だけの上書き（閉じた行・
 * 「すべて見る」にした行）を分けて持つ。検索中は既定で開き、上書きは検索語を変えると捨てるので、検索語を消すと検索前に戻る。
 * opened は番号の配列で持ち、画面の外（Webview の state）にそのまま置ける。search は検索で開くときの検索語（開かないなら空）
 */
function useRowFolds(
  search: string,
  [opened, setOpened]: [readonly string[], (ids: readonly string[]) => void] = [[], () => {}],
): (id: string) => RowFold {
  const q = search.trim().toLowerCase();
  const [during, setDuring] = useState<{
    query: string;
    closed: readonly string[];
    all: readonly string[];
  }>({ query: "", closed: [], all: [] });
  const current = during.query === q ? during : { query: q, closed: [], all: [] };
  return (id) =>
    q
      ? {
          searching: true,
          open: !current.closed.includes(id),
          all: current.all.includes(id),
          setOpen: (open) => setDuring({ ...current, closed: toggled(current.closed, id, !open) }),
          setAll: (all) => setDuring({ ...current, all: toggled(current.all, id, all) }),
        }
      : {
          searching: false,
          open: opened.includes(id),
          all: true,
          setOpen: (open) => setOpened(toggled(opened, id, open)),
          setAll: () => {},
        };
}

/**
 * 終わったチケットの Epic ごとの件数（groupByEpic の順：多い順、同じなら番号の順、Epic なしは最後）。
 * Epic なしも数えるので、合計は渡したチケットの件数に合う
 */
export function epicCountsOf(
  finished: readonly Ticket[],
): { epic: string | null; count: number }[] {
  return groupByEpic(finished).map((g) => ({ epic: g.epic, count: g.tickets.length }));
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
 * 今もその Iteration に入っているものは除く。
 * core の carriedOverFrom（iteration.show の next.moved、iteration.ts）と同じ求め方の写し。
 * web は core の実行時のコードを取り込まず（ADR-007）、iteration.show に置き換えると Iteration ごとに履歴を読むため写す。
 * 2 つが同じ入力で同じ結果を返すことは history.test.tsx が確かめる
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

/** チケットを終えた時刻：最後に done か abandoned になった出来事の時刻 */
function finishedAtOf(events: readonly HistoryEvent[]): Map<string, string> {
  const at = new Map<string, string>();
  for (const e of events)
    if (
      e.kind === "ticket" &&
      e.changes.some((c) => c.field === "status" && isStatus(c.to) && isFinished(c.to))
    )
      at.set(e.id, e.at);
  return at;
}

interface FinishedRow {
  ticket: Ticket;
  /** 終えた時刻。履歴から分からなければ updated_at */
  at: string;
  /** at を updated_at で代えたか */
  approximate: boolean;
}

interface FinishedFilter {
  query: string;
  /** done か abandoned。空ならどちらも */
  result: string;
}

/** 持ち越しを求める履歴。行を開いたときに need を呼ぶと画面で 1 回だけ読み、行を開き直しても読み直さない */
interface CarriedOver {
  need: () => void;
  /** 読めるまでは null。読めなければ空 */
  events: readonly HistoryEvent[] | null;
}

function useCarriedOver(): CarriedOver {
  const [needed, setNeeded] = useState(false);
  const { data, error } = useCommandData<HistoryLog>("history", needed ? {} : null);
  const need = useCallback(() => setNeeded(true), []);
  return { need, events: error ? [] : (data?.events ?? null) };
}

/** 終わったチケットを終えた新しい順に。検索は番号・タイトル・ラベル */
function finishedTickets(
  tickets: readonly Ticket[],
  finishedAt: ReadonlyMap<string, string>,
  f: FinishedFilter,
): FinishedRow[] {
  return tickets
    .filter((t) => isFinished(t.status))
    .filter((t) => !f.result || t.status === f.result)
    .filter((t) => ticketMatchesQuery(t, f.query))
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

/** 見方ごとの件数。filtered なら「当たった数 / 全体」で出す */
type ViewCounts = Record<HistoryView, { hit: number; total: number; filtered: boolean }>;

/**
 * 見方の切り替え：枠も塗りもない文字に件数のバッジを付ける。選んだ見方だけ文字を濃く太くし、aria-pressed で伝える。
 * 件数の行は持たず、絞り込み中はバッジが「当たった数 / 全体」になる（狭い幅に収まるよう / の前後は細い空白）
 */
function ViewSwitch({
  route,
  view,
  counts,
}: {
  route: HistoryQuery;
  view: HistoryView;
  counts: ViewCounts;
}) {
  return (
    <span className="view-switch" role="group" aria-label="見方">
      {VIEWS.map((v) => {
        const c = counts[v.view];
        return (
          <button
            key={v.view}
            type="button"
            aria-pressed={view === v.view}
            onClick={() => navigate({ ...route, page: "history", view: v.view })}
          >
            {v.label}{" "}
            <span className="badge">
              {c.filtered ? `${c.hit}\u2009/\u2009${c.total}` : c.total}
            </span>
          </button>
        );
      })}
    </span>
  );
}

/**
 * 履歴のタイトル行の吹き出しの対象（UI-15）。shown は出ている行の番号、isOpen は行が開いているか、opened は検索前に開いた行（開いた順）。
 * 開いている行のうち最後に開いたものにし、それがなく（検索で開いた行だけ）開いている行が 1 つならそれにする。どちらもなければ対象なし
 */
export function historyAskTarget(
  shown: readonly string[],
  isOpen: (id: string) => boolean,
  opened: readonly string[],
): string[] {
  const open = shown.filter(isOpen);
  const last = opened.findLast((id) => open.includes(id));
  if (last) return [last];
  return open.length === 1 ? [open[0]!] : [];
}

/** サイドバーの検索欄の案内（バックログと同じ言い方） */
const SIDEBAR_SEARCH = "番号・タイトル・ラベルで検索";

export function HistoryPage({ route }: { route: HistoryQuery }) {
  const store = useStore();
  const sidebar = useHost().surface === "sidebar";
  const view = route.view ?? "iteration";
  const query = route.q ?? "";
  // 1 文字ごとに戻る履歴を積まないよう、ハッシュは書き換える
  const setQuery = (q: string) => replaceRoute({ ...route, page: "history", q: q || undefined });
  // 検索前の開いた行（Iteration・Epic の番号）。ハッシュには入れない
  const opened = useUiState<readonly string[]>("history.opened", []);
  // 検索で行を開くのはサイドバーだけ
  const foldOf = useRowFolds(sidebar ? query : "", opened);
  const carried = useCarriedOver();
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
  // 見方ごとの件数。チケットの見方ではチケットの件数を TicketView が結果の絞り込みを含めて数え直すので、ここでは数えない
  const counts = useMemo<ViewCounts>(() => {
    const searching = query.trim() !== "";
    const count = <T extends { id: string }>(list: readonly T[], key: "iteration" | "epic") => ({
      hit: filterHistory(list, store.tickets, query, key, sidebar).length,
      total: list.length,
      filtered: searching,
    });
    const finished = (q: string) =>
      view === "ticket"
        ? 0
        : finishedTickets(store.tickets, new Map(), { query: q, result: "" }).length;
    return {
      iteration: count(iterations, "iteration"),
      epic: count(epics, "epic"),
      ticket: { hit: finished(query), total: finished(""), filtered: searching },
    };
  }, [iterations, epics, store.tickets, query, sidebar, view]);
  // タイトル行の吹き出しは開いている行を対象にする（UI-15）。ブラウザの Epic の行は開かない
  const foldable = view === "iteration" || (view === "epic" && sidebar);
  useAskCurrent(
    foldable
      ? historyAskTarget(
          rows.map((r) => r.id),
          (id) => foldOf(id).open,
          opened[0],
        )
      : [],
  );
  if (view === "ticket")
    return <TicketView route={route} counts={counts} query={query} setQuery={setQuery} />;
  return (
    <section>
      <div className="toolbar">
        <h1>履歴</h1>
        <ViewSwitch route={route} view={view} counts={counts} />
        <input
          type="search"
          placeholder={sidebar ? SIDEBAR_SEARCH : "チケットの番号・タイトルで探す"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="チケットを探す"
        />
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
                  <SidebarEpicItem key={e.id} epic={e} fold={foldOf(e.id)} query={query} />
                ) : (
                  <EpicItem key={e.id} epic={e} />
                ),
              )
            : (rows as Iteration[]).map((i) => (
                <IterationItem
                  key={i.id}
                  iteration={i}
                  sidebar={sidebar}
                  fold={foldOf(i.id)}
                  query={query}
                  carried={carried}
                />
              ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 行の開閉を fold に合わせる details の属性。開閉は呼ぶ側（useRowFolds）が持ち、ここでは描いた値と違うときだけ伝える
 * （open を描き直したときにも toggle が来るので）
 */
function foldProps(fold: RowFold) {
  return {
    open: fold.open,
    onToggle: (e: SyntheticEvent<HTMLDetailsElement>) => {
      if (e.currentTarget.open !== fold.open) fold.setOpen(e.currentTarget.open);
    },
  };
}

/**
 * 検索で開いた行の中の見出し：当たった件数と「すべて見る」（すべて見ているときは「当たったものだけ」）。
 * 当たったのが全件なら切り替えは出さない
 */
function SearchHitsBar({ hits, total, fold }: { hits: number; total: number; fold: RowFold }) {
  return (
    <p className="history-hits">
      {fold.all ? `すべて ${total} 件` : `当たった ${hits} / ${total} 件`}
      {hits < total ? (
        <button type="button" className="link" onClick={() => fold.setAll(!fold.all)}>
          {fold.all ? "当たったものだけ" : "すべて見る"}
        </button>
      ) : null}
    </p>
  );
}

/** Iteration の行。開くと中の done・abandoned のチケットを出す。サイドバーでは開閉の印を付け、中を番号の順の 1 本の一覧（履歴用の行）で出す */
function IterationItem({
  iteration: i,
  sidebar,
  fold,
  query,
  carried,
}: {
  iteration: Iteration;
  sidebar: boolean;
  fold: RowFold;
  query: string;
  carried: CarriedOver;
}) {
  const store = useStore();
  const finished = store.tickets
    .filter((t) => t.iteration === i.id && isFinished(t.status))
    .sort(byNumber);
  const epics = epicCountsOf(finished);
  const abandoned = finished.filter((t) => t.status === "abandoned").length;
  // 目標があれば 1 段目に目標を出し、名前は 2 段目に小さく出す。期間の記録がなければ何も書かない
  const goal = i.goal?.trim();
  const period = i.start || i.end ? `${i.start ?? "?"} 〜 ${i.end ?? "?"}` : "";
  const meta = [goal ? i.name : "", period].filter(Boolean).join(" ・ ");
  // 左パネルでは閉じた Iteration の行から頼む（UI-15）
  const spot = useAskSpot(
    sidebar
      ? { targets: [i.id], label: `Iteration ${i.id}`, section: ASK_SECTIONS.historyRow }
      : null,
  );
  return (
    <li>
      <details className={`history-item${sidebar ? " fold" : ""}`} {...foldProps(fold)}>
        <summary className="history-row" {...(sidebar ? spot.props : {})}>
          <DetailLink route={{ page: "iterations", id: i.id }}>
            <code>{i.id}</code>
          </DetailLink>
          <span className="name" title={goal ? `${goal}（${i.name}）` : i.name}>
            {goal || i.name}
          </span>
          {/* 完了と持ち越しは iteration.close が記録した値（core が数える）をそのまま出し、web では数え直さない。
              中止は記録がないので Iteration に入っている abandoned を数える */}
          <CountChips
            completed={i.completed}
            abandoned={abandoned}
            carried={i.carried_over}
            title="完了と持ち越しは閉じたときに記録した件数"
          />
          <small>
            {meta}
            {epics.length > 0 ? (
              <span className="epics">
                {meta ? " ・ " : ""}内訳:{" "}
                {epics.map((e, n) => (
                  <span key={e.epic ?? "-"}>
                    {n > 0 ? ", " : ""}
                    {e.epic ? (
                      <DetailLink route={{ page: "epics", id: e.epic }}>{e.epic}</DetailLink>
                    ) : (
                      "Epic なし"
                    )}{" "}
                    {e.count}
                  </span>
                ))}
              </span>
            ) : null}
            {/* Run の数字はここに出さず、その Iteration で絞った Run の画面へのリンクだけを置く。
                左パネルには Run の画面がないので出さない（UI-12） */}
            {sidebar ? null : (
              <>
                {meta || epics.length > 0 ? " ・ " : ""}
                <a
                  className="history-runs-link"
                  href={hrefOf({ page: "runs", by: "iteration", iteration: i.id })}
                >
                  Run の集計
                </a>
              </>
            )}
          </small>
          {spot.overlay}
        </summary>
        {sidebar ? (
          !fold.open ? null : fold.searching && !fold.all ? (
            <SearchHits finished={finished} query={query} fold={fold} />
          ) : (
            <SidebarIterationTickets
              iteration={i.id}
              finished={finished}
              carried={carried}
              query={fold.searching ? query : ""}
              header={
                fold.searching ? (
                  <SearchHitsBar
                    hits={finished.filter((t) => ticketMatchesQuery(t, query)).length}
                    total={finished.length}
                    fold={fold}
                  />
                ) : null
              }
            />
          )
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
 * サイドバーで開いた Iteration の中：終わったチケットを番号の順の 1 本の一覧で出し（Epic で分けて見るのは Epic のタブ）、
 * 最後に持ち越したチケットを 1 件以上あるときだけ出す。多いときは先頭の数件だけ出し、「ほか N 件」で残りを開ける。
 * 持ち越しは履歴から求める（読むのは画面で 1 回。useCarriedOver）
 */
function SidebarIterationTickets({
  iteration,
  finished,
  carried: carriedOver,
  query,
  header,
}: {
  iteration: string;
  finished: readonly Ticket[];
  carried: CarriedOver;
  /** 検索中に「すべて見る」で出すとき、当たった部分に印を付ける検索語 */
  query: string;
  /** 一覧の前に出すもの（検索中の件数と切り替え） */
  header?: ReactNode;
}) {
  const store = useStore();
  const { need, events } = carriedOver;
  useEffect(need, [need]);
  const carried = useMemo(
    () => (events ? carriedOverFrom(iteration, events, store.tickets) : null),
    [iteration, events, store.tickets],
  );
  const byId = new Map<string, Ticket>(store.tickets.map((t) => [t.id, t]));
  const carriedTickets = (carried ?? []).flatMap((id) => byId.get(id) ?? []);
  return (
    <div className="history-groups">
      {header}
      {finished.length === 0 ? (
        <p className="empty">終わったチケットはない</p>
      ) : (
        <HistoryTicketList
          tickets={finished}
          row={(t) => <HistoryTicketRow ticket={t} query={query} />}
        />
      )}
      {carriedTickets.length > 0 ? (
        <section className="history-group history-carried">
          <h3>
            持ち越し <span className="muted">{carriedTickets.length} 件</span>
          </h3>
          <HistoryTicketList
            tickets={carriedTickets}
            row={(t) => (
              <HistoryTicketRow
                ticket={t}
                query={query}
                note={
                  t.iteration ? (
                    <>
                      今は{" "}
                      <DetailLink route={{ page: "iterations", id: t.iteration }}>
                        {t.iteration}
                      </DetailLink>
                    </>
                  ) : (
                    "今は Iteration なし"
                  )
                }
              />
            )}
          />
        </section>
      ) : null}
    </div>
  );
}

/**
 * 検索で開いた行の中：終わったチケットのうち当たったものだけを番号の順に印付きで出す（持ち越しは出さない）。
 * 「すべて見る」で行の全件の一覧に戻す。「ほか N 件」の開いた状態は検索語を変えたら戻す
 */
function SearchHits({
  finished,
  query,
  fold,
  showIteration = false,
}: {
  finished: readonly Ticket[];
  query: string;
  fold: RowFold;
  /** Epic の行の中では Epic を省き Iteration を出す */
  showIteration?: boolean;
}) {
  const hits = finished.filter((t) => ticketMatchesQuery(t, query));
  return (
    <div className="history-groups">
      <SearchHitsBar hits={hits.length} total={finished.length} fold={fold} />
      <HistoryTicketList
        key={query.trim().toLowerCase()}
        tickets={hits}
        row={(t) => (
          <HistoryTicketRow
            ticket={t}
            query={query}
            showIteration={showIteration}
            showEpic={!showIteration}
          />
        )}
      />
    </div>
  );
}

/** Epic に入っている終わったチケット（done・abandoned）を番号の順に */
function finishedOfEpic(epic: string, tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.epic === epic && isFinished(t.status)).sort(byNumber);
}

/**
 * サイドバーの閉じた Epic の行：番号・タイトル（2 行まで）、件数のチップ（Iteration の行と同じ形。完了・中止は core の
 * epic.list が返す進み（progress.by_status）の done・abandoned を読み、web では数え直さない）、2 段目に閉じた日・
 * チケットが入っていた Iteration。進捗バーは出さない。
 * 開くと中の終わったチケットを番号の順の 1 本の一覧（履歴用の行。Epic は省き Iteration を出す）で出す。
 * 終わったチケットのない Epic は薄く出し、開けない
 */
function SidebarEpicItem({
  epic: e,
  fold,
  query,
}: {
  epic: EpicRow;
  fold: RowFold;
  query: string;
}) {
  const store = useStore();
  const iterations = iterationsOfEpic(e.id, store.tickets);
  const finished = finishedOfEpic(e.id, store.tickets);
  // 閉じた Epic の行から頼む（左パネルだけの部品。UI-15）
  const spot = useAskSpot({
    targets: [e.id],
    label: `Epic ${e.id}`,
    section: ASK_SECTIONS.historyRow,
  });
  const head = (
    <>
      <DetailLink route={{ page: "epics", id: e.id }}>
        <code>{e.id}</code>
      </DetailLink>
      <span className="name" title={e.title}>
        {e.title}
      </span>
      <CountChips
        completed={e.progress.by_status.done}
        abandoned={e.progress.by_status.abandoned}
        title="完了と中止は今の Epic のチケットから数えた件数"
      />
      <small>
        {finished.length === 0
          ? `${e.progress.total > 0 ? "終わったチケットなし" : "チケットなし"} ・ `
          : ""}
        {e.closed_at ? `${e.closed_at.slice(0, 10)} に閉じた` : "閉じた日は不明"}
        {iterations.map((id) => (
          <span key={id}>
            {" ・ "}
            <DetailLink route={{ page: "iterations", id }}>{id}</DetailLink>
          </span>
        ))}
      </small>
      {spot.overlay}
    </>
  );
  if (finished.length === 0)
    return (
      <li>
        <div className="history-item history-empty">
          <div className="history-row history-epic" tabIndex={0} {...spot.props}>
            {head}
          </div>
        </div>
      </li>
    );
  return (
    <li>
      <details className="history-item fold" {...foldProps(fold)}>
        <summary className="history-row history-epic" {...spot.props}>
          {head}
        </summary>
        {!fold.open ? null : fold.searching && !fold.all ? (
          <SearchHits finished={finished} query={query} fold={fold} showIteration />
        ) : (
          <div className="history-groups">
            {fold.searching ? (
              <SearchHitsBar
                hits={finished.filter((t) => ticketMatchesQuery(t, query)).length}
                total={finished.length}
                fold={fold}
              />
            ) : null}
            <HistoryTicketList
              key={e.id}
              tickets={finished}
              row={(t) => (
                <HistoryTicketRow
                  ticket={t}
                  showEpic={false}
                  showIteration
                  query={fold.searching ? query : ""}
                />
              )}
            />
          </div>
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

/** チケットの見方：終わったチケットの一覧。history の結果を待たず updated_at の順で出し、届いたら終えた時刻で並べ直す */
function TicketView({
  route,
  counts,
  query,
  setQuery,
}: {
  route: HistoryQuery;
  counts: ViewCounts;
  query: string;
  setQuery: (q: string) => void;
}) {
  const store = useStore();
  const sidebar = useHost().surface === "sidebar";
  const { data: log, error } = useCommandData<HistoryLog>("history", {});
  const result = route.result ?? "";
  const setResult = (value: string) =>
    replaceRoute({
      ...route,
      page: "history",
      result: value === "done" || value === "abandoned" ? value : undefined,
    });
  const finishedAt = useMemo(() => finishedAtOf(log?.events ?? []), [log]);
  const all = useMemo(
    () => finishedTickets(store.tickets, finishedAt, { query: "", result: "" }),
    [store.tickets, finishedAt],
  );
  const rows = useMemo(
    () => finishedTickets(store.tickets, finishedAt, { query, result }),
    [store.tickets, finishedAt, query, result],
  );
  // チケットの見方では結果の絞り込みもチケットのバッジに映す
  const filtered = query.trim() !== "" || result !== "";
  return (
    <section>
      <div className="toolbar">
        <h1>履歴</h1>
        <ViewSwitch
          route={route}
          view="ticket"
          counts={{ ...counts, ticket: { hit: rows.length, total: all.length, filtered } }}
        />
        {/* 検索欄と結果の絞り込みは 1 行に並べる（サイドバーでも折り返さない） */}
        <div className="history-filter">
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
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {log && (log.shallow || all.some((r) => r.approximate)) ? (
        <p className="muted">
          履歴が浅いか欠けているので、終えた日の分からないチケットは更新日（updated_at）で並べている（日付に
          ~ を付けた）
        </p>
      ) : null}
      {!log && !error ? (
        // 終えた時刻は history の結果が届くまで分からないので、updated_at の順で先に出しておく
        <p className="muted history-loading" role="status">
          終えた時刻を読み込み中…（届くまでは更新日の順）
        </p>
      ) : null}
      {all.length === 0 ? (
        <p className="empty">終わったチケットはない</p>
      ) : rows.length === 0 ? (
        <p className="empty">当たるチケットはない</p>
      ) : sidebar ? (
        // 「ほか N 件」を開いた状態は、検索や結果の絞り込みが変わったら戻す
        <SidebarFinished key={`${result}\u0000${query}`} rows={rows} />
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
 * サイドバーのチケットの見方：日付の見出しを付けず、終えた新しい順の 1 本の一覧（履歴用の行）で出す。
 * 2 段目は Iteration・PR・終えた日（Epic で分けて見るのは Epic の見方）。終えた日が履歴から分からないものは更新日に ~ を付ける。
 * 多いときは先頭の数件だけ出し、「ほか N 件」で残りを開ける
 */
function SidebarFinished({ rows }: { rows: readonly FinishedRow[] }) {
  const byId = new Map(rows.map((r) => [r.ticket.id, r]));
  return (
    <div className="history-groups">
      <HistoryTicketList
        tickets={rows.map((r) => r.ticket)}
        row={(t) => {
          const { at, approximate } = byId.get(t.id)!;
          return (
            <HistoryTicketRow
              ticket={t}
              showIteration
              showEpic={false}
              note={
                <time
                  dateTime={at}
                  title={approximate ? "履歴から分からないので更新日" : "終えた日時"}
                >
                  {approximate ? "~" : ""}
                  {formatTime(at).slice(0, 10)}
                </time>
              }
            />
          );
        }}
      />
    </div>
  );
}
