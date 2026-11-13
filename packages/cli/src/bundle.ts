// VS Code 拡張に同梱する dg（dist/cli/dg.mjs）の入口。ここには入口だけを置き、本体（bundle-main.ts）は隣の chunk に束ねる
// （packages/vscode/vite.cli.config.ts）。コンパイルキャッシュを有効にしてから PreToolUse と Stop の速い経路（t769・t786）を試し、受け持たない入力を
// 読んだ標準入力を添えて本体に回す流れは、bin/dg.js と共通の run-entry.mjs に置き、dg.mjs に束ねる（t767・t788）。
// キャッシュは有効にした後に読むモジュールにだけ効くので、本体を同じファイルに束ねると効かない。
// 速い経路は本体と分けた小さな chunk（dg-fast-*.mjs）で、本体の chunk は読まない。
// この入口は Node の版を確かめない。起動するのは起動ファイルだけで、起動ファイルは 24 以上の node で起動する
// （bin/dg.js の t782 の注釈）。拡張のコードはこのファイルを読み込まない（ADR-033）
// 読めないときの今の経路への回し（bin/dg.js の t777）はここには置かない。同梱の chunk は 1 回のビルドで dg.mjs と同じ
// ディレクトリに揃い、VSIX に丸ごと入る（vsix-files.test.ts が確かめる）。一部だけ消えた状態は起きず、本体の chunk も
// 同じディレクトリにあるので、回した先も読めない。直すのは再インストールか mise run build

import { fileURLToPath } from "node:url";
import { runEntry } from "../bin/run-entry.mjs";

process.exitCode = await runEntry(process.argv.slice(2), {
  loadFastHook: async () => (await import("./fast-hook.js")).tryFastHook,
  runMain: async (opts) =>
    (await import("./bundle-main.js")).runBundled(fileURLToPath(import.meta.url), opts),
});
