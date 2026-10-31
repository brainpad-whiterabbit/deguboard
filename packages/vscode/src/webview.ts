// Webview に web を載せる部分のうち、VS Code の API に触れない純粋な処理。extension.ts から呼ぶ

import {
  toCommandFailure,
  type CommandClient,
  type WebviewRequest,
  type WebviewResponse,
} from "@deguboard/core";

export interface HtmlOptions {
  /** web の dist の相対パス（./assets/index.js）を Webview の URI にする */
  asset(relativePath: string): string;
  /** webview.cspSource */
  cspSource: string;
  nonce: string;
}

/**
 * Vite が出した index.html（base: "./"）を Webview 向けに直す：
 * 相対パスを Webview の URI に、crossorigin を外し、nonce つきの CSP を入れる
 */
export function renderWebviewHtml(indexHtml: string, options: HtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${options.nonce}'`,
    `font-src ${options.cspSource}`,
    `img-src ${options.cspSource} data:`,
  ].join("; ");
  return indexHtml
    .replace(/\s+crossorigin(?=[\s>])/g, "")
    .replace(
      /(src|href)="\.\/([^"]+)"/g,
      (_, attr: string, p: string) => `${attr}="${options.asset(p)}"`,
    )
    .replace(/<script\b/g, `<script nonce="${options.nonce}"`)
    .replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    );
}

/** Webview からの要求を CommandClient に通し、同じ id の応答にする。失敗は ok: false で返す */
export async function handleRequest(
  client: CommandClient,
  request: WebviewRequest,
): Promise<WebviewResponse> {
  try {
    if (request.kind === "status") {
      return { id: request.id, ok: true, data: await client.status(), warnings: [], write: null };
    }
    const result = await client.run(request.name, request.input);
    return {
      id: request.id,
      ok: true,
      data: result.data,
      warnings: result.warnings,
      write: result.write ?? null,
    };
  } catch (error) {
    return { id: request.id, ok: false, error: toCommandFailure(error) };
  }
}

export function isWebviewRequest(value: unknown): value is WebviewRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<WebviewRequest>;
  return (
    typeof v.id === "number" &&
    (v.kind === "status" || (v.kind === "run" && typeof v.name === "string"))
  );
}
