// シェルに渡す 1 行の引数を囲む、core と cli・vscode でただ 1 つの処理。git が sh で動かすマージドライバの行（git/merge.ts）、
// チェックリストが見せて流す dg init の 1 行（commands/setup-check.ts）、VS Code 拡張がターミナルに入れる 1 行（packages/vscode/src/terminals.ts）が使う。
// web は core の実行時のコードを取り込めないので、packages/web/src/components/setup-checklist.tsx の initCommandLine の中に写しを置く。
// 変えるときは写しも直す（ずれは setup-checklist.test.tsx が core の initCommandLine と照らして見る）

/**
 * シェルにそのまま渡せない文字を含む値だけを単一引用符で囲む（' は '\'' でつなぐ。sh・bash・zsh・fish で同じに読める）。
 * 先頭の = も囲む：zsh（macOS の既定）の EQUALS が =cmd をコマンドのパスに展開する。空の値は '' にする
 */
export function shellQuote(value: string): string {
  return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
