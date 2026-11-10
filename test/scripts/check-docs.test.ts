// scripts/check-docs.mjs が ADR の更新日の照合をやめ、列や行がなくても通ることを確かめる（t634）。
// 実在しない ADR の番号・「最後に使った番号」との食い違いで落ち、8,000 字を超える ADR は警告で落とさないことも確かめる（t634）。
// README.md と README.ja.md の節の構成のずれで落ちることを確かめる（t464）。
// 拡張と Walkthrough が指す README の見出しアンカーが切れたときも落ちる（t524）。
// 要件 ID・先頭コメント・guide の重複の検査が落ちることも確かめる（t536）。
// 節を消して定義がなくなった接頭辞の参照は、接頭辞の一覧から拾って落ちることも確かめる（t552）。
// 段落の重複は guide だけでなく README・CLAUDE.md・docs の正本の外の文書も見る（t551）。
// 「dg guide <topic> の「<節>」」の節が guide-<topic>.md の見出し・太字の項目・一覧の先頭のコードに無いと落ちる（t561）。
// その参照が packages の .ts・.tsx の文字列とコメントにあっても落ちる（t562）。
// 英語の形「the "<節>" section of `dg guide <topic>`」の参照も同じ照らし方で落ちる（t563）。
// 要件の 1 項が上限の 250 字を超えたときと、コードとテストが置き換え済みの ADR を指したときも落ちる（t580）。
// スクリプトは自分の置き場所の親をルートとして読むので、検査に要るファイルを一時ディレクトリに写して動かす。
// 調べるファイルは git の追跡と無視の規則で決まるので、一時ディレクトリは git init して .gitignore も写す。
// 写さないファイルへのリンクの切れも出るので、確かめる指摘だけを見る
// ADR 番号の実在は、packages・scripts・docs・ルートのファイル（バイナリを除く）と test の先頭コメントで見ることも確かめる（t634）。
// packages・scripts・test の ADR 番号が先頭のコメントの外にあると場所を出して落ち、先頭のコメントに異なる番号が 2 つ以上あっても落ちることも確かめる（t641）。
// このテストは実際の docs・CLAUDE.md の値（最後に使った番号・ADR の状態の行など）を写して確かめるので、文書だけの PR で落ちうる。
// 軽い検査（mise run check:light、test:docs）にも入れて、main の check で初めて落ちないようにする（t662）。
// 値を写したファイルに替える案は採らない。ここで確かめたい入力そのものが実際の文書だから。

import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  "packages/core/src/guide",
  "packages/vscode/src/dg.ts",
  "packages/vscode/media/walkthrough",
];
// ADR 番号そのものを検査するテストなので、検査の入力と期待する指摘の文には ADR 番号を残す（テストの文字列から番号を外す規則の例外）
const ADR = "docs/adr/ADR-008-tech-stack.md";
const ANCHOR = "#getting-started-before-release";
// 検査が本リポジトリのテストの文字列を要件 ID と読まないよう、存在しない ID は組み立てて書く
const UNKNOWN_ID = ["TK", "999"].join("-");
// 定義をすべて消す接頭辞（一覧には残す）の ID。組み立てて書くのは UNKNOWN_ID と同じ理由
const GONE_ID = ["SY", "1"].join("-");
// 置き換え済みの ADR（ADR-028 に置き換えた 004 番の架空のファイル）。本リポジトリのテストが置き換え済みの ADR を指すと検査が落ちるので組み立てて書く
const OLD_ADR = ["ADR", "004"].join("-");
const OLD_FILE = "ADR-004-old-agents-and-state.md";

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

