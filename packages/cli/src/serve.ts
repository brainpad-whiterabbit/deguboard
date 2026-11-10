// dg serve / dg open：開発用の HTTP サーバーの起動と、ブラウザで画面を開く（UI-8・ADR-027）。中身は @deguboard/server

import { execFile } from "node:child_process";
import { pickUser } from "@deguboard/core";
// サーバーの本体は dg serve を実行するときだけ読む（ほかのコマンド、とくにツールのたびに呼ばれる dg hook の起動を遅くしない。t554）
import { DEFAULT_HOST, DEFAULT_PORT } from "@deguboard/server/defaults";
import type { Command } from "commander";
import { toErrorView } from "./errors.js";
import { printError, printJsonError, type Streams } from "./output.js";

export interface ServeDeps {
  streams: Streams;
  resolveCwd: (c: string | undefined) => string;
  /** web のビルド結果。web パッケージができたら既定を入れる */
  staticDir?: string | undefined;
  /** マージドライバとして登録する、dg を呼ぶ argv の前置 */
  mergeDriver?: readonly string[] | undefined;
  /** DEGUBOARD_USER を読む環境変数。省けば process.env（program.ts の options.env と同じ） */
  env?: NodeJS.ProcessEnv | undefined;
  /** テスト用：ブラウザを開く代わりに呼ぶ */
  openUrl?: ((url: string) => Promise<void>) | undefined;
  /** テスト用：起動後に呼ばれ、戻ったらサーバーを閉じる */
  onListening?: ((url: string) => Promise<void>) | undefined;
}

/** OS の既定のブラウザで開く。Linux は xdg-open、macOS は open */
export async function openInBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    execFile(cmd, [url], (error) =>
      error ? reject(new Error(`${cmd} でブラウザを開けない: ${error.message}`)) : resolve(),
    );
  });
}

function toPort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("ポートは 0〜65535 の整数");
  return n;
}

export function addServeCommands(program: Command, deps: ServeDeps): void {
  program
    .command("serve")
    .description(
      `For development: starts the HTTP server that serves the screen and the API (used to check the layout of the left panel and panels, and for screenshots. The screen opens in the VS Code extension). Binds to ${DEFAULT_HOST}:${DEFAULT_PORT} by default and has no authentication. Choose the layout with ?surface=sidebar (default) or ?surface=panel`,
    )
    .option("--host <host>", "Address to bind to", DEFAULT_HOST)
    .option("--port <port>", "Port. 0 picks a free port", toPort, DEFAULT_PORT)
    .option("--open", "Open the browser after starting")
    .action(async (opts: { host: string; port: number; open?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string; user?: string }>();
      try {
        const { startServer } = await import("@deguboard/server");
        const running = await startServer({
          cwd: deps.resolveCwd(global.C),
          ...pickUser(global.user, (deps.env ?? process.env)["DEGUBOARD_USER"]),
          host: opts.host,
          port: opts.port,
          staticDir: deps.staticDir,
          mergeDriver: deps.mergeDriver,
        });
        if (global.json)
          deps.streams.out(
            JSON.stringify({
              ok: true,
              data: { url: running.url, host: running.host, port: running.port },
              warnings: [],
              write: null,
            }),
          );
        else deps.streams.out(`deguboard server: ${running.url}（Ctrl+C で止める）`);
        if (opts.open) await (deps.openUrl ?? openInBrowser)(running.url);
        if (deps.onListening) {
          await deps.onListening(running.url);
          await running.close();
          return;
        }
        await new Promise<void>((resolve) => {
          const stop = () => {
            running.close().finally(resolve);
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(deps.streams, view);
        else printError(deps.streams, view);
        process.exitCode = view.exitCode;
      }
    });

  program
    .command("open")
    .description(
      "For development: opens the screen of the running dg serve in the browser (the screen opens in the VS Code extension)",
    )
    .option("--host <host>", "Server address", DEFAULT_HOST)
    .option("--port <port>", "Server port", toPort, DEFAULT_PORT)
    .action(async (opts: { host: string; port: number }) => {
      const global = program.opts<{ json?: boolean }>();
      const url = `http://${opts.host}:${opts.port}/`;
      try {
        await (deps.openUrl ?? openInBrowser)(url);
        if (global.json)
          deps.streams.out(JSON.stringify({ ok: true, data: { url }, warnings: [], write: null }));
        else deps.streams.out(url);
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(deps.streams, view);
        else printError(deps.streams, view);
        process.exitCode = 1;
      }
    });
}
