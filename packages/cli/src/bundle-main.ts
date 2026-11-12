// 同梱する dg の本体の chunk。入口（bundle.ts、束ねると dist/cli/dg.mjs）がコンパイルキャッシュを有効にしてから読む。
// packages/vscode/vite.cli.config.ts が core・server・cli と依存をこの chunk（と dg serve・dg mcp の chunk）に束ね、dg.mjs の隣に置く。
// 束ねると import.meta.url はどのモジュールでもその chunk を指すので、引けない場所（guide・版・自分のパス）を最初に置く。
// 自分のパス（フックとマージドライバが呼ぶ dg）は chunk ではなく入口の dg.mjs にする。
// Web の画面（../web）と skill.md（./skill.md）は chunk が dg.mjs と同じディレクトリにあるので、ビルドが置く相対のまま引ける

import { dirname, resolve } from "node:path";
import { setBundleLayout } from "@deguboard/core";
import { main } from "./main.js";

/** 束ねるときに cli の package.json の版で埋める */
declare const __DG_VERSION__: string;

/** entry は入口（dg.mjs）の絶対パス */
export async function runBundled(entry: string): Promise<number> {
  setBundleLayout({ entry, guideDir: resolve(dirname(entry), ".."), version: __DG_VERSION__ });
  return main(process.argv.slice(2));
}
