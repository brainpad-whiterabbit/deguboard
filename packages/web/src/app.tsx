// 画面の骨組み：上のバー（Project の切り替え・画面の切り替え・同期の印）と、ハッシュで選んだページ。
// サイドバーでは同期の印とボタン・設定の歯車を出さない（ビューのタイトル行の同期のボタンとバッジ・歯車で代える。UI-12）

import { useEffect, type MouseEvent } from "react";
import { useHost, useUiState } from "./host.js";
import { useStore } from "./store.js";
import { hrefOf, isDetailRoute, parseRoute, toggleRoute, useRoute, type Route } from "./router.js";
import { BoardPage } from "./pages/board.js";
import { BacklogPage } from "./pages/backlog.js";
import { TicketPage } from "./pages/ticket.js";
import { EpicsPage } from "./pages/epics.js";
import { IterationsPage } from "./pages/iterations.js";
import { HistoryPage } from "./pages/history.js";
import { RunsPage } from "./pages/runs.js";
import { ConfigPage } from "./pages/config.js";

const NAV: { page: Route["page"]; label: string; href: string }[] = [
  { page: "board", label: "カンバン", href: hrefOf({ page: "board" }) },
  { page: "backlog", label: "バックログ", href: hrefOf({ page: "backlog" }) },
  { page: "history", label: "履歴", href: hrefOf({ page: "history" }) },
  { page: "runs", label: "Run", href: hrefOf({ page: "runs" }) },
];

export function App() {
  const route = useRoute();
  const store = useStore();
  const host = useHost();
  const sidebar = host.surface === "sidebar";
  // 履歴のタブは最後に見た履歴のハッシュ（見方・検索語・結果の絞り込み）を指し、他のタブから戻ったときに残す
  const [historyHref, setHistoryHref] = useUiState("nav.history", hrefOf({ page: "history" }));
  const currentHistory = route.page === "history" ? hrefOf(route) : null;
  useEffect(() => {
    if (currentHistory !== null && currentHistory !== historyHref) setHistoryHref(currentHistory);
  }, [currentHistory, historyHref, setHistoryHref]);
  // Iteration の詳細はカンバンのタブ、Epic の詳細はバックログのタブの下にあるものとして扱う（一覧の画面はない）
  const active =
    route.page === "ticket" || route.page === "epics"
      ? "backlog"
      : route.page === "iterations"
        ? "board"
        : route.page;
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
            {NAV.map((n) => (
              <a
                key={n.page}
                href={n.page === "history" ? historyHref : n.href}
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
          // サイドバーではチケット詳細を出さない（エディタ領域のパネルに開く。UI-12）
          <Page route={sidebar && route.page === "ticket" ? { page: "backlog" } : route} />
        )}
      </main>
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

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "board":
      return <BoardPage query={route} />;
    case "backlog":
      return <BacklogPage />;
    case "ticket":
      return <TicketPage id={route.id} />;
    case "epics":
      return <EpicsPage id={route.id} />;
    case "iterations":
      return <IterationsPage id={route.id} />;
    case "history":
      return <HistoryPage route={route} />;
    case "runs":
      return <RunsPage by={route.by} />;
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
