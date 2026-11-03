// 画面の骨組み：上のバー（Project の切り替え・画面の切り替え・同期の印）と、ハッシュで選んだページ。
// サイドバーでは同期の印とボタン・設定の歯車・エージェントに頼む吹き出しを出さない（ビューのタイトル行のボタンとバッジで代える。UI-12）。
// エージェントに頼む入力欄（UI-15）は、開いていればページの下に出す。左パネルでは初めて開いたときに 1 度だけ、行の吹き出しと右クリックの案内を出す

import { useEffect, useRef, type MouseEvent } from "react";
import { AskComposer } from "./components/ask-composer.js";
import { AskHint, AskMenuProvider } from "./components/ask-menu.js";
import { useAsk, useHost, useUiState } from "./host.js";
import { useStore, type Store } from "./store.js";
import { hrefOf, isDetailRoute, parseRoute, toggleRoute, useRoute, type Route } from "./router.js";
import { BoardPage, boardIterationSelection } from "./pages/board.js";
import { BacklogPage } from "./pages/backlog.js";
import { TicketPage } from "./pages/ticket.js";
import { EpicsPage } from "./pages/epics.js";
import { IterationsPage } from "./pages/iterations.js";
import { HistoryPage } from "./pages/history.js";
import { RunsPage } from "./pages/runs.js";
import { ConfigPage } from "./pages/config.js";

const NAV: { page: Route["page"]; label: string }[] = [
  { page: "board", label: "カンバン" },
  { page: "backlog", label: "バックログ" },
  { page: "history", label: "履歴" },
  { page: "runs", label: "Run" },
];
/** 左パネルのタブ。Run の画面はブラウザだけに置く（UI-12） */
const SIDEBAR_NAV = NAV.filter((n) => n.page !== "runs");