/** 指摘の欄（「check:docs の指摘」の後ろ）。警告の欄と分けて、落とす指摘が出ていないかを見る */
function findingsOf(stderr: string): string {
  return stderr.split("check:docs の指摘")[1] ?? "";
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

describe("check-docs の ADR の更新日の照合をやめる（t634）", () => {
  it("ADR の「- 更新日：」の行と一覧の更新日の列がなくても落ちない", async () => {
    const adrPath = join(dir, "docs/adr");
    for (const f of await readdir(adrPath)) {
      if (!/^ADR-\d{3}-.+\.md$/.test(f)) continue;
      const file = join(adrPath, f);
      await writeFile(file, (await readFile(file, "utf8")).replace(/^- 更新日：.*\n/m, ""));
    }
    const list = join(dir, "docs/adr/README.md");
    await writeFile(
      list,
      (await readFile(list, "utf8")).replace(/\|\s*\d{4}-\d{2}-\d{2}\s*\|$/gm, "|"),
    );
    const { stderr } = await run();
    expect(findingsOf(stderr)).not.toContain("更新日");
    expect(stderr).not.toContain("一覧に載っていない");
    expect(stderr).not.toContain("の行がない");
  });
});

describe("check-docs の ADR 番号の実在（t634）", () => {
  const PROBE = "packages/cli/src/zz-probe.ts";
  // 本リポジトリに存在しない ADR の番号
  const UNKNOWN_ADR = "ADR-099";

  async function append(rel: string, text: string): Promise<void> {
    await writeFile(join(dir, rel), `${await readFile(join(dir, rel), "utf8")}\n${text}\n`);
  }

  it("写したままなら実在しない ADR 番号の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("docs/adr にない");
  });

  it("文書・CLAUDE.md・packages の .ts の文字列・scripts のコメントの実在しない番号は、場所を出して落ちる", async () => {
    await append("docs/development.md", `参照の確かめ：${UNKNOWN_ADR} を見る。`);
    await append("CLAUDE.md", `参照の確かめ：${UNKNOWN_ADR} を見る。`);
    await writeFile(join(dir, PROBE), `export const s = "${UNKNOWN_ADR}";\n`);
    await writeFile(join(dir, "scripts/zz-probe.mjs"), `// ${UNKNOWN_ADR} の確かめ\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/docs\/development\.md:\d+: ADR-099 が docs\/adr にない/);
    expect(stderr).toMatch(/CLAUDE\.md:\d+: ADR-099 が docs\/adr にない/);
    expect(stderr).toContain(`${PROBE}:1: ADR-099 が docs/adr にない`);
    expect(stderr).toContain("scripts/zz-probe.mjs:1: ADR-099 が docs/adr にない");
  });

  it("実在する番号と、git が無視するビルドの成果物の中の番号は指摘しない", async () => {
    await writeFile(join(dir, PROBE), "export const s = 'ADR-034';\n");
    const built = join(dir, "packages/cli/web/assets/index-x.js");
    await mkdir(dirname(built), { recursive: true });
    await writeFile(built, `var a = "${UNKNOWN_ADR}";\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain("ADR-034 が docs/adr にない");
    expect(stderr).not.toContain(UNKNOWN_ADR);
  });

  it("packages の .css・.mts・.json・.html と、ルートの設定ファイル（pnpm-workspace.yaml）の実在しない番号も、場所を出して落ちる", async () => {
    await mkdir(join(dir, "packages/web/src"), { recursive: true });
    await mkdir(join(dir, "packages/cli"), { recursive: true });
    await writeFile(join(dir, "packages/web/src/zz-probe.css"), `/* ${UNKNOWN_ADR} */\n`);
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.mts"),
      `export const s = "${UNKNOWN_ADR}";\n`,
    );
    await writeFile(join(dir, "packages/cli/zz-probe.json"), `{"note": "${UNKNOWN_ADR}"}\n`);
    await writeFile(join(dir, "packages/cli/zz-probe.html"), `<!-- ${UNKNOWN_ADR} -->\n`);
    await writeFile(join(dir, "pnpm-workspace.yaml"), `# ${UNKNOWN_ADR}\n`);
    const { stderr } = await run();
    const findings = findingsOf(stderr);
    expect(findings).toContain("packages/web/src/zz-probe.css:1: ADR-099 が docs/adr にない");
    expect(findings).toContain("packages/cli/src/zz-probe.mts:1: ADR-099 が docs/adr にない");
    expect(findings).toContain("packages/cli/zz-probe.json:1: ADR-099 が docs/adr にない");
    expect(findings).toContain("packages/cli/zz-probe.html:1: ADR-099 が docs/adr にない");
    expect(findings).toContain("pnpm-workspace.yaml:1: ADR-099 が docs/adr にない");
  });

  it("バイナリの拡張子（画像など）の中の番号は読まない", async () => {
    await mkdir(join(dir, "packages/web/src"), { recursive: true });
    await writeFile(join(dir, "packages/web/src/zz-logo.png"), `${UNKNOWN_ADR}\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain("zz-logo.png");
  });

  it("test の先頭コメントの実在しない番号は場所を出して落ち、test の本文の番号は実在の指摘を出さない（本文の番号は位置の検査が見る）", async () => {
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(
      join(dir, "test/zz-probe.test.ts"),
      `// ${UNKNOWN_ADR} の確かめ\nit("${UNKNOWN_ADR} のとおり動く", () => {});\n`,
    );
    const { stderr } = await run();
    const findings = findingsOf(stderr);
    expect(findings).toContain(
      "test/zz-probe.test.ts:1: 先頭コメントが指す ADR-099 が docs/adr にない",
    );
    expect(findings).not.toContain("test/zz-probe.test.ts:2: ADR-099 が docs/adr にない");
  });
});

