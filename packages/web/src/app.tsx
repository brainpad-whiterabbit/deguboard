// 画面の骨組み：左パネルの上のバー（画面の切り替えと、Project が 2 つ以上なら Project の切り替え）と、ハッシュで選んだページ。
// 画面はカンバン・バックログ・履歴の 3 つで、Epic の画面は置かない（計画を立てるときに Iteration・Epic・未割り当てのチケットが 3 つの画面に分かれる。
// open の Epic はバックログの欄に進捗つきで並べて絞り込みを兼ねる）。設定はたまにしか開かないので画面の切り替えに入れず、歯車で開く。
// 同期のボタンと印・設定の歯車・エージェントに頼む吹き出しはビューのタイトル行のボタンとバッジにある（拡張の view/title。UI-12）。
// エディタのパネルは詳細だけを出し、上のバーを出さない。
// エージェントに頼む入力欄（UI-15）は、開いていればページの下に出す。左パネルでは初めて開いたときに 1 度だけ、行の吹き出しの案内を出す

import { useEffect, useRef, type MouseEvent } from "react";
import { AskComposer } from "./components/ask-composer.js";
import { AskHint, AskMenuProvider, SelectionBar } from "./components/ask-menu.js";
import { Onboarding } from "./components/onboarding.js";
import { useRowNav } from "./components/row-nav.js";
import { SelectionProvider } from "./components/selection.js";
import { useAsk, useHost, useUiState } from "./host.js";
import { useStore, type Store } from "./store.js";
import { hrefOf, isDetailRoute, parseRoute, useRoute, type Route } from "./router.js";
import { BoardPage, boardIterationSelection } from "./pages/board.js";
import { BacklogPage } from "./pages/backlog.js";
import { TicketPage } from "./pages/ticket.js";
import { EpicsPage } from "./pages/epics.js";
import { IterationsPage } from "./pages/iterations.js";
import { PlansPage } from "./pages/plans.js";
import { HistoryPage } from "./pages/history.js";
import { ConfigPage } from "./pages/config.js";
import { tr, msg } from "./l10n.js";

/** 左パネルのタブ（UI-12） */
const NAV: { page: Route["page"]; label: string }[] = [
  { page: "board", label: msg("カンバン") },
  { page: "backlog", label: msg("バックログ") },
  { page: "history", label: msg("履歴") },
];

/** タブの行き先を最後に見たハッシュにする画面。バックログは絞り込みをハッシュに持たないので固定 */
type LastHashPage = "board" | "history";

/** nav.<page> に残す、最後に見たハッシュとそのときの Project */
interface LastHash {
  project: string | null;
  href: string;
}

/**
 * 残したハッシュを今も使えるか。Project が違う、今の Project にない Iteration・Epic を指す、
 * 閉じた Iteration・Epic を指すときは使えない（既定の行き先に戻す）
 */
function lastHashUsable(saved: LastHash, store: Store): boolean {
  if (saved.project !== (store.project?.id ?? null)) return false;
  const route = parseRoute(saved.href);
  if (route.page === "board") {
    if (route.iteration && !boardIterationSelection(store.iterations, route.iteration))
      return false;
    if (route.epic && !store.epics.some((e) => e.id === route.epic && e.status === "open"))
      return false;
  }
  return true;
}

/**
 * タブの行き先（最後に見たハッシュ）を nav.<page> に残して返す。その画面にいる間は今のハッシュを残し、
 * Project を切り替えたら既定の行き先に戻す。残したハッシュが使えなければ既定の行き先を返す。
 * Project の切り替えはハッシュを変えないので、切り替えたときのハッシュは前の Project の絞り込みとみなし、
 * ハッシュが変わるまではそれを残さず既定の行き先を残す（そのハッシュの Iteration・Epic は前の Project のもので、新しい Project の絞り込みではない）
 */
