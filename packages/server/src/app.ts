// core の commands を HTTP に写す（ADR-033）。ロジックはここに書かない。
//   GET  /api/commands            コマンドの一覧（名前・要約・入力の JSON Schema）
//   POST /api/commands/<name>     { input } を渡して CommandResult を返す
//   GET  /api/status              同期の状態（未 push・未取り込み・読めないファイル）
//   それ以外                        staticDir があれば静的ファイル（web）
// どの要求も、先に guard で Host・Origin・Content-Type を見て、ブラウザを踏み台にした要求を断る（UI-8）

import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  ACTION_NAMES,
  DeguboardError,
  createLocalClient,
  type AnyCommand,
  type CommandResult,
  type UserSource,
} from "@deguboard/core";
import { z } from "zod";
import { readBody, serveStatic } from "./static.js";

export interface AppOptions {
  /** 対象のリポジトリ */
  cwd: string;
  /** web のビルド結果。なければ API だけ */
  staticDir?: string | undefined;
  commands?: readonly AnyCommand[] | undefined;
  /** 主体のユーザ名。省略時は git config の deguboard.user、git の user.name、OS のユーザ名の順 */
  user?: string | undefined;
  /** user の出どころ（flag か env）。省けば flag */
  userSource?: UserSource | undefined;
  /** マージドライバとして登録する、dg を呼ぶ argv の前置（dg serve が渡す） */
  mergeDriver?: readonly string[] | undefined;
  /** バインドする名前（dg serve の --host）。Host の名前として受け入れる */
  host?: string | undefined;
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
  if (error.code === "NOT_FOUND" || error.code === "UNKNOWN_COMMAND") return 404;
  if (error.code === "NOT_INITIALIZED") return 503;
  return 409;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface Rejection {
  status: number;
  code: string;
  message: string;
}

/** "localhost:4173"・"[::1]:4173" からポートを外し、小文字の名前にする。IPv6 は角括弧のまま */
function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end < 0 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(":");
  return colon < 0 ? lower : lower.slice(0, colon);
}

function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname) !== 0;
}

/**
 * 認証を持たないので、ブラウザを踏み台にした要求を断る（UI-8）。
 * - Host の名前：DNS rebinding では攻撃者の名前が来る。localhost・IP そのもの・--host の名前だけを通す。
 *   ポートは比べない（ポートを転送した先や vite の proxy からも開けるように）
 * - Origin：別オリジンのページからの要求（サンドボックスの Origin: null を含む）を断る。名前だけを比べる（同じ理由）
 * - Content-Type：application/json でない POST は、プリフライトなしで別オリジンから送れる形なので断る
 */
export function guard(req: IncomingMessage, boundHost: string | undefined): Rejection | undefined {
  const host = req.headers.host;
  const hostname = host ? hostnameOf(host) : "";
  // --host が IP なら IP そのものとして通るので、名前との比較だけでよい
  const bound = boundHost?.trim().toLowerCase();
  if (!hostname || !(hostname === "localhost" || isIpLiteral(hostname) || hostname === bound))
    return {
      status: 403,
      code: "FORBIDDEN_HOST",
      message: `Refused a request for the host name ${JSON.stringify(host ?? "")}. dg serve accepts only localhost, an IP address, or the name given with --host`,
    };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    // "null" は URL として読めないので、名前なしとして断る
    let originHostname: string | undefined;
    try {
      originHostname = new URL(origin).hostname.toLowerCase();
    } catch {
      originHostname = undefined;
    }
    if (originHostname !== hostname)
      return {
        status: 403,
        code: "FORBIDDEN_ORIGIN",
        message: `Refused a request from the origin ${JSON.stringify(origin)}. dg serve accepts only requests from its own origin`,
      };
  }
  if (req.method === "POST") {
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json")
      return {
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: `Refused a POST with the content type ${JSON.stringify(req.headers["content-type"] ?? "")}. Send application/json`,
      };
  }
  return undefined;
}

/** 文脈の管理（開く・再走査・直列化）は core の createLocalClient が持つ。ここは HTTP に写すだけ */
export function createApp(options: AppOptions): Handler {
  const client = createLocalClient({
    cwd: options.cwd,
    user: options.user,
    userSource: options.userSource,
    commands: options.commands,
    mergeDriver: options.mergeDriver,
    actions: ACTION_NAMES,
  });
  const descriptors = describeCommands(client.commands);

  return async (req, res) => {
    const rejected = guard(req, options.host);
    if (rejected) {
      json(res, rejected.status, {
        ok: false,
        error: { code: rejected.code, message: rejected.message },
      });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/commands" && req.method === "GET") {
        json(res, 200, { ok: true, data: descriptors });
        return;
      }
      if (url.pathname.startsWith("/api/commands/") && req.method === "POST") {
        const name = decodeURIComponent(url.pathname.slice("/api/commands/".length));
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
        json(res, 200, toJson(await client.run(name, input)));
        return;
      }
      if (url.pathname === "/api/status" && req.method === "GET") {
        json(res, 200, { ok: true, data: await client.status() });
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