describe("check-docs の ADR 番号の位置（t641）", () => {
  // 本リポジトリに存在する ADR の番号（位置だけを見るので、実在は問わない）
  const KNOWN_ADR = "ADR-008";

  it("写したままなら先頭のコメントの外の ADR 番号の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("先頭のコメントの外");
    expect(stderr).not.toContain("異なる ADR 番号");
  });

  it("packages・scripts・test の本文の ADR 番号は、ファイルと行を出して落ちる", async () => {
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      `// 先頭の確かめ\nexport const s = "${KNOWN_ADR}";\n`,
    );
    await writeFile(
      join(dir, "scripts/zz-probe.mjs"),
      `// 先頭の確かめ\nconst s = "${KNOWN_ADR}";\n`,
    );
    await writeFile(
      join(dir, "test/zz-probe.test.ts"),
      `// 先頭の確かめ\nit("${KNOWN_ADR}", () => {});\n`,
    );
    const { code, stderr } = await run();
    const findings = findingsOf(stderr);
    expect(code).toBe(1);
    expect(findings).toContain(
      `packages/cli/src/zz-probe.ts:2: ${KNOWN_ADR} が先頭のコメントの外にある（ADR 番号は先頭のコメントに書く）`,
    );
    expect(findings).toContain(`scripts/zz-probe.mjs:2: ${KNOWN_ADR} が先頭のコメントの外にある`);
    expect(findings).toContain(`test/zz-probe.test.ts:2: ${KNOWN_ADR} が先頭のコメントの外にある`);
  });

  it("先頭の /* … */ の塊（CSS の先頭コメント）の中の番号は落とさず、その後の行の番号は落とす", async () => {
    await mkdir(join(dir, "packages/web/src"), { recursive: true });
    await writeFile(
      join(dir, "packages/web/src/zz-probe.css"),
      `/* 先頭の確かめ（${KNOWN_ADR}）\n   続きの行 */\n.a { color: red; }\n/* ${KNOWN_ADR} */\n`,
    );
    const { stderr } = await run();
    const findings = findingsOf(stderr);
    expect(findings).toContain(
      `packages/web/src/zz-probe.css:4: ${KNOWN_ADR} が先頭のコメントの外にある`,
    );
    expect(findings).not.toContain("packages/web/src/zz-probe.css:1:");
  });

  it("先頭のコメントに異なる ADR 番号が 2 つ以上あると、ファイルを出して落ちる", async () => {
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      `// ${KNOWN_ADR} と ADR-001 の話\nexport {};\n`,
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(findingsOf(stderr)).toContain(
      `packages/cli/src/zz-probe.ts: 先頭のコメントに異なる ADR 番号が 2 個ある（${KNOWN_ADR}、ADR-001）。1 つにする`,
    );
  });

  it("先頭のコメントに同じ番号を 2 度書いても、異なる番号の指摘は出ない", async () => {
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      `// ${KNOWN_ADR} の話と ${KNOWN_ADR} の続き\nexport {};\n`,
    );
    const { stderr } = await run();
    expect(stderr).not.toContain("異なる ADR 番号");
  });

  it("ADR 番号そのものを検査するテストと check-docs 自身は、理由を書いた例外として落とさない", async () => {
    await mkdir(join(dir, "test/scripts"), { recursive: true });
    await writeFile(
      join(dir, "test/scripts/check-docs.test.ts"),
      `// 先頭の確かめ\nit("${KNOWN_ADR}", () => {});\n`,
    );
    await appendFile(join(dir, "scripts/check-docs.mjs"), `\nconst probe = "${KNOWN_ADR}";\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain("test/scripts/check-docs.test.ts:");
    expect(stderr).not.toContain("scripts/check-docs.mjs:");
  });

  it("git が無視するビルドの成果物（dist）の本文の番号は落とさない", async () => {
    await mkdir(join(dir, "packages/cli/dist"), { recursive: true });
    await writeFile(join(dir, "packages/cli/dist/zz-probe.js"), `var a = 1;\n// ${KNOWN_ADR}\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain("zz-probe.js");
  });
});

