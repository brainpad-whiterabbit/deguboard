// 画面の切り替えは URL のハッシュで行う（#/board、#/tickets/t12）。Webview の URL は固定でパスの遷移ができないため、ルーターのライブラリは入れない。
// Webview は <a href="#…"> のクリックを横取りしてハッシュを変えないので、リンクのクリックは App が受けてハッシュを書く（app.tsx の followHashLink）

import { useEffect, useState } from "react";

export type Route =
  | { page: "board"; epic?: string | undefined }
  | { page: "backlog" }
  | { page: "ticket"; id: string }
  | { page: "epics"; id?: string | undefined }
  | { page: "iterations"; id?: string | undefined };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const [head, id] = path.split("/").filter(Boolean);
  switch (head) {
    case "backlog":
      return { page: "backlog" };
    case "tickets":
      return id ? { page: "ticket", id } : { page: "backlog" };
    case "epics":
      return { page: "epics", id };
    case "iterations":
      return { page: "iterations", id };
    default:
      return { page: "board", epic: params.get("epic") ?? undefined };
  }
}

export function hrefOf(route: Route): string {
  switch (route.page) {
    case "board":
      return route.epic ? `#/board?epic=${encodeURIComponent(route.epic)}` : "#/board";
    case "backlog":
      return "#/backlog";
    case "ticket":
      return `#/tickets/${route.id}`;
    case "epics":
      return route.id ? `#/epics/${route.id}` : "#/epics";
    case "iterations":
      return route.id ? `#/iterations/${route.id}` : "#/iterations";
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
