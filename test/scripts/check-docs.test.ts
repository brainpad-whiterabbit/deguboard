// scripts/check-docs.mjs が ADR の更新日と一覧（docs/adr/README.md）の更新日の食い違い（t210）と、README.md と README.ja.md の節の構成のずれ（t464）で落ちることを確かめる。
// 拡張と Walkthrough が指す README の見出しアンカーが切れたときも落ちる（t524）。
// 要件 ID・先頭コメント・guide の重複の検査が落ちることも確かめる（t536）。
// スクリプトは自分の置き場所の親をルートとして読むので、検査に要るファイルを一時ディレクトリに写して動かす。
// 調べるファイルは git の追跡と無視の規則で決まるので、一時ディレクトリは git init して .gitignore も写す。
// 写さないファイルへのリンクの切れも出るので、確かめる指摘だけを見る

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COPIED = [
  "scripts/check-docs.mjs",
  ".gitignore",
  "CLAUDE.md",
  "README.md",
  "README.ja.md",
  "docs",
  "packages/cli/src",
  "packages/vscode/src/dg.ts",
  "packages/vscode/media/walkthrough",
];
const ADR = "docs/adr/ADR-008-tech-stack.md";
const ANCHOR = "#getting-started-before-release";
// 検査が本リポジトリのテストの文字列を要件 ID と読まないよう、存在しない ID は組み立てて書く
const UNKNOWN_ID = ["TK", "999"].join("-");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "check-docs-"));
  for (const rel of COPIED) {
    await cp(join(ROOT, rel), join(dir, rel), { recursive: true });
  }
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [join(dir, "scripts/check-docs.mjs")], (error, _stdout, stderr) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stderr });
    });
  });
}

async function rewrite(rel: string, from: RegExp, to: string): Promise<void> {
  const file = join(dir, rel);
  const text = await readFile(file, "utf8");
  expect(text).toMatch(from);
  await writeFile(file, text.replace(from, to));
}

describe("check-docs の README.ja.md", () => {
  it("相対リンクを壊すと落ちる", async () => {
    await rewrite("README.ja.md", /\]\(README\.md\)/, "](NOPE.md)");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/README\.ja\.md.*NOPE\.md/);
  });
});

describe("check-docs の ADR の更新日", () => {
  it("写したままなら更新日の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("更新日");
  });

  it("ADR の更新日をずらすと、一覧との食い違いで落ちる", async () => {
    await rewrite(ADR, /^- 更新日：\d{4}-\d{2}-\d{2}$/m, "- 更新日：2000-01-01");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /ADR-008-tech-stack\.md の更新日が \d{4}-\d{2}-\d{2} で、ADR の 2000-01-01 と食い違う/,
    );
  });

  it("一覧の更新日をずらしても落ちる", async () => {
    await rewrite(
      "docs/adr/README.md",
      /(\[ADR-008\]\(ADR-008-tech-stack\.md\).*\|\s*)\d{4}-\d{2}-\d{2}(\s*\|)$/m,
      "$12000-01-01$2",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("ADR-008-tech-stack.md の更新日が 2000-01-01 で");
  });

  it("置き換え済みの ADR は更新日がずれても指摘しない", async () => {
    await rewrite(ADR, /^- ステータス：.*$/m, "- ステータス：置き換え（ADR-009）");
    await rewrite(ADR, /^- 更新日：\d{4}-\d{2}-\d{2}$/m, "- 更新日：2000-01-01");
    const { stderr } = await run();
    expect(stderr).not.toContain("更新日");
  });

  it("ADR に更新日の行がなければ落ちる", async () => {
    await rewrite(ADR, /^- 更新日：.*\n/m, "");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("ADR-008-tech-stack.md: 「- 更新日：YYYY-MM-DD」の行がない");
  });

  it("一覧の行から更新日を消すと落ちる", async () => {
    await rewrite(
      "docs/adr/README.md",
      /(\[ADR-008\]\(ADR-008-tech-stack\.md\).*\|)\s*\d{4}-\d{2}-\d{2}\s*\|$/m,
      "$1",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("docs/adr/README.md: ADR-008-tech-stack.md の行に更新日がない");
  });
});