describe("check-docs の最後に使った番号（t634）", () => {
  it("写したままなら最後に使った番号の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("最後に使った番号");
  });

  it("実在の最大より小さい番号を書くと、その ADR を出して落ちる", async () => {
    await rewrite("docs/adr/README.md", /最後に使った番号：ADR-034/, "最後に使った番号：ADR-033");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /「最後に使った番号」が ADR-033 だが、ADR-034-storage-and-id\.md はそれより大きい/,
    );
  });

  it("最後に使った番号より大きい番号の ADR を足すと、その ADR を出して落ちる", async () => {
    await writeFile(join(dir, "docs/adr/ADR-035-probe.md"), "# 確かめ\n");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      "docs/adr/README.md: 「最後に使った番号」が ADR-034 だが、ADR-035-probe.md はそれより大きい",
    );
  });

  it("「最後に使った番号」の行を消すと、場所を出して落ちる", async () => {
    await rewrite("docs/adr/README.md", /^最後に使った番号：.*\n/m, "");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("docs/adr/README.md: 「最後に使った番号：ADR-NNN」の行がない");
  });
});

describe("check-docs の ADR の長さの警告（t634）", () => {
  // 「# ADR-008\n」は 10 字
  const HEAD = "# ADR-008\n";

  it("8,000 字ちょうどの ADR は警告しない", async () => {
    await writeFile(join(dir, ADR), `${HEAD}${"あ".repeat(8000 - HEAD.length)}`);
    const { stderr } = await run();
    expect(stderr).not.toContain("字を超えている");
  });

  it("8,001 字の ADR は警告を出すが、指摘の欄には出ない（落とさない）", async () => {
    await writeFile(join(dir, ADR), `${HEAD}${"あ".repeat(8001 - HEAD.length)}`);
    const { stderr } = await run();
    expect(stderr).toMatch(
      /警告[\s\S]*docs\/adr\/ADR-008-tech-stack\.md: 8001 字で、8000 字を超えている/,
    );
    expect(findingsOf(stderr)).not.toContain("ADR-008-tech-stack.md");
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

  it("接頭辞の一覧にない語（ADR の番号・UTC-5・SP-10）は、定義がなくても指摘しない", async () => {
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      "// ADR-001 と UTF-8 と SHA-256 と UTC-5 と SP-10 の話\nexport {};\n",
    );
    const { stderr } = await run();
    expect(stderr).not.toContain("要件 ID");
  });

  it("定義された接頭辞が一覧にないと、接頭辞の名前を出して落ちる", async () => {
    const req = join(dir, "docs/requirements.md");
    await writeFile(req, `${await readFile(req, "utf8")}\n- QZ-1 一覧に入れ忘れた確かめ\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      "docs/requirements.md: 接頭辞 QZ が「要件の ID の接頭辞：」の一覧にない",
    );
  });

  it("一覧の行に接頭辞がバッククォートで囲まれていないと、落ちる", async () => {
    await rewrite("docs/requirements.md", /^要件の ID の接頭辞：.*$/m, "要件の ID の接頭辞：AG CL");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("「要件の ID の接頭辞：」の一覧に接頭辞がない");
  });

  it("節を消して定義がなくなっても、接頭辞の一覧に残る接頭辞の参照は場所を出して落ちる", async () => {
    const req = join(dir, "docs/requirements.md");
    const lines = (await readFile(req, "utf8")).split("\n");
    await writeFile(req, lines.filter((l) => !/^- SY-\d+/.test(l)).join("\n"));
    await writeFile(join(dir, "packages/cli/src/zz-probe.ts"), `// 要件 ${GONE_ID} の確かめ\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      `packages/cli/src/zz-probe.ts:1: 要件 ID ${GONE_ID} が docs/requirements.md にない`,
    );
  });

  it("要件の ID の接頭辞の一覧の行を消すと、場所を出して落ちる", async () => {
    await rewrite("docs/requirements.md", /^要件の ID の接頭辞：.*\n/m, "");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("docs/requirements.md: 「要件の ID の接頭辞：」の一覧の行がない");
  });

  it("先頭コメントが指す節・ADR・docs のパスと見出し・guide が存在しないと落ちる", async () => {
    await writeFile(
      join(dir, "packages/cli/src/zz-probe.ts"),
      "// requirements.md 9.9、ADR-999、docs/requirements.md#存在しない、guide-nope\nexport {};\n",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("先頭コメントが指す docs/requirements.md の節 9.9 がない");
    expect(stderr).toContain("packages/cli/src/zz-probe.ts:1: ADR-999 が docs/adr にない");
    expect(stderr).toContain("先頭コメントが指す見出しがない: docs/requirements.md#存在しない");
    expect(stderr).toContain("先頭コメントが指す guide-nope.md がない");
  });

  it("同じ段落が 2 本の guide にあると、両方の名前を出して落ちる", async () => {
    const text = "この段落は二つの guide に同じ文として置かれている（重複の検査の確かめ）。";
    for (const rel of [
      "packages/core/src/guide/guide-plan.md",
      "packages/core/src/guide/guide-work.md",
    ]) {
      await writeFile(join(dir, rel), `${await readFile(join(dir, rel), "utf8")}\n${text}\n`);
    }
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /packages\/core\/src\/guide\/guide-plan\.md:\d+, packages\/core\/src\/guide\/guide-work\.md:\d+: 同じ段落がある/,
    );
  });

  it("40 字未満の短い箇条書きだけの同じ節は指摘しない", async () => {
    for (const rel of [
      "packages/core/src/guide/guide-plan.md",
      "packages/core/src/guide/guide-work.md",
    ]) {
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
    for (const rel of [
      "packages/core/src/guide/guide-plan.md",
      "packages/core/src/guide/guide-work.md",
    ]) {
      await writeFile(
        join(dir, rel),
        `${await readFile(join(dir, rel), "utf8")}\n## 長い節\n\n${body}\n`,
      );
    }
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /packages\/core\/src\/guide\/guide-plan\.md, packages\/core\/src\/guide\/guide-work\.md: 見出し「長い節」の節の本文が同じ/,
    );
  });
});

describe("check-docs の dg guide の節の参照（t561）", () => {
  async function append(rel: string, text: string): Promise<void> {
    await writeFile(join(dir, rel), `${await readFile(join(dir, rel), "utf8")}\n${text}\n`);
  }

  it("写したままなら節の参照の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toMatch(/dg guide [a-z-]+ に節「.+」がない/);
  });

  it("文書の「dg guide <topic> の「<節>」」が guide の節に無いと、場所を出して落ちる", async () => {
    await append(
      "docs/development.md",
      "切れた参照の確かめ：`dg guide work` の「存在しない節」を見る。",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/docs\/development\.md:\d+: dg guide work に節「存在しない節」がない/);
  });

  it("切れた参照を直すと、その指摘は出ない", async () => {
    await append(
      "docs/development.md",
      "切れた参照の確かめ：`dg guide work` の「存在しない節」を見る。",
    );
    await rewrite("docs/development.md", /存在しない節/, "Flow");
    const { stderr } = await run();
    expect(stderr).not.toMatch(/dg guide [a-z-]+ に節「.+」がない/);
  });

  it("「と「…」」で続く 2 つ目の節が切れていても落ちる", async () => {
    await append(
      "packages/core/src/guide/guide-plan.md",
      "参照の確かめ：`dg guide work` の「Flow」と「存在しない節」を見る。",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/guide-plan\.md:\d+: dg guide work に節「存在しない節」がない/);
  });

  it("見出しの一部だけの名前（「流」）は一致しないので落ちる", async () => {
    await append("docs/development.md", "参照の確かめ：`dg guide work` の「流」を見る。");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("dg guide work に節「流」がない");
  });

  it("guide の無いトピックへの参照は、guide のファイルがないと落ちる", async () => {
    await append("docs/development.md", "参照の確かめ：`dg guide nope` の「流れ」を見る。");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /docs\/development\.md:\d+: dg guide nope の guide-nope\.md がない（「流れ」を指す）/,
    );
  });

  it("「（…）」の補足を除いた名前と、節の中の太字の項目・手の名前は節と見なし、落とさない", async () => {
    await append(
      "docs/development.md",
      "参照の確かめ：`dg guide work` の「Implement」と、`dg guide review` の「Return」を見る。`dg guide work` の「ready」の手も同じ。",
    );
    const { stderr } = await run();
    expect(stderr).not.toMatch(/dg guide [a-z-]+ に節「.+」がない/);
  });

  it("コードブロックの中の参照は見ない", async () => {
    await append("docs/development.md", "```\n`dg guide work` の「存在しない節」\n```");
    const { stderr } = await run();
    expect(stderr).not.toContain("存在しない節");
  });
});

