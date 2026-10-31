// dg serve / dg open：HTTP サーバーの起動と、ブラウザで画面を開く（UI-8）。中身は @deguboard/server

import { execFile } from "node:child_process";
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "@deguboard/server";
import type { Command } from "commander";
import { toErrorView } from "./errors.js";
import { printError, printJsonError, type Streams } from "./output.js";

export interface ServeDeps {
  streams: Streams;
  resolveCwd: (c: string | undefined) => string;
  /** web のビルド結果。web パッケージができたら既定を入れる */
  staticDir?: string | undefined;
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
      `画面と API を配信する HTTP サーバーを起動する。既定で ${DEFAULT_HOST}:${DEFAULT_PORT} に閉じ、認証は持たない`,
    )
    .option("--host <host>", "バインドするアドレス", DEFAULT_HOST)
    .option("--port <port>", "ポート。0 なら空いているポート", toPort, DEFAULT_PORT)
    .option("--open", "起動後にブラウザで開く")
    .action(async (opts: { host: string; port: number; open?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      try {
        const running = await startServer({
          cwd: deps.resolveCwd(global.C),
          host: opts.host,
          port: opts.port,
          staticDir: deps.staticDir,
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
    .description("起動中の dg serve の画面をブラウザで開く")
    .option("--host <host>", "サーバーのアドレス", DEFAULT_HOST)
    .option("--port <port>", "サーバーのポート", toPort, DEFAULT_PORT)
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
