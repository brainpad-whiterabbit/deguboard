// scripts/check-docs.mjs が ADR の更新日と一覧（docs/adr/README.md）の更新日の食い違い（t210）と、README.md と README.ja.md の節の構成のずれ（t464）で落ちることを確かめる。
// スクリプトは自分の置き場所の親をルートとして読むので、検査に要るファイルを一時ディレクトリに写して動かす。
// 写さないファイルへのリンクの切れも出るので、確かめる指摘だけを見る

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COPIED = [
  "scripts/check-docs.mjs",
  "CLAUDE.md",
  "README.md",
  "README.ja.md",
  "docs",
  "packages/cli/src",
];
const ADR = "docs/adr/ADR-008-tech-stack.md";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "check-docs-"));
  for (const rel of COPIED) {
    await cp(join(ROOT, rel), join(dir, rel), { recursive: true });
  }
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
