import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema, type Config } from "../model/config.js";
import { guideSectionText, readGuide, readGuideNotes } from "./guide.js";

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

    const section = await guideSectionText("work", "claim の前後", config, root);
    const sectionLines = section.text.split("\n");
    expect(sectionLines[0]).toBe("## claim の前後");
    expect(sectionLines[2]).toBe("作業の判断の基準を書く");
    expect(section.warnings).toEqual([]);
  });

  it("ファイルがなければ警告を返し、guide は差し込まずに出す", async () => {
    const config = configWith({ work: "missing.md" });
    const notes = await readGuideNotes("work", config, root);
    expect(notes.text).toBe("");
    expect(notes.warnings).toHaveLength(1);
    expect(notes.warnings[0]).toContain("guide.notes.work");

    expect(await readGuide("work", notes.text)).toBe(await readGuide("work"));
    const section = await guideSectionText("work", "claim の前後", config, root);
    expect(section.text).toBe(
      (await guideSectionText("work", "claim の前後", configSchema.parse({}), root)).text,
    );
    expect(section.warnings).toHaveLength(1);
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
});