/** タブの行き先を最後に見たハッシュにする画面。バックログは絞り込みをハッシュに持たないので固定 */
type LastHashPage = "board" | "history" | "runs";

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
  if (route.page === "runs" && route.iteration)
    return store.iterations.some((i) => i.id === route.iteration && i.status !== "closed");
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
  // カンバン・履歴・Run のタブは最後に見たハッシュ（絞り込み・見方・検索語）を指し、他のタブから戻ったときに残す
  const lastHref: Partial<Record<Route["page"], string>> = {
    board: useLastHref("board", route, store),
    history: useLastHref("history", route, store),
    runs: useLastHref("runs", route, store),
  };
  const shown = sidebarRoute(route, sidebar);
  // Iteration の詳細はカンバンのタブ、Epic の詳細はバックログのタブの下にあるものとして扱う（一覧の画面はない）
  const active =
    shown.page === "ticket" || shown.page === "epics"
      ? "backlog"
      : shown.page === "iterations"
        ? "board"
        : shown.page;
  // エディタのパネルは詳細（チケット・Iteration・Epic）だけを出し、1 枚で完結するので、タブ・Project・同期のヘッダーを出さない（UI-12）
  const panel = host.surface === "panel";
  return (
    <div
      className="app"
      data-surface={host.surface}
      onClick={(e) => followHashLink(e, panel ? host.show : undefined)}
    >
      {panel ? null : (
        <header className="topbar">
          {sidebar ? null : <strong className="brand">deguboard</strong>}
          <nav aria-label="画面">
            {(sidebar ? SIDEBAR_NAV : NAV).map((n) => (
              <a
                key={n.page}
                href={lastHref[n.page] ?? hrefOf({ page: n.page } as Route)}
                className={active === n.page ? "active" : ""}
                aria-current={active === n.page ? "page" : undefined}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="spacer" />
          {/* サイドバーでは Project が 1 つなら切り替えの段を出さない（幅を節約する。hidden 属性は .project-select の display に負けるので描かない） */}
          {sidebar && store.projects.length <= 1 ? null : (
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
                    {p.status === "archived" ? "（アーカイブ）" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sidebar ? null : <SyncIndicator />}
          {/* 左パネルの吹き出しはビューのタイトル行にある（拡張の view/title）。ブラウザはここに置き、対象なしで開け閉めする */}
          {sidebar ? null : (
            <button
              type="button"
              className={`ask-toggle${ask.request ? " active" : ""}`}
              aria-label="エージェントに頼む"
              aria-pressed={ask.request !== null}
              title="エージェントに頼む（依頼文を作ってコピーする）"
              onClick={() => (ask.request ? ask.close() : ask.open([]))}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
                <path d="M5.5 7h5" />
              </svg>
            </button>
          )}
          {/* 左パネルの歯車はビューのタイトル行にある（拡張の view/title）。ブラウザはここに置く */}
          {sidebar ? null : (
            <button
              type="button"
              className={`config-toggle${route.page === "config" ? " active" : ""}`}
              aria-label="設定"
              aria-pressed={route.page === "config"}
              title="設定（config.yaml）"
              onClick={() => toggleRoute(hrefOf({ page: "config" }))}
            >
              ⚙
            </button>
          )}
        </header>
      )}
      <NoticeBar />
      <main className="page">
        {/* 最初の読み込みが終わるまでは空状態の文言を出さない。読み直しの間は画面を出したままにする（フォームの入力を失わない） */}
        {!store.loaded ? (
          <>
            <p className="muted">読み込み中…</p>
            {/* Webview では前回の一覧がないときだけここに来る。文字だけにせず、節と行の骨組みを出す */}
            {host.surface === "browser" ? null : <LoadingSkeleton />}
          </>
        ) : (
          // サイドバーではチケット詳細を出さない（エディタ領域のパネルに開く）。Run の画面もなく、カンバンを出す（UI-12）。
          // 行・見出しの吹き出しと右クリックの候補は、出ている場所の分を AskMenuProvider がまとめて引く（UI-15）
          <AskMenuProvider>
            {/* 案内は頼める場所のある画面（カンバン・バックログ・履歴）にだけ出す */}
            {sidebar && ASK_HINT_PAGES.has(shown.page) ? <AskHint /> : null}
            <Page route={shown} />
          </AskMenuProvider>
        )}
      </main>
      {/* 開き直したら（対象が替わったら）中の状態を捨てる。指示の下書きと形式は見た目の状態に残る */}
      {ask.request && store.loaded ? (
        <AskComposer
          key={ask.serial}
          targets={ask.request.targets}
          action={ask.request.action}
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
 * TicketLink（サイドバー）やドラッグ直後のように先に preventDefault されたもの、修飾キーつきのクリックには触らない
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

/** サイドバーで出す画面。チケット詳細はバックログに、Run の画面（前の版で残ったハッシュから来る）はカンバンに替える */
function sidebarRoute(route: Route, sidebar: boolean): Route {
  if (!sidebar) return route;
  if (route.page === "ticket") return { page: "backlog" };
  if (route.page === "runs") return { page: "board" };
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
    case "history":
      return <HistoryPage route={route} />;
    case "runs":
      return <RunsPage by={route.by} iteration={route.iteration} />;
    case "config":
      return <ConfigPage />;
  }
}

/** 未 push・未取り込み・未コミットの印と、dg sync と同じ同期のボタン（UI-6）。ブラウザとパネルだけ */
function SyncIndicator() {
  const store = useStore();
  const s = store.status;
  const marks: string[] = [];
  if (s?.dirty) marks.push("未コミットの変更");
  if (s && s.ahead > 0) marks.push(`未 push ${s.ahead}`);
  if (s && s.behind > 0) marks.push(`未取り込み ${s.behind}`);
  if (s && s.issues > 0) marks.push(`読めないファイル ${s.issues}`);
  return (
    <div className="sync" title={s ? `リモート: ${s.remote ?? "なし"}` : "同期の状態は未取得"}>
      {marks.length > 0 ? (
        marks.map((m) => (
          <span key={m} className="badge warn">
            {m}
          </span>
        ))
      ) : (
        <span className="badge ok">同期済み</span>
      )}
      <button
        type="button"
        onClick={() => void store.run("sync")}
        disabled={store.loading}
        title={
          s?.remote
            ? "リモートを取り込み、未 push を送り、ブランチの事実で状態を進める"
            : "リモートがないので、ブランチの事実で状態を進めて読み直すだけ"
        }
      >
        同期
      </button>
    </div>
  );
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
      <button type="button" onClick={() => store.notify(null)} aria-label="閉じる">
        ×
      </button>
    </div>
  );
}
