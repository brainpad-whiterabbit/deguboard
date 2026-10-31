// 画面がどこに載っているか（surface）と、画面の外への働きかけを 1 つの文脈で持つ（UI-12）。
// ブラウザではチケットへのリンクはハッシュ遷移、サイドバーとパネルでは拡張ホストに頼む（パネルは自分の中で遷移し、題が変わる）。
// 拡張ホストからの通知（同期・遷移）は HostBridge が store とハッシュに結ぶ

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { WebviewClient } from "./client/webview.js";
import { navigate } from "./router.js";
import { useStore } from "./store.js";

export type Surface = "sidebar" | "panel" | "browser";

export interface Host {
  surface: Surface;
  /** チケット詳細を開く。Webview（sidebar・panel）では拡張ホストに頼み、ブラウザではハッシュ遷移 */
  openTicket(id: string): void;
}

const browserHost: Host = {
  surface: "browser",
  openTicket: (id) => navigate({ page: "ticket", id }),
};

const HostContext = createContext<Host>(browserHost);

/** <html data-surface> と拡張ホストとの接続から Host を作る。Webview でなければブラウザ */
export function createHost(surface: Surface, client: WebviewClient | null): Host {
  if (surface !== "browser" && client) {
    return { surface, openTicket: (id) => void client.openTicket(id) };
  }
  return { ...browserHost, surface };
}

export function readSurface(dataset: DOMStringMap): Surface {
  return dataset.surface === "sidebar" || dataset.surface === "panel" ? dataset.surface : "browser";
}

export function HostProvider({ host, children }: { host: Host; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): Host {
  return useContext(HostContext);
}

/** 拡張ホストからの通知を受ける。navigate はハッシュを書き換え、sync は store の同期を呼ぶ。StoreProvider の中に置く */
export function HostBridge({ client }: { client: WebviewClient }) {
  const store = useStore();
  const runRef = useRef(store.run);
  runRef.current = store.run;
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.name === "navigate") window.location.hash = event.hash;
        else if (event.name === "sync") void runRef.current("sync");
      }),
    [client],
  );
  return null;
}
