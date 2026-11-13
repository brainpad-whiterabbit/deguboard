// ルートの README.md から VSIX に入れる拡張の README を作る。scripts/vscode-readme.mjs が書き出し、test/scripts/vscode-readme.test.ts が確かめる（t429）。
// 紹介の正本はルートの README（英語）で、全文をそのまま Marketplace に出す。Marketplace では相対リンクが切れるので、相対リンクがあれば作らない（t843）

/** Markdown のリンク・画像と HTML の src・href のうち、http(s) の絶対 URL でないものの先を返す */
export function relativeLinks(markdown) {
  const targets = [
    ...[...markdown.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
  ];
  return targets.filter((t) => !/^https?:\/\//.test(t));
}

/** ルートの README の文面から拡張の README の文面を作る（全文の写し）。相対リンクがあるときは投げる */
export function extensionReadme(rootReadme) {
  const relative = relativeLinks(rootReadme);
  if (relative.length > 0) {
    throw new Error(
      `README.md に相対リンクがある（Marketplace で切れるので絶対 URL にする）：${relative.join("、")}`,
    );
  }
  return rootReadme;
}
