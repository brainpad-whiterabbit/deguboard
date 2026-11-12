// VS Code 拡張に同梱する dg（dist/cli/dg.mjs）の入口。ここには入口だけを置き、本体（bundle-main.ts）は隣の chunk に束ねる
// （packages/vscode/vite.cli.config.ts）。dg は呼び出しのたびに起動する（フックは使うたびに呼ばれる）ので、本体を読む前に
// Node のコンパイルキャッシュ（既定は一時ディレクトリの下）を有効にして、2 回目以降の起動で本体のコンパイルを省く（t767）。
// キャッシュは有効にした後に読むモジュールにだけ効くので、本体を同じファイルに束ねると効かない。bin/dg.js と同じく、
// 使えない Node（22.1 より前）や置き場所に書けないときは黙って飛ばす。拡張のコードはこのファイルを読み込まない（ADR-033）

import module from "node:module";
import { fileURLToPath } from "node:url";

try {
  module.enableCompileCache?.();
} catch {
  // キャッシュは速さのための任意の機能なので、失敗しても起動は続ける
}
const { runBundled } = await import("./bundle-main.js");
process.exitCode = await runBundled(fileURLToPath(import.meta.url));
