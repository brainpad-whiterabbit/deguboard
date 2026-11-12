// VS Code 拡張に同梱する dg（dist/cli/dg.mjs）の入口。packages/vscode/vite.cli.config.ts が core・server・cli と依存を
// この 1 つのファイルに束ねる（ネイティブのモジュールはないので、プラットフォームごとに分けない）。
// 束ねると import.meta.url はどのモジュールでも dg.mjs を指すので、引けない場所（guide・版・自分のパス）を最初に置く。
// Web の画面（../web）と skill.md（./skill.md）はビルドが同じ相対に置くので置かない。拡張のコードはこのファイルを読み込まない（ADR-033）

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setBundleLayout } from "@deguboard/core";
import { main } from "./main.js";

/** 束ねるときに cli の package.json の版で埋める */
declare const __DG_VERSION__: string;

const entry = fileURLToPath(import.meta.url);
setBundleLayout({ entry, guideDir: resolve(dirname(entry), ".."), version: __DG_VERSION__ });
process.exitCode = await main(process.argv.slice(2));
