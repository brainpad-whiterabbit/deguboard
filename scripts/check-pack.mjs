// mise run pack（pnpm run pack）の最後に、release/ の tarball がそろい、どれにも package/LICENSE が入っていることを確かめる（t471）。
// LICENSE は各パッケージの prepack がルートから写す。欠けていれば失敗させ、公開の前に気づけるようにする。
// cli の tarball に guide-*.md が入っていないこと、core の tarball に dist/guide/guide-*.md があることも確かめる（t610）。
// 前のビルドの残りが dist にあっても cli に入らないよう、cli の files で除外している（packages/cli/package.json）。この検査は、その除外が効いているかを確かめる。
// tar tzf は複数の tgz を一度に読めないので、1 つずつ呼ぶ。引数で調べるディレクトリを変えられる（テスト用。既定は release/）。
// 個数は 3 かどうかだけを見て、パッケージ名は見ない。中身の検査だけファイル名の接頭辞（deguboard-core-・deguboard-<版>.tgz）で cli と core を見分ける。Windows は想定しない（tar の出力を LF で分ける）

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const EXPECTED = 3; // @deguboard/core・@deguboard/server・deguboard
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(process.argv[2] ?? path.join(root, "release"));
const run = promisify(execFile);

if (!existsSync(dir)) {
  // 根の中ならリポジトリの根からの位置で、外なら絶対パスで出す（install-vsix.mjs と同じ）
  const shown = path.relative(root, dir).startsWith("..") ? dir : path.relative(root, dir);
  console.error(`check-pack: ${shown} がない。先に mise run pack を実行する`);
  process.exit(1);
}

const tarballs = (await readdir(dir)).filter((name) => name.endsWith(".tgz")).sort();
const failed = [];
for (const name of tarballs) {
  const { stdout } = await run("tar", ["tzf", path.join(dir, name)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = stdout.split("\n");
  const problems = [];
  if (!entries.includes("package/LICENSE")) problems.push("LICENSE がない");
  // cli（deguboard-<版>.tgz）に guide-*.md があれば失敗する。guide は core の dist/guide/ だけが持つ
  if (/^deguboard-\d/.test(name)) {
    const stale = entries.filter((entry) => /(^|\/)guide-[^/]*\.md$/.test(entry));
    if (stale.length > 0) problems.push(`guide-*.md が入っている（${stale.join("、")}）`);
  }
  // core（deguboard-core-<版>.tgz）に dist/guide/guide-*.md がなければ失敗する
  if (name.startsWith("deguboard-core-")) {
    const guides = entries.filter((entry) => /^package\/dist\/guide\/guide-[^/]*\.md$/.test(entry));
    if (guides.length === 0) problems.push("dist/guide/guide-*.md がない");
  }
  console.log(`${problems.length === 0 ? "ok" : problems.join("、")} ${name}`);
  if (problems.length > 0) failed.push(`${name}（${problems.join("、")}）`);
}
if (tarballs.length !== EXPECTED) {
  console.error(`check-pack: tarball が ${tarballs.length} 個（${EXPECTED} 個のはず）`);
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`check-pack: 中身の検査に通らない tarball がある：${failed.join("、")}`);
  process.exit(1);
}
