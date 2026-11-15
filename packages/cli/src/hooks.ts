// dg hooks install / uninstall / check の、入口の事実だけを受け持つ。判定と書き込みは core の commands/hook-settings.ts にあり、
// program.ts が引数と結果を写す（ADR-033）。ここが渡すのは、core からは引けない「いま動いている node と dg の起動ファイルの場所」だけ

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleLayout } from "@deguboard/core";

/**
 * このプロセスを動かしている dg を呼ぶ語の並び：node と、dg の起動ファイル（bin/dg.js。束ねた CLI では dg.mjs）の実パス。
 * リンク（~/.local/bin/dg など）は辿る。core の installHooks が、追跡しない設定に書く既定の命令に使う
 */
export function selfCommand(): string[] {
  return [
    process.execPath,
    realpathSync(bundleLayout()?.entry ?? fileURLToPath(new URL("../bin/dg.js", import.meta.url))),
  ];
}
