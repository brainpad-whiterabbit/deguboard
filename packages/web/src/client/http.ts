// CommandClient の HTTP 実装。dg serve の /api/commands/<name>・/api/status・/api/setup を呼ぶ（ADR-027）

import type {
  CommandClient,
  CommandFailure,
  CommandResult,
  SetupBoardSource,
  SetupView,
  StatusView,
} from "@deguboard/core";
import { tr, trCoreMessage } from "../l10n.js";

/**
 * 入口が返した失敗。code は core のエラーコードか入口のコード（UNKNOWN_COMMAND など）。
 * message と detail は core の決まった文なら今の言語に訳す（trCoreMessage。表にない文は core の文のまま）
 */
export class ClientError extends Error implements CommandFailure {
  readonly code: string;
  readonly detail: string | undefined;
  constructor(failure: CommandFailure) {
    super(trCoreMessage(failure.message));
    this.name = "ClientError";
    this.code = failure.code;
    this.detail = failure.detail === undefined ? undefined : trCoreMessage(failure.detail);
  }
}

type Envelope<T> =
  | { ok: true; data: T; warnings?: string[]; write?: CommandResult<T>["write"] | null }
  | { ok: false; error: CommandFailure };

/**
 * 確かめるときに付けるもの。board は人がボードの項目で指定したデータの置き場所（dg init 前のボードをそこで確かめる）。
 * bandDismissed は Webview だけが拡張ホストに伝える（client/webview.ts）。board の null は人がコードのリモートに戻したことで、
 * 指定をフォルダごとに持つ拡張ホストにだけ意味がある（dg serve は指定を持たないので、付けないのと同じ）
 */
export interface SetupOptions {
  bandDismissed?: boolean | undefined;
  board?: SetupBoardSource | null | undefined;
}

/** 導入のチェックリスト（UI-12）を確かめ直して返す口を持つ CommandClient。dg serve と Webview の両方の実装が持つ */
export interface SetupClient extends CommandClient {
  setup(options?: SetupOptions): Promise<SetupView>;
}

export function createHttpClient(baseUrl = "", fetchImpl: typeof fetch = fetch): SetupClient {
  const call = async <T>(path: string, init?: RequestInit): Promise<Envelope<T>> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      throw new ClientError({
        code: "UNREACHABLE",
        message: tr("サーバーに届かない。dg serve が動いているか確かめる"),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      throw new ClientError({
        code: "INVALID_RESPONSE",
        message: tr("応答が JSON ではない（{0}）", res.status),
      });
    }
    if (!body.ok) throw new ClientError(body.error);
    return body;
  };
  return {
    async run<O>(name: string, input: unknown = {}): Promise<CommandResult<O>> {
      const body = await call<O>(`/api/commands/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
      if (!body.ok) throw new ClientError(body.error);
      return {
        data: body.data,
        warnings: (body.warnings ?? []).map(trCoreMessage),
        write: body.write ?? undefined,
      };
    },
    async status(): Promise<StatusView> {
      const body = await call<StatusView>("/api/status");
      if (!body.ok) throw new ClientError(body.error);
      return body.data;
    },
    async setup(options): Promise<SetupView> {
      // データの置き場所は POST の JSON で渡す（dg serve は GET の問い合わせでは ls-remote しない。server/src/app.ts）
      const board = options?.board;
      const body = await call<SetupView>(
        "/api/setup",
        board
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                data_remote: board.dataRemote,
                data_branch: board.dataBranch,
              }),
            }
          : undefined,
      );
      if (!body.ok) throw new ClientError(body.error);
      return body.data;
    },
  };
}

export function failureOf(error: unknown): CommandFailure {
  if (error instanceof ClientError) return error;
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
