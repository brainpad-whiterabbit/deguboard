// 起動ファイル（VS Code 拡張が ~/.local/share/deguboard/dg に置く sh。packages/vscode/src/launcher.ts）から呼ばれた dg の、起動ファイルの絶対パス。
// 起動ファイルが DEGUBOARD_LAUNCHER に付けて node を起こすので、dg はそれを読む。フックとマージドライバは node と dg.mjs の代わりにこれを書く（t735）。
// 起動ファイルの外（clone の dg・npm の dg）では付かないので、今までどおり node と dg.js の絶対パスを書く。

/** 起動ファイルが渡す環境変数の名前（launcher.ts の中身と揃える） */
export const LAUNCHER_ENV = "DEGUBOARD_LAUNCHER";

/** 起動ファイル経由で動いていれば、その絶対パス。そうでなければ undefined */
export function launcherFrom(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[LAUNCHER_ENV];
  return value !== undefined && value.startsWith("/") ? value : undefined;
}
