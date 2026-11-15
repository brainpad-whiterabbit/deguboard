// ignore-lines.ts の ensureIgnoreLines を直接確かめる（t805）。dg skill install・dg hooks install と拡張の Install のテストは入れる流れを通してだけ見るので、
// 行が重ならないことと、末尾に改行のない .gitignore に足す場合をここで見る。追跡済みのファイルの検出（trackedFiles）も見る（t1003）

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import { ensureIgnoreLines, trackedFiles } from "./ignore-lines.js";
import { runGit } from "./run.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "deguboard-gitignore-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("trackedFiles", () => {
  it("ファイルとディレクトリの下の、追跡しているファイルだけを最上位からの相対パスで返す（無視の行より前に追跡したものも）", async () => {
    const fixture = await createFixture();
    try {
      const top = fixture.cloneA;
      const claude = path.join(top, ".claude");
      await mkdir(path.join(claude, "skills", "dg 作業"), { recursive: true });
      await writeFile(path.join(claude, "settings.local.json"), "{}\n");
      await writeFile(path.join(claude, "skills", "dg 作業", "SKILL.md"), "# x\n");
      await writeFile(path.join(claude, "skills", "untracked.md"), "# y\n");
      expect(await trackedFiles(top, claude)).toEqual([]);

      await ensureIgnoreLines(path.join(claude, ".gitignore"), ["settings.local.json"]);
      await runGit(top, ["add", "-f", ".claude/settings.local.json", ".claude/skills/dg 作業"]);
      expect(await trackedFiles(top, path.join(claude, "settings.local.json"))).toEqual([
        ".claude/settings.local.json",
      ]);
      // 空白や ASCII でない名前も、引用やエスケープをせずにそのまま返す
      expect(await trackedFiles(top, path.join(claude, "skills"))).toEqual([
        ".claude/skills/dg 作業/SKILL.md",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("ensureIgnoreLines", () => {
  it("ファイルが無いときは、親のディレクトリを作って渡した順に書く", async () => {
    const file = path.join(dir, ".claude", ".gitignore");
    expect(await ensureIgnoreLines(file, ["a", "b"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a\nb\n");
  });

  it("すでにある行（前後の空白を除いて一致・CRLF の行も）は書かず、利用者の行を残す", async () => {
    const file = path.join(dir, ".gitignore");
    await writeFile(file, "mine\r\n  a  \r\n", "utf8");
    expect(await ensureIgnoreLines(file, ["a", "b"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("mine\r\n  a  \r\nb\n");
  });

  it("渡した行の中で同じ行が重なっても 1 回だけ書く", async () => {
    const file = path.join(dir, ".gitignore");
    expect(await ensureIgnoreLines(file, ["a", "b", "a"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a\nb\n");
  });

  it("2 回呼んでも行は重ならず、2 回目は書かずに false を返す", async () => {
    const file = path.join(dir, ".gitignore");
    await ensureIgnoreLines(file, ["a", "b"]);
    expect(await ensureIgnoreLines(file, ["b", "a"])).toBe(false);
    expect(await readFile(file, "utf8")).toBe("a\nb\n");
  });

  it("末尾に改行のないファイルには、改行を足してから行を書く", async () => {
    const file = path.join(dir, ".gitignore");
    await writeFile(file, "mine", "utf8");
    expect(await ensureIgnoreLines(file, ["a"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("mine\na\n");
  });

  it("空のファイルには、頭に改行を付けずに書く", async () => {
    const file = path.join(dir, ".gitignore");
    await writeFile(file, "", "utf8");
    expect(await ensureIgnoreLines(file, ["a"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a\n");
  });
});
