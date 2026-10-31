// CommandClient の postMessage 実装。VS Code の Webview から拡張ホストに要求を送り、id で応答を対応づける（ADR-006）。
// 要求と応答の形は core の WebviewRequest / WebviewResponse。拡張ホストからの通知（WebviewEvent）は id を持たず、購読者に配る

import type {
  CommandClient,
  CommandResult,
  StatusView,
  WebviewEvent,
  WebviewRequest,
  WebviewResponse,
} from "@deguboard/core";
import { ClientError } from "./http.js";

/** acquireVsCodeApi() が返すもののうち使う部分 */
export interface WebviewHost {
  postMessage(message: unknown): void;
}

/** 拡張ホストと話す CommandClient。画面の外への働きかけと、ホストからの通知の購読も持つ（UI-12） */
export interface WebviewClient extends CommandClient {
  /** チケット詳細をエディタ領域に開いてもらう */
  openTicket(ticket: string): Promise<void>;
  /** 拡張ホストからの通知を受ける。戻り値で購読を外す */
  onEvent(listener: (event: WebviewEvent) => void): () => void;
}

export function createWebviewClient(
  host: WebviewHost,
  target: Pick<Window, "addEventListener"> = window,
): WebviewClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (response: WebviewResponse & { ok: true }) => void; reject: (e: Error) => void }
  >();
  const listeners = new Set<(event: WebviewEvent) => void>();
  target.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (isWebviewEvent(message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    const response = message as Partial<WebviewResponse> | undefined;
    if (!response || typeof response.id !== "number") return;
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    if (response.ok === true) waiting.resolve(response as WebviewResponse & { ok: true });
    else if (response.ok === false) waiting.reject(new ClientError(response.error!));
  });

  const send = (request: Draft<WebviewRequest>) =>
    new Promise<WebviewResponse & { ok: true }>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      host.postMessage({ ...request, id } as WebviewRequest);
    });

  return {
    async run<O>(name: string, input: unknown = {}): Promise<CommandResult<O>> {
      const r = await send({ kind: "run", name, input });
      return { data: r.data as O, warnings: r.warnings, write: r.write ?? undefined };
    },
    async status(): Promise<StatusView> {
      return (await send({ kind: "status" })).data as StatusView;
    },
    async openTicket(ticket: string): Promise<void> {
      await send({ kind: "action", name: "openTicket", ticket });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** id を振る前の要求。union の各要素から id を外す（Omit は union を分配しない） */
type Draft<T> = T extends unknown ? Omit<T, "id"> : never;

function isWebviewEvent(value: unknown): value is WebviewEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<WebviewEvent>;
  return v.kind === "event" && (v.name === "reload" || v.name === "navigate");
}
