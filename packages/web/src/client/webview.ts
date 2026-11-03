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
  /** 詳細のルート（#/tickets/t12 など）をエディタ領域のパネルに開いてもらう */
  open(route: string): Promise<void>;
  /** 一覧の画面のルート（#/board?epic=e2 など）をサイドバーのビューに出してもらう */
  show(route: string): Promise<void>;
  /** text をクリップボードに入れてもらう（拡張ホストが vscode.env.clipboard で書く。Webview の画面のコピーはすべてこれ） */
  copy(text: string): Promise<void>;
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
    async open(route: string): Promise<void> {
      await send({ kind: "action", name: "open", route });
    },
    async show(route: string): Promise<void> {
      await send({ kind: "action", name: "show", route });
    },
    async copy(text: string): Promise<void> {
      await send({ kind: "action", name: "copy", text });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** id を振る前の要求。union の各要素から id を外す（Omit は union を分配しない） */
type Draft<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * 拡張と合わせる値。core の WEBVIEW_CONTRACT の写し（web は core の実行時のコードを取り込まない）。
 * 同じ値であることを webview.test.ts で確かめる。画面のルートの写しは持たず、router の hrefOf が core の routes と同じハッシュを返すことを確かめる
 */
export const WEBVIEW_CONTRACT_COPY = {
  /** バックログの行の右クリックの文脈（data-vscode-context の webviewSection） */
  backlogRowSection: "backlogTicket",
  /** エージェントに頼む右クリックのサブメニューの文脈のキー（UI-15） */
  askContext: {
    targets: "askTargets",
    actions: "askActions",
    recommended: "askRecommended",
    within: "askWithin",
  },
  /** 頼める行・見出しの webviewSection */
  askSections: {
    boardTicket: "boardTicket",
    boardHeading: "boardHeading",
    backlogHeading: "backlogHeading",
    epicChip: "epicChip",
    historyRow: "historyRow",
    detailTitle: "detailTitle",
    detailTicket: "detailTicket",
  },
  /** 拡張ホスト → Webview の通知の名前。Record なので core の WebviewEvent の name が増えると型の検査で漏れが分かる */
  eventNames: { reload: true, navigate: true, toggle: true, ask: true } satisfies Record<
    WebviewEvent["name"],
    true
  >,
} as const;

function isWebviewEvent(value: unknown): value is WebviewEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<WebviewEvent>;
  return v.kind === "event" && !!v.name && Object.hasOwn(WEBVIEW_CONTRACT_COPY.eventNames, v.name);
}
