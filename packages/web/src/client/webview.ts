// CommandClient の postMessage 実装。VS Code の Webview から拡張ホストに要求を送り、id で応答を対応づける（ADR-006）。
// 要求と応答の形は core の WebviewRequest / WebviewResponse

import type {
  CommandClient,
  CommandResult,
  StatusView,
  WebviewRequest,
  WebviewResponse,
} from "@deguboard/core";
import { ClientError } from "./http.js";

/** acquireVsCodeApi() が返すもののうち使う部分 */
export interface WebviewHost {
  postMessage(message: unknown): void;
}

export function createWebviewClient(
  host: WebviewHost,
  target: Pick<Window, "addEventListener"> = window,
): CommandClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (response: WebviewResponse & { ok: true }) => void; reject: (e: Error) => void }
  >();
  target.addEventListener("message", (event: MessageEvent<unknown>) => {
    const response = event.data as Partial<WebviewResponse> | undefined;
    if (!response || typeof response.id !== "number") return;
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    if (response.ok === true) waiting.resolve(response as WebviewResponse & { ok: true });
    else if (response.ok === false) waiting.reject(new ClientError(response.error!));
  });

  const send = (request: { kind: "run"; name: string; input: unknown } | { kind: "status" }) =>
    new Promise<WebviewResponse & { ok: true }>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      host.postMessage({ ...request, id } satisfies WebviewRequest);
    });

  return {
    async run<O>(name: string, input: unknown = {}): Promise<CommandResult<O>> {
      const r = await send({ kind: "run", name, input });
      return { data: r.data as O, warnings: r.warnings, write: r.write ?? undefined };
    },
    async status(): Promise<StatusView> {
      return (await send({ kind: "status" })).data as StatusView;
    },
  };
}
