// scripts/lib/related-tests.mjs（mise run test:related が回すテストの選び方）を確かめる（t1127）。
// 選び方の理由はそのファイルの冒頭のコメント

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DATA_FILE_TESTS,
  FALLBACK_BASE_REF,
  isTestFile,
  planRelatedRun,
  resolveBaseRef,
  selectRelatedTests,
} from "../../scripts/lib/related-tests.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guideTests = [
  "packages/cli/src/guide.test.ts",
  "packages/cli/src/skill.test.ts",
  "packages/core/src/commands/skill-files.test.ts",
  "packages/core/src/guide/guide.test.ts",
];

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
  "packages/core/src/commands/iteration-next.test.ts",
  "packages/core/src/commands/flow.test.ts",
  "packages/core/src/commands/flow-permission.test.ts",
  "packages/web/src/l10n.test.ts",
  "packages/web/src/l10n-screens.test.tsx",
  ...guideTests,
];

const sources = [
  "packages/core/src/commands/hook.ts",
  "packages/core/src/commands/hook-settings.ts",
  "packages/core/src/commands/hook-argv.ts",
  "packages/core/src/commands/orphan-review.ts",
  "packages/core/src/commands/orphan-review-judge.ts",
  "packages/core/src/commands/iteration.ts",
  "packages/core/src/commands/flow.ts",
  "packages/core/src/commands/flow-records.ts",
  "packages/web/src/l10n.ts",
  "packages/web/src/l10n-core.ts",
  "packages/web/src/components/Board.tsx",
  "scripts/lib/gif.mjs",
  "scripts/lib/gif.d.mts",
  "scripts/check-docs.mjs",
  "vitest.workers.ts",
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
        sources,
      ),
    ).toEqual({
      tests: [
        "packages/core/src/commands/hook.test.ts",
        "packages/core/src/commands/orphan-review-judge.test.ts",
        "packages/core/src/commands/orphan-review.test.ts",
      ],
      unpaired: [],
      untested: [],
    });
  });

  it("名前の一部が重なるだけのテストや、import で関わるほかのパッケージのテストは選ばない", () => {
    // hook-settings.test.ts は hook-settings.ts を持つので、hook.ts を変えても選ばない
    const selected = selectRelatedTests(["packages/core/src/commands/hook.ts"], tests, sources);
    expect(selected.tests).toEqual(["packages/core/src/commands/hook.test.ts"]);
  });

  it("同じ名前のソースを持たない <名前>-*.test.ts(x) は、分けたテストとして対にする", () => {
    expect(
      selectRelatedTests(
        [
          "packages/core/src/commands/iteration.ts",
          "packages/core/src/commands/flow.ts",
          "packages/web/src/l10n.ts",
        ],
        tests,
        sources,
      ),
    ).toEqual({
      tests: [
        "packages/core/src/commands/flow-permission.test.ts",
        "packages/core/src/commands/flow.test.ts",
        "packages/core/src/commands/iteration-next.test.ts",
        "packages/web/src/l10n-screens.test.tsx",
        "packages/web/src/l10n.test.ts",
      ],
      unpaired: [],
      untested: [],
    });
  });

  it("tsx のテストと、test/ の下の同じ名前のテストも対にする", () => {
    expect(
      selectRelatedTests(
        ["packages/web/src/components/Board.tsx", "scripts/lib/gif.mjs", "scripts/check-docs.mjs"],
        tests,
        sources,
      ).tests,
    ).toEqual([
      "packages/web/src/components/Board.test.tsx",
      "test/scripts/check-docs.test.ts",
      "test/scripts/gif.test.ts",
    ]);
  });

  it("対になるテストがないソースのファイルは unpaired に、テストを選べない文書や設定は untested に返し、型の宣言は数えない", () => {
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
        sources,
      ),
    ).toEqual({
      tests: [],
      unpaired: ["vitest.workers.ts", "packages/core/src/commands/hook-argv.ts"],
      untested: ["docs/development.md", "mise.toml"],
    });
  });

  it("guide の .md を変えたら、その .md を読むテストを選ぶ", () => {
    expect(
      selectRelatedTests(
        ["packages/core/src/guide/guide-work.md", "packages/core/src/guide/guide-choices.md"],
        tests,
        sources,
      ),
    ).toEqual({ tests: guideTests, unpaired: [], untested: [] });
  });

  it("guide のフォルダの外の .md と、guide- で始まらない .md は guide のテストを選ばない", () => {
    expect(
      selectRelatedTests(
        ["docs/guide-notes/work.md", "packages/core/src/guide/README.md"],
        tests,
        sources,
      ),
    ).toEqual({
      tests: [],
      unpaired: [],
      untested: ["docs/guide-notes/work.md", "packages/core/src/guide/README.md"],
    });
  });

  it("表に載せたテストがリポジトリになければ選ばず、テストを選べないファイルとして返す", () => {
    expect(
      selectRelatedTests(
        ["packages/core/src/guide/guide-work.md"],
        ["test/scripts/gif.test.ts"],
        sources,
      ),
    ).toEqual({ tests: [], unpaired: [], untested: ["packages/core/src/guide/guide-work.md"] });
  });

  it("DATA_FILE_TESTS に載せたテストはリポジトリにある（名前を変えたら表も直す）", () => {
    const listed = DATA_FILE_TESTS.flatMap((entry) => entry.tests);
    expect(listed.filter((test) => !existsSync(path.join(repoRoot, test)))).toEqual([]);
    expect(listed.every(isTestFile)).toBe(true);
  });

  it("同じ接頭辞の下位のディレクトリにあるテストは、分けたテストとして選ばない", () => {
    // flow-x/ の下のテストは flow- で始まるが、flow.ts と同じディレクトリではない
    expect(
      selectRelatedTests(
        ["packages/core/src/commands/flow.ts"],
        [...tests, "packages/core/src/commands/flow-x/a.test.ts"],
        sources,
      ).tests,
    ).toEqual([
      "packages/core/src/commands/flow-permission.test.ts",
      "packages/core/src/commands/flow.test.ts",
    ]);
  });

  it(".cjs・.mts・.cts もソースとして対になるテストを探し、なければ unpaired に返す", () => {
    expect(
      selectRelatedTests(
        ["scripts/lib/a.cjs", "scripts/lib/b.mts", "scripts/lib/c.cts"],
        [...tests, "test/scripts/a.test.ts", "test/scripts/b.test.ts"],
        [...sources, "scripts/lib/a.cjs", "scripts/lib/b.mts", "scripts/lib/c.cts"],
      ),
    ).toEqual({
      tests: ["test/scripts/a.test.ts", "test/scripts/b.test.ts"],
      unpaired: ["scripts/lib/c.cts"],
      untested: [],
    });
  });

  it("変えたファイルがなければ何も選ばない", () => {
    expect(selectRelatedTests([], tests, sources)).toEqual({
      tests: [],
      unpaired: [],
      untested: [],
    });
  });

  it("vitest.config.ts の include に当たるファイルだけをテストファイルとみなす", () => {
    expect(isTestFile("packages/core/src/a.test.ts")).toBe(true);
    expect(isTestFile("packages/web/src/a.test.tsx")).toBe(true);
    expect(isTestFile("test/e2e/routes.test.ts")).toBe(true);
    expect(isTestFile("test/layout/panel.layout.ts")).toBe(false);
    expect(isTestFile("packages/core/dist/a.test.ts")).toBe(false);
  });
});

