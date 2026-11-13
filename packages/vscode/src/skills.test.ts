import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildSkills } from "@deguboard/core";
import { afterEach, describe, expect, it } from "vitest";
import { format, setTranslator } from "./l10n.js";
import { refreshSkillsOf, skillRefreshNotices } from "./skills.js";

// 文言は鍵（英語）で確かめる。日本語の訳があることは l10n.test.ts が確かめる
setTranslator((message, ...args) => format(message, args));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-vscode-skills-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const MARKER = /<!-- dg skill sha256:[0-9a-f]{64} -->\n/;

/** 前の版の dg が入れたままの Skill（本文が今と違い、印はその本文のハッシュと合う） */
function olderVersionOf(content: string): string {
  const changed = content.replace("This Skill holds no steps.", "This Skill has no steps.");
  const hash = createHash("sha256").update(changed.replace(MARKER, "")).digest("hex");
  return changed.replace(MARKER, `<!-- dg skill sha256:${hash} -->\n`);
}

const skillsDir = (base: string) => path.join(base, ".claude", "skills");
const contentOf = async (name: string) => (await buildSkills()).find((s) => s.name === name)!;

async function put(base: string, name: string, content: string): Promise<void> {
  const file = path.join(skillsDir(base), name, "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

describe("拡張の起動時の dg の Skill の更新（t857）", () => {
  it("作業フォルダのリポジトリと ~/.claude/skills の古い Skill を更新し、個人の置き場所は 1 つにまとめる", async () => {
    const repo = await tempDir();
    await promisify(execFile)("git", ["init", "-q", repo]);
    const outside = await tempDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");
    await put(repo, "dgwork", olderVersionOf(work.content));
    const edited = `${olderVersionOf(plan.content)}\nmy note\n`;
    await put(home, "dgplan", edited);

    const refreshed = await refreshSkillsOf([repo, outside], { HOME: home });
    expect(refreshed).toEqual([
      { scope: "project", dir: skillsDir(repo), updated: ["dgwork"], edited: [] },
      { scope: "personal", dir: skillsDir(home), updated: [], edited: ["dgplan"] },
    ]);
    expect(await readFile(path.join(skillsDir(repo), "dgwork", "SKILL.md"), "utf8")).toBe(
      work.content,
    );
    // 手で直したものは書き換えない
    expect(await readFile(path.join(skillsDir(home), "dgplan", "SKILL.md"), "utf8")).toBe(edited);
    // リポジトリの外のフォルダには書かず、入れていない Skill も足さない
    await expect(readdir(path.join(outside, ".claude"))).rejects.toThrow();
    expect(await readdir(skillsDir(repo))).toEqual(["dgwork"]);

    expect(skillRefreshNotices(refreshed)).toEqual([
      {
        level: "info",
        text: `Updated the dg Skills in ${skillsDir(repo)} to the ones bundled with this extension: dgwork`,
      },
      {
        level: "warning",
        text: `These dg Skills in ${skillsDir(home)} are older than the ones bundled with this extension, but they were edited by hand, so they were not changed: dgplan. To overwrite them, run dg skill install --personal --force`,
      },
    ]);
  });

  it("変えるものがなければ通知しない。作業フォルダがなくても個人の置き場所は見る", async () => {
    const home = await tempDir();
    const work = await contentOf("dgwork");
    await put(home, "dgwork", work.content);
    expect(skillRefreshNotices(await refreshSkillsOf([], { HOME: home }))).toEqual([]);
    await put(home, "dgwork", olderVersionOf(work.content));
    expect(await refreshSkillsOf([], { HOME: home })).toEqual([
      { scope: "personal", dir: skillsDir(home), updated: ["dgwork"], edited: [] },
    ]);
  });
});