describe("check-docs の正本の外の文書の段落の重複（t551）", () => {
  const SHARED = "この段落は二つの文書に同じ文として置かれていて、正本を 1 本にする必要がある。";

  async function append(rel: string, text: string): Promise<void> {
    await writeFile(join(dir, rel), `${await readFile(join(dir, rel), "utf8")}\n${text}\n`);
  }

  it("README.md の段落を docs/development.md に写すと、両方の場所を出して落ちる", async () => {
    await append("README.md", SHARED);
    await append("docs/development.md", SHARED);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/README\.md:\d+/);
    expect(stderr).toMatch(/docs\/development\.md:\d+/);
    expect(stderr).toContain("同じ段落がある");
  });

  it("CLAUDE.md の段落を README.md と docs/requirements.md に写すと、3 か所を出して落ちる", async () => {
    await append("CLAUDE.md", SHARED);
    await append("README.md", SHARED);
    await append("docs/requirements.md", SHARED);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/同じ段落がある/);
    expect(stderr).toMatch(/CLAUDE\.md:\d+/);
    expect(stderr).toMatch(/README\.md:\d+/);
    expect(stderr).toMatch(/docs\/requirements\.md:\d+/);
  });

  it("guide と docs/requirements.md の段落の重複も落ちる", async () => {
    await append("packages/core/src/guide/guide-plan.md", SHARED);
    await append("docs/requirements.md", SHARED);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /packages\/core\/src\/guide\/guide-plan\.md:\d+, docs\/requirements\.md:\d+: 同じ段落がある/,
    );
  });

  it("README.md と README.ja.md の同じ段落（訳どうし）は指摘しない", async () => {
    await append("README.md", SHARED);
    await append("README.ja.md", SHARED);
    const { stderr } = await run();
    expect(stderr).not.toContain("同じ段落");
  });

  it("ADR の段落は、ほかの文書と同じでも指摘しない（判断と理由を書き換えないので）", async () => {
    await append("docs/adr/ADR-008-tech-stack.md", SHARED);
    await append("CLAUDE.md", SHARED);
    const { stderr } = await run();
    expect(stderr).not.toContain("同じ段落");
  });

  it("39 字以下の段落の重複は指摘しない", async () => {
    const short = "短い段落は同じ語でも対象にしない（三十九字以下の確かめ）。";
    expect([...short].length).toBeLessThan(40);
    await append("README.md", short);
    await append("docs/development.md", short);
    const { stderr } = await run();
    expect(stderr).not.toContain("同じ段落");
  });
});

