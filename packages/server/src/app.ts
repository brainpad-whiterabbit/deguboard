// core の commands を HTTP に写す（ADR-007）。ロジックはここに書かない。
//   GET  /api/commands            コマンドの一覧（名前・要約・入力の JSON Schema）
//   POST /api/commands/<name>     { input } を渡して CommandResult を返す
//   GET  /api/status              同期の状態（未 push・未取り込み・読めないファイル）
//   それ以外                        staticDir があれば静的ファイル（web）

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DeguboardError,
  commands as allCommands,
  findCommand,
  openContext,
  runCommand,
  syncStatus,
  type AnyCommand,
  type CommandContext,
  type CommandResult,
} from "@deguboard/core";
import { z } from "zod";
import { readBody, serveStatic } from "./static.js";

export interface AppOptions {
  /** 対象のリポジトリ */
  cwd: string;
  /** web のビルド結果。なければ API だけ */
  staticDir?: string | undefined;
  commands?: readonly AnyCommand[] | undefined;
  /** 主体の ID。省略時は git の user.name@ホスト名 */
  actorId?: string | undefined;
}

export interface CommandDescriptor {
  name: string;
  group: string;
  summary: string;
  write: boolean;
  positionals: readonly string[];
  input: unknown;
}

export function describeCommands(commands: readonly AnyCommand[]): CommandDescriptor[] {
  return commands
    .filter((c) => c.needs === "store")
    .map((c) => ({
      name: c.name,
      group: c.group,
      summary: c.summary,
      write: c.write,
      positionals: c.positionals ?? [],
      input: z.toJSONSchema(c.input, { io: "input" }),
    }));
}

function statusOf(error: DeguboardError): number {
  if (error.exitCode === 2) return 400;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "NOT_INITIALIZED") return 503;
  return 409;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * リクエストを 1 つずつ順に処理する（同じプロセスの中で Store の再走査と書き込みが重ならないように）。
 * 文脈は最初のリクエストで開き、以後はリクエストごとに再走査して他のプロセス（CLI）の変更を取り込む
 */
export function createApp(options: AppOptions): Handler {
  const commands = options.commands ?? allCommands;
  const descriptors = describeCommands(commands);
  let ctxPromise: Promise<CommandContext> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const context = async (): Promise<CommandContext> => {
    ctxPromise ??= openContext({
      cwd: options.cwd,
      // 画面からの操作は常に人（ADR-006）
      actor: { kind: "human", ...(options.actorId ? { id: options.actorId } : {}) },
    });
    try {
      const ctx = await ctxPromise;
      await ctx.store.rescan();
      ctx.config = ctx.store.config;
      return ctx;
    } catch (error) {
      ctxPromise = undefined;
      throw error;
    }
  };

  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/commands" && req.method === "GET") {
        json(res, 200, { ok: true, data: descriptors });
        return;
      }
      if (url.pathname.startsWith("/api/commands/") && req.method === "POST") {
        const name = decodeURIComponent(url.pathname.slice("/api/commands/".length));
        const def = findCommand(name);
        if (!def || def.needs !== "store") {
          json(res, 404, {
            ok: false,
            error: { code: "UNKNOWN_COMMAND", message: `コマンド ${name} はない` },
          });
          return;
        }
        const body = await readBody(req);
        let input: unknown = {};
        if (body.trim()) {
          try {
            input = (JSON.parse(body) as { input?: unknown }).input ?? {};
          } catch {
            json(res, 400, {
              ok: false,
              error: { code: "INVALID_JSON", message: "本文が JSON ではない" },
            });
            return;
          }
        }
        const result = await serialized(async () => runCommand(def, await context(), input));
        json(res, 200, toJson(result));
        return;
      }
      if (url.pathname === "/api/status" && req.method === "GET") {
        const data = await serialized(async () => {
          const ctx = await context();
          const status = await syncStatus(ctx.repo);
          return { ...status, issues: ctx.store.issues.length, data_dir: ctx.repo.dataDir };
        });
        json(res, 200, { ok: true, data });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json(res, 404, {
          ok: false,
          error: { code: "NOT_FOUND", message: `${url.pathname} はない` },
        });
        return;
      }
      if (
        options.staticDir &&
        req.method === "GET" &&
        (await serveStatic(options.staticDir, url.pathname, res))
      )
        return;
      res.writeHead(options.staticDir ? 404 : 200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        options.staticDir
          ? "見つからない"
          : "deguboard server。API は /api/commands。画面（web）はまだ配信していない\n",
      );
    } catch (error) {
      if (error instanceof DeguboardError) {
        json(res, statusOf(error), {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.detail ? { detail: error.detail } : {}),
          },
        });
        return;
      }
      json(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}

function toJson(result: CommandResult<unknown>) {
  return { ok: true, data: result.data, warnings: result.warnings, write: result.write ?? null };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
