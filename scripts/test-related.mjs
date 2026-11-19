// mise run test:related の本体。origin/main との分岐点からの差分（コミット済み・ステージ・未ステージ）と未追跡のファイルを
// 変えたファイルとし、scripts/lib/related-tests.mjs の選び方で選んだテストだけを vitest で回す（t1127）。
// 選ぶテストがなければ vitest を起動せずに成功する。名前で対になるテストがないソースのファイルは 1 行で知らせる。
// 引数はそのまま vitest run に渡す
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELATED_ENV, isTestFile, selectRelatedTests } from "./lib/related-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** git を引数の配列で呼び、出力の行を返す */
function gitLines(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

const base = gitLines(["merge-base", "origin/main", "HEAD"])[0];
const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
// 消したファイルは回せないので外す
const changed = [...gitLines(["diff", "--name-only", base]), ...untracked].filter((file) =>
  existsSync(path.join(root, file)),
);
const tests = [...gitLines(["ls-files"]), ...untracked].filter(
  (file) => isTestFile(file) && existsSync(path.join(root, file)),
);
const selected = selectRelatedTests(changed, tests);

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