describe("check-docs の .ts の文字列とコメントの dg guide の節の参照（t562）", () => {
  const PROBE = "packages/cli/src/zz-probe.ts";

  it("バッククォートのない .ts の文字列の切れた参照は、場所を出して落ちる", async () => {
    await writeFile(join(dir, PROBE), 'export const s = "dg guide work の「存在しない節」";\n');
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(`${PROBE}:1: dg guide work に節「存在しない節」がない`);
  });

  it("バッククォートで囲んだ .ts のテンプレート文字列の切れた参照（\\` のエスケープ）も落ちる", async () => {
    await writeFile(
      join(dir, PROBE),
      "export const s = `\\`dg guide work\\` の「存在しない節」`;\n",
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(`${PROBE}:1: dg guide work に節「存在しない節」がない`);
  });

  it(".ts のコメントの切れた参照は、場所を出して落ちる", async () => {
    await writeFile(join(dir, PROBE), "// 手順は dg guide nope の「流れ」を読む\nexport {};\n");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/zz-probe\.ts:1: dg guide nope の guide-nope\.md がない/);
  });

  it(".ts の切れた参照を直すと、落ちない", async () => {
    await writeFile(join(dir, PROBE), 'export const s = "dg guide work の「Flow」";\n');
    // 写さないファイルへのリンクの切れも出るので、確かめる指摘だけを見る
    const { stderr } = await run();
    expect(stderr).not.toMatch(/dg guide [a-z-]+ に節/);
  });
});

