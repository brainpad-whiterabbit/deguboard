import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createHttpClient } from "./client/http.js";
import { createWebviewClient } from "./client/webview.js";
import { StoreProvider } from "./store.js";
import "./styles.css";

// VS Code の Webview に載っているときは postMessage で拡張ホストと話し、ブラウザでは dg serve の HTTP を呼ぶ（ADR-006）
const client =
  typeof acquireVsCodeApi === "function"
    ? createWebviewClient(acquireVsCodeApi())
    : createHttpClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider client={client}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
