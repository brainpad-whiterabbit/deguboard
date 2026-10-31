// 画面の切り替えは URL のハッシュで行う（#/board、#/tickets/t12）。Webview の URL は固定でパスの遷移ができないため、ルーターのライブラリは入れない。
// Webview は <a href="#…"> のクリックを横取りしてハッシュを変えないので、リンクのクリックは App が受けてハッシュを書く（app.tsx の followHashLink）

import { useEffect, useState } from "react";

/** カンバンの絞り込み。iteration は選んだ Iteration の ID か、Iteration に入っていないチケット（NO_ITERATION）。省けば既定（active） */
export interface BoardQuery {
  iteration?: string | undefined;
  epic?: string | undefined;
  assignee?: string | undefined;
}

/** カンバンで「Iteration に入っていないチケット」を選ぶ値 */
export const NO_ITERATION = "-";

export type Route =
  | ({ page: "board" } & BoardQuery)
  | { page: "backlog" }
  | { page: "ticket"; id: string }
  | { page: "epics"; id?: string | undefined }
  | { page: "iterations"; id: string };

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
      return { page: "epics", id };
    case "iterations":
      // Iteration の一覧の画面はない（planned・active はカンバンの表、closed は履歴）。ID がなければカンバン
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
      return route.id ? `#/epics/${route.id}` : "#/epics";
    case "iterations":
      return `#/iterations/${route.id}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefOf(route);
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
