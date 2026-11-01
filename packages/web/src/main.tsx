import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createHttpClient } from "./client/http.js";
import { createWebviewClient } from "./client/webview.js";
import { createHost, HostBridge, HostProvider, readSurface } from "./host.js";
import { StoreProvider } from "./store.js";
import { createUiState } from "./ui-state.js";
import "./styles.css";

// VS Code の Webview に載っているときは postMessage で拡張ホストと話し、ブラウザでは dg serve の HTTP を呼ぶ（ADR-006）。
// 拡張ホストは <html> の data 属性で、どこに載っているか（surface）と最初に出す画面（route）を渡す（UI-12）
const dataset = document.documentElement.dataset;
// acquireVsCodeApi は 1 回しか呼べないので、postMessage と getState / setState の両方をここから配る
const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
// ブラウザでは開発用の ?surface= も読む（Webview の URL は拡張ホストのものなので見ない）
const surface = readSurface(dataset, vscodeApi ? "" : window.location.search);
if (!window.location.hash && dataset.route) window.location.hash = dataset.route;
const webviewClient = vscodeApi ? createWebviewClient(vscodeApi) : null;
const client = webviewClient ?? createHttpClient();
const uiState = vscodeApi ? createUiState(vscodeApi) : undefined;
const host = createHost(surface, webviewClient, uiState);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Webview では前回の一覧を getState に残し、次に開いたときすぐ描く（ブラウザでは残さない） */}
    {/* 実行中の Run は左パネルのカンバンの行の印にだけ使うので、左パネルのときだけ読む */}
    <StoreProvider client={client} cache={uiState} readRunning={surface === "sidebar"}>
      <HostProvider host={host}>
        {webviewClient ? <HostBridge client={webviewClient} /> : null}
        <App />
      </HostProvider>
    </StoreProvider>
  </StrictMode>,
);
