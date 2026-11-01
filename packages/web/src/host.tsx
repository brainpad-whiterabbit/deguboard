// 画面がどこに載っているか（surface）と、画面の外への働きかけを 1 つの文脈で持つ（UI-12）。
// ブラウザではチケットや Iteration の詳細へのリンクはハッシュ遷移、サイドバーとパネルでは拡張ホストに頼む（パネルは自分の中で遷移し、題が変わる）。
// パネルは詳細だけを出すので、パネルから一覧の画面へのリンクは拡張ホストに頼んでサイドバーに出す（show）。
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
  /** 一覧の画面（カンバンなど）を出す。パネルでは拡張ホストに頼んでサイドバーに、サイドバーとブラウザではハッシュ遷移 */
  show(route: Route): void;
  /** 見た目の状態（開閉・最後に選んだもの）の置き場 */
  state: UiState;
}

const browserHost: Host = {
  surface: "browser",
  open: (route) => navigate(route),
  show: (route) => navigate(route),
  state: createUiState(localStorageBackend()),
};

const HostContext = createContext<Host>(browserHost);

/** <html data-surface> と拡張ホストとの接続から Host を作る。Webview でなければブラウザ */
export function createHost(surface: Surface, client: WebviewClient | null, state?: UiState): Host {
  if (surface !== "browser" && client) {
    return {
      surface,
      open: (route) => void client.open(hrefOf(route)),
      show: (route) => (surface === "panel" ? void client.show(hrefOf(route)) : navigate(route)),
      state: state ?? browserHost.state,
    };
  }
  return { ...browserHost, surface };
}

/**
 * 載っている場所を読む。Webview では拡張ホストが付けた data 属性、ブラウザでは開発用に `?surface=sidebar` も読む
 * （dg serve の画面をサイドバーやパネルの配置で確かめるため。リンクはブラウザと同じくハッシュ遷移のまま）
 */
export function readSurface(dataset: DOMStringMap, search = ""): Surface {
  const value = dataset.surface ?? new URLSearchParams(search).get("surface");
  return value === "sidebar" || value === "panel" ? value : "browser";
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
