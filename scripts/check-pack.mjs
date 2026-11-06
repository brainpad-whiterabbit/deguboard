// mise run pack（pnpm run pack）の最後に、release/ の tarball がそろい、どれにも package/LICENSE が入っていることを確かめる（t471）。
// LICENSE は各パッケージの prepack がルートから写す。欠けていれば失敗させ、公開の前に気づけるようにする。
// tar tzf は複数の tgz を一度に読めないので、1 つずつ呼ぶ。引数で調べるディレクトリを変えられる（テスト用。既定は release/）。
// 個数は 3 かどうかだけを見て、パッケージ名は見ない。Windows は想定しない（tar の出力を LF で分ける）

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
const missing = [];
for (const name of tarballs) {
  const { stdout } = await run("tar", ["tzf", path.join(dir, name)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const ok = stdout.split("\n").includes("package/LICENSE");
  console.log(`${ok ? "ok" : "LICENSE がない"} ${name}`);
  if (!ok) missing.push(name);
}
if (tarballs.length !== EXPECTED) {
  console.error(`check-pack: tarball が ${tarballs.length} 個（${EXPECTED} 個のはず）`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`check-pack: package/LICENSE がない tarball がある：${missing.join("、")}`);
  process.exit(1);
}
