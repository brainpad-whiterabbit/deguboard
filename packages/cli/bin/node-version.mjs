// bin/dg.js が、今の node の版で dg を動かしてよいかを確かめる（t782）。基準は Node 24 以上で、
// 拡張の起動ファイル（packages/vscode/src/launcher.ts）が PATH の node を選ぶ基準（24 以上）と同じ。
// 起動ファイルは current の node（拡張ホストの node。engines で 24 以上に決まる）を検査せずに使うが、
// ここは node の種類によらず、dg.js を動かしている node を見る（PATH の node・絶対パスの node・起動ファイルの node のどれでも）。
// 版が読めないときは止めない（判定できないものを理由に止めない）。

export const REQUIRED_NODE_MAJOR = 24;

/** 今の node が要る版より古いなら、直し方を英語で書いた文（末尾に改行）。動くなら undefined */
export function nodeVersionProblemOf(version) {
  const major = /^v?(\d+)\./.exec(String(version).trim())?.[1];
  if (major === undefined || Number(major) >= REQUIRED_NODE_MAJOR) return undefined;
  return [
    `dg: needs Node.js ${REQUIRED_NODE_MAJOR} or later, but the node that started it is v${version}.`,
    "Run dg with Node 24 first on PATH. In the deguboard repository, `mise run dg -- <args>` uses the Node version in mise.toml.",
    "",
  ].join("\n");
}
