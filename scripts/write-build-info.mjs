// mise run build（pnpm run build）の最後に、ビルドしたコミットを packages/cli/dist/build-info.json に書く（t973）。
// bin/dg.js はそれを今の HEAD と比べ、違えば mise run build を案内する（判定は packages/cli/bin/build-info.mjs）。
// ビルドの最後に書くのは、途中で失敗したビルドの dist を今のものと記録しないため（scripts/prune-dist.mjs はこのファイルを消さない）。
// git の checkout でないとき（HEAD が読めない）は、古い記録を消して何も書かない（判定できないので dg.js は黙る）。
// 引数でリポジトリの最上位を変えられる（テスト用。既定はこのリポジトリ）

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BUILD_INFO_FILE } from "../packages/cli/bin/build-info.mjs";

const root =
  process.argv[2] === undefined
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    : path.resolve(process.argv[2]);
const file = path.join(root, "packages", "cli", "dist", BUILD_INFO_FILE);

let commit;
try {
  commit = (
    await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD"], { cwd: root })
  ).stdout.trim();
} catch {
  commit = undefined;
}

if (commit === undefined || commit === "") {
  await rm(file, { force: true });
} else {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ commit })}\n`);
}
