import type { CommandClient, CommandFailure, CommandResult, StatusView } from "@deguboard/core";
import { tr } from "../l10n.js";

/** 入口が返した失敗。code は core のエラーコードか入口のコード（UNKNOWN_COMMAND など） */
export class ClientError extends Error implements CommandFailure {
  readonly code: string;
  readonly detail: string | undefined;
  constructor(failure: CommandFailure) {
    super(failure.message);
    this.name = "ClientError";
    this.code = failure.code;
    this.detail = failure.detail;
  }
}

type Envelope<T> =
  | { ok: true; data: T; warnings?: string[]; write?: CommandResult<T>["write"] | null }
  | { ok: false; error: CommandFailure };

export function createHttpClient(baseUrl = "", fetchImpl: typeof fetch = fetch): CommandClient {
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
      return { data: body.data, warnings: body.warnings ?? [], write: body.write ?? undefined };
    },
    async status(): Promise<StatusView> {
      const body = await call<StatusView>("/api/status");
      if (!body.ok) throw new ClientError(body.error);
      return body.data;
    },
  };
}

export function failureOf(error: unknown): CommandFailure {
  if (error instanceof ClientError) return error;
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
