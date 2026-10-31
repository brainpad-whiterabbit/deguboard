// 画面がどこに載っているか（surface）と、画面の外への働きかけを 1 つの文脈で持つ（UI-12）。
// ブラウザではチケットや Iteration の詳細へのリンクはハッシュ遷移、サイドバーとパネルでは拡張ホストに頼む（パネルは自分の中で遷移し、題が変わる）。
// 拡張ホストからの通知（再読み込み・遷移）は HostBridge が store とハッシュに結ぶ

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { WebviewClient } from "./client/webview.js";
import { hrefOf, navigate, type Route } from "./router.js";
import { useStore } from "./store.js";
import { createUiState, localStorageBackend, type UiState } from "./ui-state.js";

export type Surface = "sidebar" | "panel" | "browser";

export interface Host {
  surface: Surface;
  /** 詳細（チケット・Iteration）を開く。Webview（sidebar・panel）では拡張ホストに頼んでエディタ領域に、ブラウザではハッシュ遷移 */
  open(route: Route): void;
  /** 見た目の状態（開閉・最後に選んだもの）の置き場 */
  state: UiState;
}

const browserHost: Host = {
  surface: "browser",
  open: (route) => navigate(route),
  state: createUiState(localStorageBackend()),
};

const HostContext = createContext<Host>(browserHost);

/** <html data-surface> と拡張ホストとの接続から Host を作る。Webview でなければブラウザ */
export function createHost(surface: Surface, client: WebviewClient | null, state?: UiState): Host {
  if (surface !== "browser" && client) {
    return {
      surface,
      open: (route) => void client.open(hrefOf(route)),
      state: state ?? browserHost.state,
    };
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

/** 見た目の状態を 1 つ持つ。useState と同じ形で、書くたびに host.state に残す */
export function useUiState<T>(key: string, initial: T): [T, (value: T) => void] {
  const host = useHost();
  const [value, setValue] = useState<T>(() => host.state.get<T>(key) ?? initial);
  return [
    value,
    (next) => {
      setValue(next);
      host.state.set(key, next);
    },
  ];
}

/** 拡張ホストからの通知を受ける。navigate はハッシュを書き換え、reload は store を読み直す（同期は拡張ホストが済ませてから送ってくる）。StoreProvider の中に置く */
export function HostBridge({ client }: { client: WebviewClient }) {
  const store = useStore();
  const reloadRef = useRef(store.reload);
  reloadRef.current = store.reload;
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.name === "navigate") window.location.hash = event.hash;
        else if (event.name === "reload") void reloadRef.current();
      }),
    [client],
  );
  return null;
}
