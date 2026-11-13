// mise run build（pnpm run build）の tsc -b と guide の写しのあとで、core・server・cli の dist/ から
// 今のソースに対応しない出力を消す（t871）。tsc は消えたソースや名前を変えたソースの出力を dist/ に残すため。
// dist/ を先に丸ごと消さないのは、ビルド中も main の checkout の dg（フックが絶対パスで呼ぶ）が動き続けるようにし、
// tsbuildinfo による増分のビルドを残すため。
// dist/x.js・x.d.ts・x.js.map・x.d.ts.map は src/x.ts か src/x.tsx（テストの *.test.ts(x) を除く）があれば残す。
// dist/guide/ は src/guide/ の guide-*.md にあるものだけを残す。それ以外のファイルと空になったディレクトリは消す。
// 引数でパッケージのディレクトリを変えられる（テスト用。既定は packages/core・server・cli）

import { existsSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages =
  process.argv.length > 2
    ? process.argv.slice(2).map((p) => path.resolve(p))
    : ["core", "server", "cli"].map((name) => path.join(root, "packages", name));

const OUTPUT_EXTENSIONS = [".d.ts.map", ".js.map", ".d.ts", ".js"];

/** dist/ の中の相対パスが、今のソースから作る出力かを返す */
function hasSource(pkg, rel) {
  const src = path.join(pkg, "src");
  if (rel.startsWith(`guide${path.sep}`) && rel.endsWith(".md")) {
    const name = rel.slice("guide".length + 1);
    return /^guide-[^/\\]*\.md$/.test(name) && existsSync(path.join(src, "guide", name));
  }
  const ext = OUTPUT_EXTENSIONS.find((e) => rel.endsWith(e));
  if (ext === undefined) return false;
  const base = rel.slice(0, -ext.length);
  if (base.endsWith(".test")) return false;
  return existsSync(path.join(src, `${base}.ts`)) || existsSync(path.join(src, `${base}.tsx`));
}

/** dir の下を消して回り、dir が空になったかを返す */
async function prune(pkg, dist, dir) {
  let empty = true;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await prune(pkg, dist, full)) await rmdir(full);
      else empty = false;
    } else if (hasSource(pkg, path.relative(dist, full))) {
      empty = false;
    } else {
      await rm(full, { force: true });
    }
  }
  return empty;
}

for (const pkg of packages) {
  const dist = path.join(pkg, "dist");
  if (existsSync(dist)) await prune(pkg, dist, dist);
}
