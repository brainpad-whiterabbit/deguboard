// mise run test:related の本体。origin/main との分岐点からの差分（コミット済み・ステージ・未ステージ）と未追跡のファイルを
// 変えたファイルとし、scripts/lib/related-tests.mjs の選び方で選んだテストだけを vitest で回す（t1127）。
// 選ぶテストがなければ vitest を起動せずに成功する。名前で対になるテストがないソースのファイルは 1 行で知らせる。
// 引数はそのまま vitest run に渡す
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELATED_ENV, isSourceFile, isTestFile, selectRelatedTests } from "./lib/related-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * git を引数の配列で呼び、-z の NUL 区切りの出力を項目の配列で返す。-z にするのは、既定の core.quotePath では
 * 非 ASCII のパスが引用符と 8 進のエスケープで出て、existsSync で落ちて黙って選ばれなくなるため
 */
function gitPaths(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((entry) => entry !== "");
}

let base;
try {
  base = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  console.error(
    "test:related: cannot find the merge base with origin/main (fetch origin, or check that the remote is named origin)",
  );
  process.exit(1);
}
const untracked = gitPaths(["ls-files", "-z", "--others", "--exclude-standard"]);
const files = [...gitPaths(["ls-files", "-z"]), ...untracked].filter((file) =>
  existsSync(path.join(root, file)),
);
// 消したファイルは回せないので外す
const changed = [...gitPaths(["diff", "-z", "--name-only", base]), ...untracked].filter((file) =>
  existsSync(path.join(root, file)),
);
const selected = selectRelatedTests(changed, files.filter(isTestFile), files.filter(isSourceFile));

if (selected.unpaired.length > 0) {
  console.error(
    `test:related: no name-paired test for ${selected.unpaired.join(", ")} (the full tests in dg gate <id> --only check cover them)`,
  );
}
if (selected.tests.length === 0) {
  console.error("test:related: no related tests to run");
  process.exit(0);
}

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitest, "run", ...selected.tests, ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit", env: { ...process.env, [RELATED_ENV]: "1" } },
);
process.exit(result.status ?? 1);
