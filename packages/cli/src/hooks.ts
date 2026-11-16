// フック（dg hooks install）とマージドライバ（init と sync）が書く「dg を起動するコマンド」の、入口の事実だけを受け持つ。
// 判定と書き込みは core にあり（commands/hook-settings.ts・git/merge.ts）、program.ts が引数と結果を写す（ADR-033）。
// ここが渡すのは、core からは引けない「いま動いている node と dg の起動ファイルの場所」だけ

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleLayout, launcherFrom } from "@deguboard/core";

/**
 * このプロセスを動かしている dg を呼ぶ語の並び：node と、dg の起動ファイル（bin/dg.js。束ねた CLI では dg.mjs）の実パス。
 * PATH に dg がなくても（npx・mise run・node_modules/.bin）動くよう絶対パスで指し、リンク（~/.local/bin/dg など）は辿る。
 * フックとマージドライバのどちらの命令も、node と起動ファイルはここで組む（core の installHooks には self として渡す）
 */
export function selfCommand(): string[] {
  const entry = bundleLayout()?.entry ?? fileURLToPath(new URL("../bin/dg.js", import.meta.url));
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    // 起動ファイルが消えていても（動いている間に worktree や npx のキャッシュを消した）dg を止めない。マージドライバは
    // どのコマンドでも起動のたびに組むので、辿れなければ辿る前のパスを書き、次の sync・install で直る
    real = entry;
  }
  return [process.execPath, real];
}

/**
 * git がマージドライバとして呼ぶ dg のコマンド（argv の前置）。selfCommand に merge-driver を足す。init と sync のたびに登録し直すので、
 * npx のキャッシュや worktree が消えてパスが古くなっても次の sync で直る。
 * 起動ファイル経由で動いていれば（env に DEGUBOARD_LAUNCHER があれば）、node と dg.mjs の代わりに起動ファイルを指す（t735。フックは core の installHooks が同じ判定をする）
 */
export function selfMergeDriver(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const launcher = launcherFrom(env);
  return [...(launcher !== undefined ? [launcher] : selfCommand()), "merge-driver"];
}
