// シェルに渡す 1 行の引数を囲む、ただ 1 つの処理。git が sh で動かすマージドライバの行（git/merge.ts）、
// チェックリストが見せて流す dg init の 1 行（commands/setup-check.ts）、VS Code 拡張がターミナルに入れる 1 行（packages/vscode/src/terminals.ts）が使う

/**
 * シェルにそのまま渡せない文字を含む値だけを単一引用符で囲む（' は '\'' でつなぐ。sh・bash・zsh・fish で同じに読める）。
 * 先頭の = も囲む：zsh（macOS の既定）の EQUALS が =cmd をコマンドのパスに展開する。空の値は '' にする
 */
export function shellQuote(value: string): string {
  return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
