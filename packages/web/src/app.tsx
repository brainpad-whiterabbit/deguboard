// 画面の骨組み：上のバー（Project の切り替え・画面の切り替え・同期の印）と、ハッシュで選んだページ

import type { MouseEvent } from "react";
import { useHost } from "./host.js";
import { useStore } from "./store.js";
import { hrefOf, useRoute, type Route } from "./router.js";
import { BoardPage } from "./pages/board.js";
import { BacklogPage } from "./pages/backlog.js";
import { TicketPage } from "./pages/ticket.js";
import { EpicsPage } from "./pages/epics.js";
import { IterationsPage } from "./pages/iterations.js";

const NAV: { page: Route["page"]; label: string; href: string }[] = [
  { page: "board", label: "カンバン", href: hrefOf({ page: "board" }) },
  { page: "backlog", label: "バックログ", href: hrefOf({ page: "backlog" }) },
  { page: "epics", label: "Epic", href: hrefOf({ page: "epics" }) },
  { page: "iterations", label: "Iteration", href: hrefOf({ page: "iterations" }) },
];

export function App() {
  const route = useRoute();
  const store = useStore();
  const host = useHost();
  const sidebar = host.surface === "sidebar";
  const active = route.page === "ticket" ? "backlog" : route.page;
  // エディタのパネルに出すチケット詳細は 1 枚で完結するので、タブ・Project・同期のヘッダーを出さない（UI-12）。
  // 「画面を開く」でカンバンをパネルに出したときはタブが要るので残す
  const detailPanel = host.surface === "panel" && route.page === "ticket";
  return (
    <div className="app" data-surface={host.surface} onClick={followHashLink}>
      {detailPanel ? null : (
        <header className="topbar">
          {sidebar ? null : <strong className="brand">deguboard</strong>}
          <nav aria-label="画面">
            {NAV.map((n) => (
              <a
                key={n.page}
                href={n.href}
                className={active === n.page ? "active" : ""}
                aria-current={active === n.page ? "page" : undefined}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="spacer" />
          {/* サイドバーでは Project が 1 つなら切り替えを出さない（幅を節約する） */}
          <label className="project-select" hidden={sidebar && store.projects.length <= 1}>
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
          <SyncIndicator />
        </header>
      )}
      <NoticeBar />
      <main className="page">
        {store.loading && store.tickets.length === 0 ? (
          <p className="muted">読み込み中…</p>
        ) : (
          // サイドバーではチケット詳細を出さない（エディタ領域のパネルに開く。UI-12）
          <Page route={sidebar && route.page === "ticket" ? { page: "backlog" } : route} />
        )}
      </main>
    </div>
  );
}

/**
 * ハッシュのリンク（#/backlog など）は、ここで受けて自分でハッシュを書く。
 * VS Code の Webview は <a> のクリックを横取りし、href がハッシュだけのリンクはページ内アンカーへのスクロールとみなして
 * preventDefault するので、ブラウザに任せるとハッシュが変わらない。React の onClick は document のハンドラより先に走る。
 * TicketLink（サイドバー）やドラッグ直後のように先に preventDefault されたもの、修飾キーつきのクリックには触らない
 */
function followHashLink(e: MouseEvent<HTMLElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  const anchor = (e.target as Element | null)?.closest?.("a[href^='#']");
  const href = anchor?.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  window.location.hash = href;
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "board":
      return <BoardPage epic={route.epic} />;
    case "backlog":
      return <BacklogPage />;
    case "ticket":
      return <TicketPage id={route.id} />;
    case "epics":
      return <EpicsPage id={route.id} />;
    case "iterations":
      return <IterationsPage id={route.id} />;
  }
}

/** 未 push・未取り込み・未コミットの印と、dg sync と同じ同期をする再読み込み（UI-6） */
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
        disabled={store.loading || !s?.remote}
        title={
          s?.remote
            ? "リモートを取り込み、未 push を送り、ブランチの事実で状態を進める"
            : "リモートがない"
        }
      >
        同期
      </button>
    </div>
  );
}

function NoticeBar() {
  const store = useStore();
  const n = store.notice;
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
