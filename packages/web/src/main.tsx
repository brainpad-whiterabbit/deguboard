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
const surface = readSurface(dataset);
if (!window.location.hash && dataset.route) window.location.hash = dataset.route;

// acquireVsCodeApi は 1 回しか呼べないので、postMessage と getState / setState の両方をここから配る
const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
const webviewClient = vscodeApi ? createWebviewClient(vscodeApi) : null;
const client = webviewClient ?? createHttpClient();
const host = createHost(surface, webviewClient, vscodeApi ? createUiState(vscodeApi) : undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider client={client}>
      <HostProvider host={host}>
        {webviewClient ? <HostBridge client={webviewClient} /> : null}
        <App />
      </HostProvider>
    </StoreProvider>
  </StrictMode>,
);
