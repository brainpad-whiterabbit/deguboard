// 起動ファイル（VS Code 拡張が ~/.local/share/deguboard/dg に置く sh。packages/vscode/src/launcher.ts）から呼ばれた dg の、起動ファイルの絶対パス。
// 起動ファイルが DEGUBOARD_LAUNCHER に付けて node を起こすので、dg はそれを読む。フックとマージドライバは node と dg.mjs の代わりにこれを書く（t735）。
// 起動ファイルの外（clone の dg）では付かないので、今までどおり node と dg.js の絶対パスを書く。
// 環境変数は子プロセス（git とそのフック、そこから起きたスクリプト）にも引き継がれるので、起動ファイルが起こした束ねた dg だけが読む。
// 子で動く clone の dg は束ねていないので読まず、起動ファイルを書かない。

import { homedir } from "node:os";
import path from "node:path";
import { bundleLayout } from "@deguboard/core";

/** 起動ファイルが渡す環境変数の名前（launcher.ts の中身と揃える） */
export const LAUNCHER_ENV = "DEGUBOARD_LAUNCHER";

type Env = Readonly<Record<string, string | undefined>>;

/** 環境変数に入っている起動ファイルの絶対パス（束ねているかは問わない） */
function launcherIn(env: Env): string | undefined {
  const value = env[LAUNCHER_ENV];
  return value !== undefined && value.startsWith("/") ? value : undefined;
}

/**
 * 起動ファイル経由で動いている束ねた dg なら、その起動ファイルの絶対パス。そうでなければ undefined。
 * 束ねていない dg（clone）は、子から引き継いだ環境変数を読まない
 */
export function launcherFrom(env: Env): string | undefined {
  return bundleLayout() === undefined ? undefined : launcherIn(env);
}

/**
 * パスが起動ファイルか（環境変数の値、または VS Code 拡張が置く既定の場所）。
 * 起動ファイルがなくなったとき、拡張を開き直す案内に使う。束ねているかは問わない
 */
export function isLauncherPath(file: string, env: Env): boolean {
  return (
    file === launcherIn(env) || file === path.join(homedir(), ".local", "share", "deguboard", "dg")
  );
}
