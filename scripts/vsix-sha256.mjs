// mise run vsix（pnpm run vsix）の最後に、できた VSIX の SHA256 と、GitHub の Release の本文に貼る文を出す（t471）。
// 出した文はそのまま Release の本文に貼る。引数で VSIX の位置を変えられる（テスト用。既定は packages/vscode/deguboard-vscode.vsix）

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsix = path.resolve(
  process.argv[2] ?? path.join(root, "packages", "vscode", "deguboard-vscode.vsix"),
);
const name = path.basename(vsix);
if (!existsSync(vsix)) {
  console.error(`vsix-sha256: ${name} がない。先に mise run vsix を実行する`);
  process.exit(1);
}
const sha256 = createHash("sha256")
  .update(await readFile(vsix))
  .digest("hex");

console.log(`
--- GitHub の Release の本文に貼る文 ---
${name} の SHA256：${sha256}

確かめ方：vsix と同じフォルダで \`sha256sum ${name}\` を実行し、出た値が上の値と一致すれば改ざんされていない。
---`);