describe("test:related の回す・知らせる・何もしない（planRelatedRun）", () => {
  const files = [...tests, ...sources];
  const unpairedLine = (names: string) =>
    `test:related: no name-paired test for ${names} (the full tests in mise run check, which dg pr ready runs, cover them)`;
  const untestedLine = (names: string) =>
    `test:related: no test selected for ${names} (neither source nor test files; the full tests in mise run check, which dg pr ready runs, cover any test that reads them)`;
  const nothingLine = "test:related: no related tests to run";

  it.each([
    {
      name: "対になるテストがあるソースだけを変えたら、知らせずに回す",
      changed: ["packages/core/src/commands/hook.ts"],
      expected: { tests: ["packages/core/src/commands/hook.test.ts"], messages: [] },
    },
    {
      name: "対になるテストがないソースもあれば、知らせてから回す",
      changed: ["packages/core/src/commands/hook.ts", "packages/core/src/commands/hook-argv.ts"],
      expected: {
        tests: ["packages/core/src/commands/hook.test.ts"],
        messages: [unpairedLine("packages/core/src/commands/hook-argv.ts")],
      },
    },
    {
      name: "対になるテストがないソースだけなら、知らせて何もしない",
      changed: ["vitest.workers.ts"],
      expected: { tests: [], messages: [unpairedLine("vitest.workers.ts"), nothingLine] },
    },
    {
      name: "文書だけを変えたら、テストを選べないことと回すものがないことを知らせて何もしない",
      changed: ["docs/development.md"],
      expected: { tests: [], messages: [untestedLine("docs/development.md"), nothingLine] },
    },
    {
      name: "guide の .md を変えたら、知らせずにその .md を読むテストを回す",
      changed: ["packages/core/src/guide/guide-work.md"],
      expected: { tests: guideTests, messages: [] },
    },
    {
      name: "テストを選べるソースと選べない設定を一緒に変えたら、設定のことを知らせてから回す",
      changed: ["packages/core/src/commands/hook.ts", "mise.toml"],
      expected: {
        tests: ["packages/core/src/commands/hook.test.ts"],
        messages: [untestedLine("mise.toml")],
      },
    },
    {
      name: "消した文書は知らせにも出さない",
      changed: ["docs/gone.md"],
      expected: { tests: [], messages: [nothingLine] },
    },
    {
      name: "変えたファイルがなければ、回すものがないとだけ知らせて何もしない",
      changed: [],
      expected: { tests: [], messages: [nothingLine] },
    },
    {
      name: "消したテストとソースは外し、知らせにも出さない",
      changed: ["packages/core/src/commands/gone.test.ts", "packages/core/src/commands/gone.ts"],
      expected: { tests: [], messages: [nothingLine] },
    },
    {
      name: "消したファイルと今あるファイルを一緒に変えたら、今あるほうだけで選ぶ",
      changed: ["packages/core/src/commands/gone.ts", "packages/core/src/commands/flow.ts"],
      expected: {
        tests: [
          "packages/core/src/commands/flow-permission.test.ts",
          "packages/core/src/commands/flow.test.ts",
        ],
        messages: [],
      },
    },
  ])("$name", ({ changed, expected }) => {
    expect(
      planRelatedRun(changed, [
        ...files,
        "docs/development.md",
        "mise.toml",
        "packages/core/src/guide/guide-work.md",
      ]),
    ).toEqual(expected);
  });
});

describe("test:related の比べる相手（resolveBaseRef）", () => {
  const configOutput = (git: Record<string, unknown>) =>
    JSON.stringify({ ok: true, data: { git: { data_branch: "deguboard", ...git } } });
  const fallback = {
    ref: FALLBACK_BASE_REF,
    message: `test:related: cannot read git.remote and git.base_branch from dg config show (run mise run build); comparing with ${FALLBACK_BASE_REF}`,
  };

  it.each([
    {
      name: "config の git.remote と git.base_branch から決める",
      output: configOutput({ remote: "upstream", base_branch: "develop" }),
      expected: { ref: "upstream/develop" },
    },
    {
      name: "dg が動かなければ既定と比べ、そのことを知らせる",
      output: undefined,
      expected: fallback,
    },
    { name: "JSON でない出力なら既定と比べる", output: "error", expected: fallback },
    {
      name: "git.remote が空なら既定と比べる",
      output: configOutput({ remote: "", base_branch: "main" }),
      expected: fallback,
    },
    {
      name: "git.base_branch がなければ既定と比べる",
      output: configOutput({ remote: "origin" }),
      expected: fallback,
    },
  ])("$name", ({ output, expected }) => {
    expect(resolveBaseRef(output)).toEqual(expected);
  });
});
