// VS Code 拡張に同梱する dg（dist/cli/dg.mjs）の入口。ここには入口だけを置き、本体（bundle-main.ts）は隣の chunk に束ねる
// （packages/vscode/vite.cli.config.ts）。dg は呼び出しのたびに起動する（フックは使うたびに呼ばれる）ので、本体を読む前に
// Node のコンパイルキャッシュ（既定は一時ディレクトリの下）を有効にして、2 回目以降の起動で本体のコンパイルを省く（t767）。
// キャッシュは有効にした後に読むモジュールにだけ効くので、本体を同じファイルに束ねると効かない。bin/dg.js と同じく、
// 使えない Node や置き場所に書けないときは黙って飛ばす。この入口は Node の版を確かめない。起動するのは起動ファイルだけで、
// 起動ファイルは 24 以上の node で起動する（bin/dg.js の t782 の注釈）。拡張のコードはこのファイルを読み込まない（ADR-033）
// PreToolUse の速い経路（t769）も本体より前に処理する。bin/dg.js と同じ tryFastHook を呼び、受け持たない入力は
// 読んだ標準入力を添えて本体に回す。速い経路は本体と分けた小さな chunk（dg-fast-*.mjs）で、本体の chunk は読まない
// 読めないときの今の経路への回し（bin/dg.js の t777）はここには置かない。同梱の chunk は 1 回のビルドで dg.mjs と同じ
// ディレクトリに揃い、VSIX に丸ごと入る（vsix-files.test.ts が確かめる）。一部だけ消えた状態は起きず、本体の chunk も
// 同じディレクトリにあるので、回した先も読めない。直すのは再インストールか mise run build

import module from "node:module";
import { fileURLToPath } from "node:url";

try {
  module.enableCompileCache?.();
} catch {
  // キャッシュは速さのための任意の機能なので、失敗しても起動は続ける
}
const { tryFastHook } = await import("./fast-hook.js");
const fast = await tryFastHook(process.argv.slice(2));
if (fast.handled) {
  process.exitCode = fast.exitCode;
} else {
  const { runBundled } = await import("./bundle-main.js");
  process.exitCode = await runBundled(
    fileURLToPath(import.meta.url),
    fast.stdin === undefined ? {} : { stdinText: fast.stdin },
  );
}
