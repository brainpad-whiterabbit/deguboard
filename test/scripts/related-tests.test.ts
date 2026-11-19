// scripts/lib/related-tests.mjs（mise run test:related が回すテストの選び方）を確かめる（t1127）。
// 選び方の理由はそのファイルの冒頭のコメント

import { describe, expect, it } from "vitest";
import { isTestFile, selectRelatedTests } from "../../scripts/lib/related-tests.mjs";

const tests = [
  "packages/core/src/commands/hook.test.ts",
  "packages/core/src/commands/hook-settings.test.ts",
  "packages/core/src/commands/orphan-review.test.ts",
  "packages/core/src/commands/orphan-review-judge.test.ts",
  "packages/cli/src/cli.test.ts",
  "packages/web/src/components/Board.test.tsx",
  "test/scripts/gif.test.ts",
  "test/scripts/check-docs.test.ts",
  "test/lint/vitest-max-workers.test.ts",
];

describe("test:related が回すテストの選び方", () => {
  it("変えたテストファイルと、変えたソースと同じディレクトリで名前が対になるテストだけを選ぶ", () => {
    expect(
      selectRelatedTests(
        [
          "packages/core/src/commands/hook.ts",
          "packages/core/src/commands/orphan-review.ts",
          "packages/core/src/commands/orphan-review-judge.ts",
          "packages/core/src/commands/orphan-review-judge.test.ts",
          "packages/core/src/commands/orphan-review.test.ts",
        ],
        tests,
      ),
    ).toEqual({
      tests: [
        "packages/core/src/commands/hook.test.ts",
        "packages/core/src/commands/orphan-review-judge.test.ts",
        "packages/core/src/commands/orphan-review.test.ts",
      ],
      unpaired: [],
    });
  });

  it("名前の一部が重なるだけのテストや、import で関わるほかのパッケージのテストは選ばない", () => {
    const selected = selectRelatedTests(["packages/core/src/commands/hook.ts"], tests);
    expect(selected.tests).toEqual(["packages/core/src/commands/hook.test.ts"]);
  });

  it("tsx のテストと、test/ の下の同じ名前のテストも対にする", () => {
    expect(
      selectRelatedTests(
        ["packages/web/src/components/Board.tsx", "scripts/lib/gif.mjs", "scripts/check-docs.mjs"],
        tests,
      ).tests,
    ).toEqual([
      "packages/web/src/components/Board.test.tsx",
      "test/scripts/check-docs.test.ts",
      "test/scripts/gif.test.ts",
    ]);
  });

  it("対になるテストがないソースのファイルは unpaired に返し、文書や型の宣言は数えない", () => {
    expect(
      selectRelatedTests(
        [
          "vitest.workers.ts",
          "packages/core/src/commands/hook-argv.ts",
          "docs/development.md",
          "mise.toml",
          "scripts/lib/gif.d.mts",
        ],
        tests,
      ),
    ).toEqual({
      tests: [],
      unpaired: ["vitest.workers.ts", "packages/core/src/commands/hook-argv.ts"],
    });
  });

  it("変えたファイルがなければ何も選ばない", () => {
    expect(selectRelatedTests([], tests)).toEqual({ tests: [], unpaired: [] });
  });

  it("vitest.config.ts の include に当たるファイルだけをテストファイルとみなす", () => {
    expect(isTestFile("packages/core/src/a.test.ts")).toBe(true);
    expect(isTestFile("packages/web/src/a.test.tsx")).toBe(true);
    expect(isTestFile("test/e2e/routes.test.ts")).toBe(true);
    expect(isTestFile("test/layout/panel.layout.ts")).toBe(false);
    expect(isTestFile("packages/core/dist/a.test.ts")).toBe(false);
  });
});
