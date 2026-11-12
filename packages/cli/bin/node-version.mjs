// bin/dg.js が、今の node の版で dg を動かしてよいかを確かめる（t782）。基準は Node 24 以上で、
// 拡張の起動ファイル（packages/vscode/src/launcher.ts）が PATH の node を選ぶ基準（24 以上）と同じ。
// 起動ファイルは current の node（拡張ホストの node。engines で 24 以上に決まる）を検査せずに使うが、
// ここは node の種類によらず、dg.js を動かしている node を見る（PATH の node・絶対パスの node・起動ファイルの node のどれでも）。
// 版が読めないときは止めない（判定できないものを理由に止めない）。
// 終了コードは、PreToolUse のフック（hook PreToolUse）だけ 2、ほかは 1 にする（nodeVersionExitCodeOf）。

export const REQUIRED_NODE_MAJOR = 24;

// 値を取るグローバルオプション（commander の定義は program.ts）。値は次の引数か、--name=値 で渡る
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["--actor", "--user", "-C"]);

/**
 * argv が PreToolUse のフック（`hook PreToolUse`。前に --json や --actor <x> などのグローバルオプションがあってよい）か。
 * 知らないオプションが前にあるときは、フックとは判定しない（終了コードは 1 のまま）
 */
export function isPreToolUseHookArgv(argv) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) {
    const arg = argv[i];
    if (arg === "--json") {
      i += 1;
    } else if (GLOBAL_OPTIONS_WITH_VALUE.has(arg) && i + 1 < argv.length) {
      i += 2;
    } else if ([...GLOBAL_OPTIONS_WITH_VALUE].some((o) => arg.startsWith(`${o}=`))) {
      i += 1;
    } else {
      return false;
    }
  }
  return argv[i] === "hook" && argv[i + 1] === "PreToolUse";
}

/**
 * 古い node で止めるときの終了コード。PreToolUse のフックは 2 にする。Claude Code は PreToolUse の終了コード 1 を
 * ツールを止めない誤りとして扱うので、1 だとフックの守りが黙って外れる。2 はツールの呼び出しを拒む。
 * ほかのコマンドは、dist が無いときと同じく 1
 */
export function nodeVersionExitCodeOf(argv) {
  return isPreToolUseHookArgv(argv) ? 2 : 1;
}

/**
 * 今の node が要る版より古いなら、直し方を英語で書いた文（末尾に改行）。動くなら undefined。
 * argv は dg に渡された引数（PreToolUse のフックのときは、止められたことを足す）
 */
export function nodeVersionProblemOf(version, argv = []) {
  const major = /^v?(\d+)\./.exec(String(version).trim())?.[1];
  if (major === undefined || Number(major) >= REQUIRED_NODE_MAJOR) return undefined;
  const lines = [
    `dg: needs Node.js ${REQUIRED_NODE_MAJOR} or later, but the node that started it is v${version}.`,
    "Run dg with Node 24 first on PATH. In the deguboard repository, `mise run dg -- <args>` uses the Node version in mise.toml. A hook written with an absolute node path keeps the old node until you run `dg hooks install` again.",
  ];
  if (isPreToolUseHookArgv(argv)) {
    lines.push(
      "This PreToolUse hook stops the tool call (exit 2) until dg runs on Node 24 or later, so the guard is not turned off silently.",
    );
  }
  return [...lines, ""].join("\n");
}