function useLastHref(page: LastHashPage, route: Route, store: Store): string {
  const fallback = hrefOf({ page } as Route);
  const project = store.project?.id ?? null;
  const [saved, setSaved] = useUiState<LastHash | null>(`nav.${page}`, null);
  const current = route.page === page ? hrefOf(route) : null;
  const previousProject = useRef(project);
  // 切り替えたときのハッシュ（undefined は切り替えの後でないとき）
  const hrefAtSwitch = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const switched = previousProject.current !== null && previousProject.current !== project;
    previousProject.current = project;
    if (switched) hrefAtSwitch.current = current;
    else if (hrefAtSwitch.current !== undefined && hrefAtSwitch.current !== current)
      hrefAtSwitch.current = undefined;
    const stale = hrefAtSwitch.current !== undefined;
    const next = stale ? fallback : current;
    if (next === null || project === null) return;
    if (saved?.href !== next || saved.project !== project) setSaved({ project, href: next });
  }, [current, project, fallback, saved, setSaved]);
  // 前の版は履歴のハッシュを文字列で残していた。形の違うものは使わない。消しには行かない（履歴の画面を開けば新しい形で上書きされ、
  // 残っても既定の行き先になるだけなので害がない）
  if (!saved || typeof saved !== "object" || typeof saved.href !== "string") return fallback;
  return lastHashUsable(saved, store) ? saved.href : fallback;
}