describe("check-docs の README.md と README.ja.md の節の構成", () => {
  it("写したままなら構成のずれは指摘しない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("階層が README.md とずれている");
  });

  it("README.ja.md の見出しの階層を変えると、位置と両方の見出しを出して落ちる", async () => {
    await rewrite("README.ja.md", /^## (.+)$/m, "### $1");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /README\.ja\.md: \d+ 番目の見出しの階層が README\.md とずれている: README\.md は ## .+（\d+ 行目）、README\.ja\.md は ### .+（\d+ 行目）/,
    );
  });

  it("README.md に節を足すと、数のずれで落ちる", async () => {
    const file = join(dir, "README.md");
    await writeFile(file, `${await readFile(file, "utf8")}\n## Extra\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/README\.md は ## Extra（\d+ 行目）、README\.ja\.md は （なし）/);
    expect(stderr).toMatch(/見出しは README\.md が (\d+) 個、README\.ja\.md が \d+ 個/);
  });

  it("コードのブロックの中の # は見出しとして数えない", async () => {
    const file = join(dir, "README.ja.md");
    await writeFile(file, `${await readFile(file, "utf8")}\n\`\`\`sh\n# コメント\n\`\`\`\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain("階層が README.md とずれている");
  });
});

describe("check-docs の拡張と Walkthrough が指す README の見出しアンカー（t524）", () => {
  it("写したままならアンカーの指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("README.md に見出しがない");
  });

  it("dg.ts が指す見出しのアンカーを壊すと、場所と見出しを出して落ちる", async () => {
    await rewrite(
      "packages/vscode/src/dg.ts",
      new RegExp(ANCHOR),
      "#getting-started-before-relese",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /packages\/vscode\/src\/dg\.ts:\d+: README\.md に見出しがない: #getting-started-before-relese/,
    );
  });

  it("Walkthrough（英語と日本語）が指す見出しのアンカーを壊すと落ちる", async () => {
    await rewrite("packages/vscode/media/walkthrough/init.md", new RegExp(ANCHOR), "#nope");
    await rewrite("packages/vscode/media/walkthrough/init.ja.md", new RegExp(ANCHOR), "#nope");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/init\.md:\d+: README\.md に見出しがない: #nope/);
    expect(stderr).toMatch(/init\.ja\.md:\d+: README\.md に見出しがない: #nope/);
  });

  it("README の見出しを変えると、そこを指す拡張の URL が切れて落ちる", async () => {
    await rewrite("README.md", /^### Getting started before release$/m, "### Setup");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /dg\.ts:\d+: README\.md に見出しがない: #getting-started-before-release/,
    );
  });
});

describe("check-docs の要件 ID・先頭コメント・guide の重複（t536）", () => {
  it("写したままなら要件 ID・先頭コメント・guide の重複は指摘しない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("要件 ID");
    expect(stderr).not.toContain("先頭コメント");
    expect(stderr).not.toContain("同じ段落");
  });

  it("requirements.md にない要件 ID を参照すると、場所を出して落ちる", async () => {
    await writeFile(join(dir, "packages/cli/src/zz-probe.ts"), `// 要件 ${UNKNOWN_ID} の確かめ\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      `packages/cli/src/zz-probe.ts:1: 要件 ID ${UNKNOWN_ID} が docs/requirements.md にない`,
    );
  });

  it("git が無視するビルドの成果物の中の ID は読まない", async () => {
    const built = join(dir, "packages/cli/web/assets/index-x.js");
    await mkdir(dirname(built), { recursive: true });
    await writeFile(built, `var a = "${UNKNOWN_ID}";\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain(UNKNOWN_ID);
  });

  it("接頭辞が要件 ID でない語（UTF-8・SHA-256・ISO-8601）は指摘しない", async () => {
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      '// UTF-8 と SHA-256 と ISO-8601 の話\nexport const enc = "UTF-8";\n',
    );
    const { stderr } = await run();
    expect(stderr).not.toContain("要件 ID");
  });

  it("先頭コメントが指す節・ADR・docs のパスと見出し・guide が存在しないと落ちる", async () => {
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      "// requirements.md 9.9、ADR-999、docs/requirements.md#存在しない、guide-nope\nexport {};\n",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("先頭コメントが指す docs/requirements.md の節 9.9 がない");
    expect(stderr).toContain("先頭コメントが指す ADR-999 がない");
    expect(stderr).toContain("先頭コメントが指す見出しがない: docs/requirements.md#存在しない");
    expect(stderr).toContain("先頭コメントが指す guide-nope.md がない");
  });

  it("同じ段落が 2 本の guide にあると、両方の名前を出して落ちる", async () => {
    const text = "この段落は二つの guide に同じ文として置かれている（重複の検査の確かめ）。";
    for (const rel of ["packages/cli/src/guide-plan.md", "packages/cli/src/guide-work.md"]) {
      await writeFile(join(dir, rel), `${await readFile(join(dir, rel), "utf8")}\n${text}\n`);
    }
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/guide-plan\.md, guide-work\.md: 同じ段落がある/);
  });

  it("40 字未満の短い箇条書きだけの同じ節は指摘しない", async () => {
    for (const rel of ["packages/cli/src/guide-plan.md", "packages/cli/src/guide-work.md"]) {
      await writeFile(
        join(dir, rel),
        `${await readFile(join(dir, rel), "utf8")}\n## 短い節\n\n- 一行目\n- 二行目\n`,
      );
    }
    const { stderr } = await run();
    expect(stderr).not.toContain("短い節");
  });

  it("40 字以上の同じ節の本文は、見出しと両方の guide の名前を出して落ちる", async () => {
    const body =
      "この節の本文は二つの guide に同じ文として置かれていて、正本を 1 本にする必要がある。";
    for (const rel of ["packages/cli/src/guide-plan.md", "packages/cli/src/guide-work.md"]) {
      await writeFile(
        join(dir, rel),
        `${await readFile(join(dir, rel), "utf8")}\n## 長い節\n\n${body}\n`,
      );
    }
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/guide-plan\.md, guide-work\.md: 見出し「長い節」の節の本文が同じ/);
  });
});
