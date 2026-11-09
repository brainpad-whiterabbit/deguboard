import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema, type Config } from "../model/config.js";
import { composeGuide, readGuide, readGuideNotes } from "./guide.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dg-guide-notes-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** guide.notes だけを設定した config */
function configWith(notes: Record<string, string>): Config {
  return configSchema.parse({ guide: { notes } });
}

describe("guide.notes の文書の差し込み（CL-5）", () => {
  it("設定がなければ何も差し込まず、警告もない", async () => {
    expect(await readGuideNotes("work", configSchema.parse({}), root)).toEqual({
      text: "",
      warnings: [],
    });
  });

  it("リポジトリ内のファイルは題名の直後に差し込み、節を出すときは節の見出しの直後に差し込む", async () => {
    await writeFile(join(root, "work-notes.md"), "作業の判断の基準を書く\n");
    const config = configWith({ work: "work-notes.md" });
    const notes = await readGuideNotes("work", config, root);
    expect(notes).toEqual({ text: "作業の判断の基準を書く", warnings: [] });

    // 題名（1 行目）の次の空行を挟んで、差し込んだ文が 3 行目に来る
    const lines = (await readGuide("work", notes.text)).split("\n");
    expect(lines[0]).toBe("# 作業（work）");
    expect(lines[2]).toBe("作業の判断の基準を書く");

    const section = await composeGuide("work", config, root, "claim の前後");
    const sectionLines = section.text.split("\n");
    expect(sectionLines[0]).toBe("## claim の前後");
    expect(sectionLines[2]).toBe("作業の判断の基準を書く");
    expect(section.warnings).toEqual([]);

    // 節を重ねると指定した順につなぎ、差し込みは最初の節の見出しの直後に 1 度だけ
    const both = await composeGuide("work", config, root, ["claim の前後", "流れ"]);
    expect(both.sections).toEqual(["claim の前後", "流れ"]);
    expect(both.section).toBe("claim の前後");
    expect(both.text.split("\n")[2]).toBe("作業の判断の基準を書く");
    expect(both.text.split("作業の判断の基準を書く")).toHaveLength(2);
    expect(both.text.indexOf("## 流れ")).toBeGreaterThan(both.text.indexOf("## claim の前後"));
  });

  it("ファイルがなければ警告を返し、guide は差し込まずに出す", async () => {
    const config = configWith({ work: "missing.md" });
    const notes = await readGuideNotes("work", config, root);
    expect(notes.text).toBe("");
    expect(notes.warnings).toHaveLength(1);
    expect(notes.warnings[0]).toContain("guide.notes.work");

    expect(await readGuide("work", notes.text)).toBe(await readGuide("work"));
    const section = await composeGuide("work", config, root, "claim の前後");
    expect(section.text).toBe(
      (await composeGuide("work", configSchema.parse({}), root, "claim の前後")).text,
    );
    expect(section.warnings).toHaveLength(1);
  });

  it("トピック全体は題名の直後に差し込み、節を指さないので section は null", async () => {
    await writeFile(join(root, "work-notes.md"), "作業の判断の基準を書く\n");
    const whole = await composeGuide("work", configWith({ work: "work-notes.md" }), root);
    expect(whole.section).toBeNull();
    expect(whole.topic).toBe("work");
    expect(whole.text.split("\n")[2]).toBe("作業の判断の基準を書く");
    expect(whole.warnings).toEqual([]);
  });

  it("リポジトリの外を指すパスは読まず、警告を返す", async () => {
    for (const rel of ["../outside.md", "/etc/hosts", "."]) {
      const notes = await readGuideNotes("work", configWith({ work: rel }), root);
      expect(notes.text, rel).toBe("");
      expect(notes.warnings[0], rel).toContain("guide.notes.work");
    }
  });

  it("見出し（#）を含むファイルは差し込まず、警告を返す", async () => {
    await writeFile(join(root, "bad.md"), "判断\n## 見出し\n");
    const notes = await readGuideNotes("work", configWith({ work: "bad.md" }), root);
    expect(notes.text).toBe("");
    expect(notes.warnings[0]).toContain("見出し（#）");
  });

  it("トピックごとに別のファイルを指せ、指していないトピックには差し込まない", async () => {
    await writeFile(join(root, "plan.md"), "計画の基準\n");
    const config = configWith({ plan: "plan.md" });
    expect((await readGuideNotes("plan", config, root)).text).toBe("計画の基準");
    expect(await readGuideNotes("work", config, root)).toEqual({ text: "", warnings: [] });
  });

  it("リポジトリの最上位を指すパスは、外ではなく最上位だと警告する", async () => {
    const notes = await readGuideNotes("work", configWith({ work: "." }), root);
    expect(notes.warnings[0]).toContain("最上位");
    expect(notes.warnings[0]).not.toContain("外を指す");
  });

  it("symlink の先がリポジトリの外なら読まずに警告を返す（相対パスの指定でも同じ）", async () => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(root, "secret.txt"), "秘密\n");
    await symlink("../secret.txt", join(repo, "link.md"));
    const notes = await readGuideNotes("review", configWith({ review: "link.md" }), repo);
    expect(notes.text).toBe("");
    expect(notes.warnings[0]).toContain("guide.notes.review");
    expect(notes.warnings[0]).toContain("外を指す");
  });

  it("symlink の先がリポジトリの中なら、その文書を差し込む", async () => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "real.md"), "判断の基準\n");
    await symlink("real.md", join(repo, "link.md"));
    const notes = await readGuideNotes("review", configWith({ review: "link.md" }), repo);
    expect(notes).toEqual({ text: "判断の基準", warnings: [] });
  });

  it("通常のファイルでないもの（ディレクトリ）と大きすぎるファイルは差し込まず、警告を返す", async () => {
    const repo = join(root, "repo");
    await mkdir(join(repo, "dir"), { recursive: true });
    const dir = await readGuideNotes("work", configWith({ work: "dir" }), repo);
    expect(dir.text).toBe("");
    expect(dir.warnings[0]).toContain("通常のファイルでない");

    await writeFile(join(repo, "big.md"), "x".repeat(64 * 1024 + 1));
    const big = await readGuideNotes("work", configWith({ work: "big.md" }), repo);
    expect(big.text).toBe("");
    expect(big.warnings[0]).toContain("KiB");
  });

  it("見出しの検査はコードブロックの外だけを見る", async () => {
    await writeFile(join(root, "code.md"), "判断\n```sh\n# シェルのコメント\n```\n");
    const notes = await readGuideNotes("work", configWith({ work: "code.md" }), root);
    expect(notes).toEqual({ text: "判断\n```sh\n# シェルのコメント\n```", warnings: [] });
  });
});