export function App() {
  const route = useRoute();
  const store = useStore();
  const host = useHost();
  const ask = useAsk();
  const sidebar = host.surface === "sidebar";
  // カンバン・履歴のタブは最後に見たハッシュ（絞り込み・見方・検索語）を指し、他のタブから戻ったときに残す
  const lastHref: Partial<Record<Route["page"], string>> = {
    board: useLastHref("board", route, store),
    history: useLastHref("history", route, store),
  };
  const shown = sidebarRoute(route, sidebar);
  // Iteration と Plan の詳細はカンバンのタブ、Epic の詳細はバックログのタブの下にあるものとして扱う（一覧の画面はない）
  const active =
    shown.page === "ticket" || shown.page === "epics"
      ? "backlog"
      : shown.page === "iterations" || shown.page === "plans"
        ? "board"
        : shown.page;
  // エディタのパネルは詳細（チケット・Iteration・Epic・Plan）だけを出し、1 枚で完結するので、タブと Project のヘッダーを出さない（UI-12）
  const panel = !sidebar;
  // サイドバーの行を ↑↓・Enter・Space・a で操作する（roving tabindex。components/row-nav.tsx）
  const { ref: rowNavRef, ...rowNav } = useRowNav(sidebar);
  return (
    <div
      className="app"
      data-surface={host.surface}
      onClick={(e) => followHashLink(e, panel ? host.show : undefined)}
    >
      {panel ? null : (
        <header className="topbar">
          <nav aria-label={tr("画面")}>
            {NAV.map((n) => (
              <a
                key={n.page}
                href={lastHref[n.page] ?? hrefOf({ page: n.page } as Route)}
                className={active === n.page ? "active" : ""}
                aria-current={active === n.page ? "page" : undefined}
              >
                {tr(n.label)}
              </a>
            ))}
          </nav>
          <div className="spacer" />
          {/* Project が 1 つなら切り替えの段を出さない（幅を節約する。hidden 属性は .project-select の display に負けるので描かない） */}
          {store.projects.length <= 1 ? null : (
            <label className="project-select">
              Project
              <select
                value={store.project?.id ?? ""}
                onChange={(e) => store.selectProject(e.target.value)}
                disabled={store.projects.length === 0}
              >
                {store.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.status === "archived" ? tr("（アーカイブ）") : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>
      )}
      <NoticeBar />
      {/* 一覧の行の複数選択は画面ごと（替えたら外す）。選んでいる間は下に帯を出す（UI-15） */}
      <SelectionProvider scope={hrefOf(shown)}>
        {/* 行・見出しの吹き出しの候補は、出ている場所（選択の帯を含む）の分を AskMenuProvider がまとめて引く（UI-15） */}
        <AskMenuProvider>
          <main
            className="page"
            ref={rowNavRef}
            onKeyDown={rowNav.onKeyDown}
            onFocus={rowNav.onFocus}
          >
            {/* 最初の読み込みが終わるまでは空状態の文言を出さない。読み直しの間は画面を出したままにする（フォームの入力を失わない） */}
            {!store.loaded ? (
              <>
                <p className="muted">{tr("読み込み中…")}</p>
                {/* Webview では前回の一覧がないときだけここに来る。文字だけにせず、節と行の骨組みを出す */}
                <LoadingSkeleton />
              </>
            ) : store.notInitialized ? (
              // dg init 前は一覧の代わりに始め方を出す（init の後は見張りの読み直しで普段の画面に変わる）
              <Onboarding />
            ) : (
              // サイドバーではチケット詳細を出さない（エディタ領域のパネルに開く。UI-12）
              <>
                {/* 案内は頼める場所のある画面（カンバン・バックログ・履歴）にだけ出す */}
                {sidebar && ASK_HINT_PAGES.has(shown.page) ? <AskHint /> : null}
                <Page route={shown} />
              </>
            )}
          </main>
          {store.loaded ? <SelectionBar /> : null}
        </AskMenuProvider>
      </SelectionProvider>
      {/* 開き直したら（対象が替わったら）中の状態を捨てる。指示の下書きと形式は見た目の状態に残る */}
      {ask.request && store.loaded ? (
        <AskComposer
          key={ask.serial}
          targets={ask.request.targets}
          action={ask.request.action}
          copyOnOpen={ask.serial > 0}
          within={ask.request.within}
          onClose={ask.close}
        />
      ) : null}
    </div>
  );
}

/** 最初の読み込みの間の骨組み：見出しと行の形だけの灰色の帯を 3 節ぶん。読み上げでは「読み込み中…」だけを読む */
const SKELETON_ROWS = [3, 2, 1];

function LoadingSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      {SKELETON_ROWS.map((rows, i) => (
        <div key={i} className="skeleton-section">
          <span className="skeleton-bar skeleton-head" />
          {Array.from({ length: rows }, (_, j) => (
            <span key={j} className="skeleton-bar" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * ハッシュのリンク（#/backlog など）は、ここで受けて自分でハッシュを書く。
 * show を渡したとき（パネル）は、一覧の画面へのリンクをハッシュにせず show に渡す（サイドバーに出す。パネルは詳細だけ）。
 * VS Code の Webview は <a> のクリックを横取りし、href がハッシュだけのリンクはページ内アンカーへのスクロールとみなして
 * preventDefault するので、ブラウザに任せるとハッシュが変わらない。React の onClick は document のハンドラより先に走る。
 * TicketLink（サイドバー）や行の選択のように先に preventDefault されたもの、修飾キーつきのクリックには触らない
 */
function followHashLink(e: MouseEvent<HTMLElement>, show?: (route: Route) => void) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  const anchor = (e.target as Element | null)?.closest?.("a[href^='#']");
  const href = anchor?.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  const route = parseRoute(href);
  if (show && !isDetailRoute(route)) show(route);
  else window.location.hash = href;
}

/** サイドバーで出す画面。チケット詳細はバックログに替える（前の版の Run の画面のハッシュは parseRoute がカンバンにする） */
function sidebarRoute(route: Route, sidebar: boolean): Route {
  if (!sidebar) return route;
  if (route.page === "ticket") return { page: "backlog" };
  return route;
}

/** 左パネルで初めての案内を出す画面（行・見出しから頼める画面） */
const ASK_HINT_PAGES: ReadonlySet<Route["page"]> = new Set(["board", "backlog", "history"]);

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "board":
      return <BoardPage query={route} />;
    case "backlog":
      return <BacklogPage />;
    case "ticket":
      // チケットが変われば編集中の状態（入力・その場で直している属性）を持ち越さない
      return <TicketPage key={route.id} id={route.id} />;
    case "epics":
      return <EpicsPage id={route.id} />;
    case "iterations":
      return <IterationsPage id={route.id} />;
    case "plans":
      return <PlansPage key={route.id} id={route.id} />;
    case "history":
      return <HistoryPage route={route} />;
    case "config":
      return <ConfigPage />;
  }
}

/** info の通知（警告の列挙）はこの時間で消える。error は閉じるまで残す */
export const INFO_NOTICE_MS = 6_000;

function NoticeBar() {
  const store = useStore();
  const n = store.notice;
  const { notify } = store;
  useEffect(() => {
    if (!n || n.kind !== "info") return;
    const timer = setTimeout(() => notify(null), INFO_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [n, notify]);
  if (!n) return null;
  return (
    <div className={`notice ${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
      <span>
        {n.text}
        {n.detail ? <small> — {n.detail}</small> : null}
      </span>
      <button type="button" onClick={() => store.notify(null)} aria-label={tr("閉じる")}>
        ×
      </button>
    </div>
  );
}
