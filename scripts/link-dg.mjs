// dg を ~/.local/bin/dg にリンクする。mise run dg:link から pnpm run link:dg で呼ぶ（t668）。
// .claude/settings.json のフックは PATH の dg を呼ぶので、dg が PATH になければフックは動かない（dg hooks check が not found と警告する）。
// リンク先はこのリポジトリの packages/cli/bin/dg.js の絶対パス。一度張れば、git pull のあとの mise run install で更新される。
// clone を移したときは張り直す。既存が通常のファイルなら消さずに止める（ほかの dg を壊さない）。既存のリンクは張り替える（ln -sf と同じ）。
// 置き場所は os.homedir() の下（HOME で変わる。テストは一時ディレクトリの HOME で確かめる）。
// PATH に ~/.local/bin がなければ、足す一行を案内する。Windows は想定しない。
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "packages", "cli", "bin", "dg.js");
const binDir = path.join(homedir(), ".local", "bin");
const link = path.join(binDir, "dg");

if (!existsSync(target)) {
  console.error(`link-dg: ${target} がない。先に mise run build を実行する`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
let previous = null;
try {
  // lstat なので、張り先が消えた壊れたリンクも見つける
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) {
    console.error(
      `link-dg: ${link} は通常のファイルなので消さずに止めた。中身を確かめ、要らなければ消してからもう一度実行する`,
    );
    process.exit(1);
  }
  previous = readlinkSync(link);
  rmSync(link);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
symlinkSync(target, link);

if (previous === target) {
  console.log(`link-dg: ${link} は既にこのリポジトリの dg を指している`);
} else if (previous !== null) {
  console.log(`link-dg: ${link} を張り替えた（前は ${previous}）`);
} else {
  console.log(`link-dg: ${link} を張った`);
}

const onPath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .some((dir) => dir !== "" && path.resolve(dir) === binDir);
if (!onPath) {
  console.log(
    'link-dg: ~/.local/bin が PATH にない。シェルの設定に export PATH="$HOME/.local/bin:$PATH" を足す',
  );
}
console.log(
  "link-dg: 確かめるには dg hooks check を実行する（フックが呼ぶ dg が PATH にあるかを見る）",
);
