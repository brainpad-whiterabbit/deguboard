// 静的ファイルの配信（web のビルド結果）。SPA なので見つからないパスは index.html を返す

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** root の下のファイルを返す。root の外に出るパスは拒否する。返せたら true */
export async function serveStatic(
  root: string,
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const target = path.resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root))
    return false;
  const file = (await isFile(target))
    ? target
    : (await isFile(path.join(root, "index.html")))
      ? path.join(root, "index.html")
      : undefined;
  if (!file) return false;
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("error", reject).on("end", resolve).pipe(res);
  });
  return true;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 本文が上限を超えた。受け手（app.ts）が 413 の応答を書き終えてから残りの本文を始末する */
export class BodyTooLargeError extends Error {
  constructor() {
    super("The request body is too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * 要求の本文を読む。上限を超えたら読むのをやめて止めた（pause した）まま BodyTooLargeError で断る。
 * 呼ぶ側は BodyTooLargeError を受けたら、応答を書いた後に残りの本文を読み捨てるか接続を閉じること
 * （どちらもしないと、止めた要求の接続が開いたまま残る）
 */
export function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // ここで req を壊すと、エラーの応答を書く前に接続が切れてクライアントに届かない。
        // 読むのをやめるだけにし、残りの始末は応答を書き終えた後の呼ぶ側に任せる
        req.off("data", onData);
        req.pause();
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
