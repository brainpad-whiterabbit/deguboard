// 画面の切り替えは URL のハッシュで行う（#/board、#/tickets/t12）。Webview の URL は固定でパスの遷移ができないため、ルーターのライブラリは入れない。
// Webview は <a href="#…"> のクリックを横取りしてハッシュを変えないので、リンクのクリックは App が受けてハッシュを書く（app.tsx の followHashLink）

import { useEffect, useState } from "react";
import { METRIC_UNITS, type MetricUnit } from "./types.js";

/** カンバンの絞り込み。iteration は選んだ Iteration の ID か、Iteration に入っていないチケット（NO_ITERATION）。省けば既定（active） */
export interface BoardQuery {
  iteration?: string | undefined;
  epic?: string | undefined;
  assignee?: string | undefined;
}

/** 履歴の見方。省けば Iteration */
export type HistoryView = "iteration" | "epic" | "ticket";

/** 履歴の結果の絞り込み（チケットの見方）。省けばすべて */
export type HistoryResult = "done" | "abandoned";

/** 履歴の見方・検索語・結果の絞り込み。タブを移って戻っても残すためハッシュに持つ（開いた行は持たない） */
export interface HistoryQuery {
  view?: HistoryView | undefined;
  q?: string | undefined;
  result?: HistoryResult | undefined;
}

/** Run の画面の集計の単位と絞り込み。by は省けばチケットごと、iteration は省けば絞らない（履歴の Iteration の行から絞って開く） */
export interface RunsQuery {
  by?: MetricUnit | undefined;
  iteration?: string | undefined;
}

/** Run の画面の集計の単位。省けばチケットごと */
export const DEFAULT_UNIT: MetricUnit = "ticket";

/** カンバンで「Iteration に入っていないチケット」を選ぶ値 */
export const NO_ITERATION = "-";

export type Route =
  | ({ page: "board" } & BoardQuery)
  | { page: "backlog" }
  | { page: "ticket"; id: string }
  | { page: "epics"; id: string }
  | { page: "iterations"; id: string }
  | ({ page: "history" } & HistoryQuery)
  | ({ page: "runs" } & RunsQuery)
  | { page: "config" };

const BOARD_KEYS = [
  "iteration",
  "epic",
  "assignee",
] as const satisfies readonly (keyof BoardQuery)[];

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const [head, id] = path.split("/").filter(Boolean);
  const board = (): Route => {
    const route: Route = { page: "board" };
    for (const key of BOARD_KEYS) {
      const value = params.get(key);
      if (value) route[key] = value;
    }
    return route;
  };
  switch (head) {
    case "backlog":
      return { page: "backlog" };
    case "tickets":
      return id ? { page: "ticket", id } : { page: "backlog" };
    case "epics":
      // Epic の一覧の画面はない（open はバックログの欄、closed は履歴）。ID がなければバックログ
      return id ? { page: "epics", id } : { page: "backlog" };
    case "history": {
      const route: Route = { page: "history" };
      const view = params.get("view");
      if (view === "epic" || view === "ticket") route.view = view;
      const q = params.get("q");
      if (q) route.q = q;
      const result = params.get("result");
      if (result === "done" || result === "abandoned") route.result = result;
      return route;
    }
    case "runs": {
      const route: Route = { page: "runs" };
      const by = params.get("by");
      if (by && by !== DEFAULT_UNIT && (METRIC_UNITS as readonly string[]).includes(by))
        route.by = by as MetricUnit;
      const iteration = params.get("iteration");
      if (iteration) route.iteration = iteration;
      return route;
    }
    case "config":
      return { page: "config" };
    case "iterations":
      // Iteration の一覧の画面はない（planned・active はカンバンの絞り込み、closed は履歴）。ID がなければカンバン
      return id ? { page: "iterations", id } : board();
    default:
      return board();
  }
}

export function hrefOf(route: Route): string {
  switch (route.page) {
    case "board": {
      const params = new URLSearchParams();
      for (const key of BOARD_KEYS) if (route[key]) params.set(key, route[key]);
      const query = params.toString();
      return query ? `#/board?${query}` : "#/board";
    }
    case "backlog":
      return "#/backlog";
    case "ticket":
      return `#/tickets/${route.id}`;
    case "epics":
      return `#/epics/${route.id}`;
    case "iterations":
      return `#/iterations/${route.id}`;
    case "history": {
      const params = new URLSearchParams();
      if (route.view && route.view !== "iteration") params.set("view", route.view);
      if (route.q) params.set("q", route.q);
      if (route.result) params.set("result", route.result);
      const query = params.toString();
      return query ? `#/history?${query}` : "#/history";
    }
    case "runs": {
      const params = new URLSearchParams();
      if (route.by && route.by !== DEFAULT_UNIT) params.set("by", route.by);
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return query ? `#/runs?${query}` : "#/runs";
    }
    case "config":
      return "#/config";
  }
}

/** 詳細の画面（チケット・Epic・Iteration）か。エディタのパネルはこれだけを出す（UI-12） */
export function isDetailRoute(route: Route): boolean {
  return route.page === "ticket" || route.page === "epics" || route.page === "iterations";
}

export function navigate(route: Route): void {
  window.location.hash = hrefOf(route);
}

/**
 * 今の画面の履歴を書き換えて移る（検索欄の 1 文字ごとに戻る履歴を積まない）。replaceState は hashchange を出さないので、
 * useRoute が読み直すよう自分で出す
 */
export function replaceRoute(route: Route): void {
  const href = hrefOf(route);
  if (window.location.hash === href) return;
  window.history.replaceState(window.history.state, "", href);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** toggleRoute で離れた画面。もう一度押したときに戻る先 */
let toggledFrom: string | null = null;

/**
 * 画面を切り替える（左パネルの歯車・ブラウザの歯車）。今その画面なら、来る前の画面（なければカンバン）に戻り、
 * そうでなければ今の画面を覚えてその画面に移る
 */
export function toggleRoute(hash: string): void {
  const current = window.location.hash;
  if (parseRoute(current).page === parseRoute(hash).page) {
    const back =
      toggledFrom && parseRoute(toggledFrom).page !== parseRoute(hash).page ? toggledFrom : null;
    toggledFrom = null;
    window.location.hash = back ?? hrefOf({ page: "board" });
  } else {
    toggledFrom = current || null;
    window.location.hash = hash;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