describe("check-docs の英語の形の dg guide の節の参照（t563）", () => {
  const PROBE = "packages/cli/src/zz-probe.ts";

  async function append(rel: string, text: string): Promise<void> {
    await writeFile(join(dir, rel), `${await readFile(join(dir, rel), "utf8")}\n${text}\n`);
  }

  it('文書の「the "<節>" section of `dg guide <topic>`」が guide の節に無いと、場所を出して落ちる', async () => {
    await append(
      "docs/development.md",
      '切れた参照の確かめ：the "存在しない節" section of `dg guide work` を見る。',
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(/docs\/development\.md:\d+: dg guide work に節「存在しない節」がない/);
  });

  it("切れた英語の参照を直すと、その指摘は出ない", async () => {
    await append(
      "docs/development.md",
      '切れた参照の確かめ：the "存在しない節" section of `dg guide work` を見る。',
    );
    await rewrite("docs/development.md", /存在しない節/, "Flow");
    const { stderr } = await run();
    expect(stderr).not.toMatch(/dg guide [a-z-]+ に節「.+」がない/);
  });

  it("英語の参照は「(…)」の補足を除いた名前で照らし、バッククォートのない形も拾う", async () => {
    await append(
      "docs/development.md",
      '英語の確かめ：the "Return" (Review) section of dg guide review と、the "存在しない節" section of dg guide work を見る。',
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("dg guide work に節「存在しない節」がない");
    expect(stderr).not.toContain("dg guide review に節「Return」がない");
  });

  it(".ts のテンプレート文字列（\\` のエスケープ）の英語の切れた参照は、場所を出して落ちる", async () => {
    await writeFile(
      join(dir, PROBE),
      'export const s = `Follow the "存在しない節" section of \\`dg guide work\\`.`;\n',
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(`${PROBE}:1: dg guide work に節「存在しない節」がない`);
  });

  it("英語の参照の guide の無いトピックは、guide のファイルがないと落ちる", async () => {
    await writeFile(join(dir, PROBE), 'export const s = `the "流れ" section of dg guide nope`;\n');
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /zz-probe\.ts:1: dg guide nope の guide-nope\.md がない（「流れ」を指す）/,
    );
  });
});

describe("check-docs の要件の 1 項の上限（t580）", () => {
  const REQ = "docs/requirements.md";
  // TK-1 の項の 1 行目を、記号「- 」を含めてちょうど chars 字になるように置き換え、continuation を後ろにつける
  async function setTk1(chars: number, continuation = ""): Promise<void> {
    const head = "- TK-1 ";
    await rewrite(REQ, /^- TK-1 .*$/m, `${head}${"あ".repeat(chars - head.length)}${continuation}`);
  }

  it("写したままなら上限の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("上限の 250 字を超えている");
  });

  it("251 字の項は、行と ID と字数を出して落ちる", async () => {
    await setTk1(251);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /docs\/requirements\.md:\d+: 要件 TK-1 の 1 項が 251 字で、上限の 250 字を超えている/,
    );
  });

  it("ちょうど 250 字の項は指摘しない", async () => {
    await setTk1(250);
    const { stderr } = await run();
    expect(stderr).not.toContain("上限の 250 字を超えている");
  });

  it("項の下の字下げした行も、字下げと改行を含めて合計して数える", async () => {
    // 1 行目 200 字＋改行 1 字＋字下げ 2 字＋本文 48 字＝251 字（字下げと改行を除けば 248 字で上限の内）
    await setTk1(200, `\n  ${"い".repeat(48)}`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("要件 TK-1 の 1 項が 251 字で");
  });

  it("字下げと改行を含めてちょうど 250 字の項は指摘しない", async () => {
    // 1 行目 200 字＋改行 1 字＋字下げ 2 字＋本文 47 字＝250 字
    await setTk1(200, `\n  ${"い".repeat(47)}`);
    const { stderr } = await run();
    expect(stderr).not.toContain("上限の 250 字を超えている");
  });

  it("リンクの記法も字数に含める", async () => {
    // 1 行目 230 字＋空白 1 字＋リンクの記法 20 字＝251 字（リンクの文字「ADR」だけなら 234 字で上限の内）
    await setTk1(230, " [ADR](adr/README.md)");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain("要件 TK-1 の 1 項が 251 字で");
  });

  it("ID のない前文と箇条書きは、長くても数えない", async () => {
    const req = join(dir, REQ);
    await writeFile(
      req,
      `${await readFile(req, "utf8")}\n${"う".repeat(300)}\n\n- ${"え".repeat(300)}\n`,
    );
    const { stderr } = await run();
    expect(stderr).not.toContain("上限の 250 字を超えている");
  });
});

describe("check-docs の置き換え済みの ADR への参照（t580）", () => {
  const PROBE = "packages/cli/src/zz-probe.ts";

  // 本リポジトリの docs/adr には置き換え済みの ADR を残さないので、一時ディレクトリに 1 本だけ置き、一覧に載せる
  beforeEach(async () => {
    await writeFile(
      join(dir, "docs/adr", OLD_FILE),
      `# ${OLD_ADR} 旧\n\n- ステータス：置き換え（ADR-028）\n`,
    );
    await appendFile(join(dir, "docs/adr/README.md"), `\n| [${OLD_ADR}](${OLD_FILE}) | 旧 |\n`);
  });

  it("写したままなら置き換え済みの ADR の指摘は出ない", async () => {
    const { stderr } = await run();
    expect(stderr).not.toContain("置き換え済みの ADR");
  });

  it("コメント・テスト名・文字列の置き換え済みの ADR は、ファイルと行と置き換えた先を出して落ちる", async () => {
    await writeFile(
      join(dir, PROBE),
      [
        "export {};",
        `// 理由は ${OLD_ADR}`,
        `it("${OLD_ADR} のとおり動く", () => {});`,
        `export const s = "${OLD_ADR}";`,
        "",
      ].join("\n"),
    );
    const { code, stderr } = await run();
    expect(code).toBe(1);
    for (const line of [2, 3, 4]) {
      expect(stderr).toContain(
        `${PROBE}:${line}: 置き換え済みの ${OLD_ADR} を指している（今の判断は ADR-028）`,
      );
    }
  });

  it("test の下のファイルの参照も落ちる", async () => {
    const probe = "test/zz-probe.test.ts";
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(join(dir, probe), `// ${OLD_ADR} の確かめ\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(`${probe}:1: 置き換え済みの ${OLD_ADR} を指している`);
  });

  it("置き換えていない ADR の参照は指摘しない", async () => {
    await writeFile(join(dir, PROBE), "// 理由は ADR-028\nexport const s = 'ADR-008';\n");
    const { stderr } = await run();
    expect(stderr).not.toContain("置き換え済みの ADR");
  });

  it("置き換え済みかは ADR のステータスから読み、ステータスを置き換えにした ADR の参照も落ちる", async () => {
    await rewrite(ADR, /^- ステータス：.*$/m, "- ステータス：置き換え（ADR-024）");
    await writeFile(join(dir, PROBE), "// 理由は ADR-008\nexport {};\n");
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      `${PROBE}:1: 置き換え済みの ADR-008 を指している（今の判断は ADR-024）`,
    );
  });

  it("置き換えた先もさらに置き換え済みなら、置き換え済みでなくなるまでたどった番号を出す", async () => {
    // 004 → 028 → 024 とたどる
    await rewrite(
      "docs/adr/ADR-028-agents-and-state.md",
      /^- ステータス：.*$/m,
      "- ステータス：置き換え（ADR-024）",
    );
    await writeFile(join(dir, PROBE), `// 理由は ${OLD_ADR}\nexport {};\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      `${PROBE}:1: 置き換え済みの ${OLD_ADR} を指している（今の判断は ADR-024）`,
    );
  });

  it("置き換えが輪になったら止まり、今の判断の番号を出さない", async () => {
    // 004 → 028 → 004 と輪になる
    await rewrite(
      "docs/adr/ADR-028-agents-and-state.md",
      /^- ステータス：.*$/m,
      `- ステータス：置き換え（${OLD_ADR}）`,
    );
    await writeFile(join(dir, PROBE), `// 理由は ${OLD_ADR}\nexport {};\n`);
    const { code, stderr } = await run();
    expect(code).toBe(1);
    expect(stderr).toContain(
      `${PROBE}:1: 置き換え済みの ${OLD_ADR} を指している（今の判断の ADR を指す）`,
    );
  });

  it("docs の文書と ADR の本文の置き換え済みの ADR は指摘しない", async () => {
    const dev = join(dir, "docs/development.md");
    await writeFile(dev, `${await readFile(dev, "utf8")}\n経緯は ${OLD_ADR} にある。\n`);
    const adr = join(dir, ADR);
    await writeFile(adr, `${await readFile(adr, "utf8")}\n前の判断は ${OLD_ADR} にある。\n`);
    const { stderr } = await run();
    expect(stderr).not.toContain("置き換え済みの ADR");
  });
});
