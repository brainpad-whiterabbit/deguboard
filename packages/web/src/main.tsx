import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createHttpClient } from "./client/http.js";
import { parseAskKey } from "./ask-key.js";
import { createWebviewClient } from "./client/webview.js";
import { ASK_OPEN_KEY, createHost, HostBridge, HostProvider, readSurface } from "./host.js";
import { StoreProvider } from "./store.js";
import { createUiState } from "./ui-state.js";
import { languageOf, setLanguage } from "./l10n.js";
import "./styles.css";

// VS Code の Webview に載っているときは postMessage で拡張ホストと話し、Webview の外（開発用の dg serve）では HTTP を呼ぶ（ADR-006・ADR-023）。
// 拡張ホストは <html> の data 属性で、どこに載っているか（surface）と最初に出す画面（route）を渡す（UI-12）
const dataset = document.documentElement.dataset;
// 文言の言語は拡張ホストが data-language（vscode.env.language）で渡す。dg serve では付かないので日本語（t383。test:layout は付けて英語を確かめる）
setLanguage(languageOf(dataset.language));
document.documentElement.lang = languageOf(dataset.language);
// acquireVsCodeApi は 1 回しか呼べないので、postMessage と getState / setState の両方をここから配る
const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
// dg serve では ?surface= を読み、なければサイドバー（Webview の URL は拡張ホストのものなので見ない）
const surface = readSurface(dataset, vscodeApi ? "" : window.location.search);
if (!window.location.hash && dataset.route) window.location.hash = dataset.route;
const webviewClient = vscodeApi ? createWebviewClient(vscodeApi) : null;
const client = webviewClient ?? createHttpClient();
const uiState = vscodeApi ? createUiState(vscodeApi) : undefined;
const host = createHost(surface, webviewClient, uiState);
// 拡張ホストがサイドバーを作る前に「エージェントに頼む」を押されたときは、対象を data-ask（ask-key.ts の鍵の形）で渡してくる（UI-15）
if (dataset.ask !== undefined)
  host.state.set(ASK_OPEN_KEY, { targets: parseAskKey(dataset.ask).targets });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Webview では前回の一覧を getState に残し、次に開いたときすぐ描く（dg serve では残さない） */}
    {/* 実行中の Run は左パネルのカンバンの行の印にだけ使うので、左パネルのときだけ読む */}
    <StoreProvider client={client} cache={uiState} readRunning={surface === "sidebar"}>
      <HostProvider host={host}>
        {webviewClient ? <HostBridge client={webviewClient} /> : null}
        <App />
      </HostProvider>
    </StoreProvider>
  </StrictMode>,
);
