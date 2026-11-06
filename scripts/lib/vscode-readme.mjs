// ルートの README.md から VSIX に入れる拡張の README を作る。scripts/vscode-readme.mjs が書き出し、test/scripts/vscode-readme.test.ts が確かめる（t429）。
// 紹介の正本はルートの README（英語）で、「Other ways to use it」の見出しより前だけを Marketplace に出す

export const CUT_HEADING = "## Other ways to use it";

/** Markdown のリンク・画像と HTML の src・href のうち、http(s) の絶対 URL でないものの先を返す */
export function relativeLinks(markdown) {
  const targets = [
    ...[...markdown.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
  ];
  return targets.filter((t) => !/^https?:\/\//.test(t));
}

/** ルートの README の文面から拡張の README の文面を作る。見出しがない・相対リンクが残るときは投げる */
export function extensionReadme(rootReadme) {
  const lines = rootReadme.split("\n");
  const cut = lines.findIndex((line) => line.trimEnd() === CUT_HEADING);
  if (cut < 0) throw new Error(`README.md に見出し「${CUT_HEADING}」がない`);
  const text = `${lines.slice(0, cut).join("\n").trimEnd()}\n`;
  const relative = relativeLinks(text);
  if (relative.length > 0) {
    throw new Error(
      `README.md の「${CUT_HEADING}」より前に相対リンクがある（Marketplace で切れるので絶対 URL にする）：${relative.join("、")}`,
    );
  }
  return text;
}
