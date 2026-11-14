import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSkills,
  findMissingSkills,
  refreshInstalledSkills,
  writeSkillFiles,
} from "@deguboard/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import {
  newerThan,
  olderVersionOf,
  putSkill,
  skillFileOf,
  skillsDir,
  skillVersionOf,
  skillWrittenBy,
} from "../../core/test/helpers/skills.js";
import { format, setTranslator } from "./l10n.js";
import {
  dismissedAfter,
  dismissedSkillsOf,
  missingSkillNotices,
  skillRefreshNotices,
} from "./skills.js";

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

const contentOf = async (name: string) => (await buildSkills()).find((s) => s.name === name)!;

// 作業フォルダのまとめと置き場所の重複の除き方は core の skill-files.test.ts が確かめる。ここは core の結果から作る通知の文を確かめる
describe("拡張の起動時の dg の Skill の更新の通知（t857）", () => {
  it("core が更新したもの（info）と、手を加えたので残したもの（warning）を、置き場所ごとに知らせる", async () => {
    const repo = await createLocalOnlyRepo();
    cleanups.push(repo.cleanup);
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");
    await putSkill(repo.dir, "dgwork", olderVersionOf(work.content));
    const edited = `${olderVersionOf(plan.content)}\nmy note\n`;
    await putSkill(home, "dgplan", edited);

    const refreshed = await refreshInstalledSkills({ folders: [repo.dir], env: { HOME: home } });
    expect(await readFile(skillFileOf(repo.dir, "dgwork"), "utf8")).toBe(work.content);
    expect(await readFile(skillFileOf(home, "dgplan"), "utf8")).toBe(edited);
    expect(skillRefreshNotices(refreshed)).toEqual([
      {
        level: "info",
        text: `Updated the dg Skills in ${skillsDir(repo.dir)} that were older than this extension to the ones bundled with it: dgwork`,
      },
      {
        level: "warning",
        text: `These dg Skills in ${skillsDir(home)} are older than the ones bundled with this extension, but they were edited by hand, so they were not changed: dgplan. To overwrite them, run dg skill install --personal --force`,
      },
    ]);
  });

  it("拡張より新しい dg が書いた Skill は上書きせず、通知もしない（t864）", async () => {
    const repo = await createLocalOnlyRepo();
    cleanups.push(repo.cleanup);
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const newer = skillWrittenBy(work.content, newerThan(skillVersionOf(work.content)));
    await putSkill(repo.dir, "dgwork", newer);
    await putSkill(home, "dgwork", `${newer}\nmy note\n`);

    const refreshed = await refreshInstalledSkills({ folders: [repo.dir], env: { HOME: home } });
    expect(await readFile(skillFileOf(repo.dir, "dgwork"), "utf8")).toBe(newer);
    expect(skillRefreshNotices(refreshed)).toEqual([]);
  });

  it("変えるものがなければ通知しない", async () => {
    const home = await tempDir();
    await putSkill(home, "dgwork", (await contentOf("dgwork")).content);
    const refreshed = await refreshInstalledSkills({ folders: [], env: { HOME: home } });
    expect(skillRefreshNotices(refreshed)).toEqual([]);
  });
});

// 足りない Skill の数え方（置き場所・agent のまとめ方）は core の skill-files.test.ts が確かめる。ここは案内の文と、Install・Don't show again の結果を確かめる
describe("拡張の起動時の、入れていない同梱の Skill の案内（t923）", () => {
  it("置き場所ごとに 1 件、置き場所と Skill の名前を並べて案内し、Install は足りない Skill だけを書く", async () => {
    const repo = await createLocalOnlyRepo();
    cleanups.push(repo.cleanup);
    const home = await tempDir();
    const skills = await buildSkills();
    const edited = `${(await contentOf("dgwork")).content}\nmy note\n`;
    await putSkill(repo.dir, "dgwork", edited);
    await putSkill(home, "dgplan", (await contentOf("dgplan")).content);
    const rest = skills.map((s) => s.name).filter((n) => n !== "dgwork" && n !== "dgplan");

    const notices = missingSkillNotices(
      await findMissingSkills({ folders: [repo.dir], env: { HOME: home } }),
      [],
    );
    expect(notices).toEqual([
      {
        dir: skillsDir(repo.dir),
        names: rest,
        text: `These dg Skills bundled with this extension are not installed in ${skillsDir(repo.dir)}, where other dg Skills are: ${rest.join(", ")}`,
      },
      {
        dir: skillsDir(home),
        names: rest,
        text: `These dg Skills bundled with this extension are not installed in ${skillsDir(home)}, where other dg Skills are: ${rest.join(", ")}`,
      },
    ]);

    // Install（拡張は案内の names を渡す）。手を加えた Skill はそのまま
    const result = await writeSkillFiles(notices[0]!.dir, {
      force: false,
      names: notices[0]!.names,
      skills,
    });
    expect(result.written).toEqual(rest);
    expect(await readFile(skillFileOf(repo.dir, "dgwork"), "utf8")).toBe(edited);
    expect(await readdir(skillsDir(repo.dir))).not.toContain("dgplan");
    for (const name of rest)
      expect(await readFile(skillFileOf(repo.dir, name), "utf8")).toBe(
        skills.find((s) => s.name === name)!.content,
      );
  });

  it("Don't show again で覚えた名前は案内せず、別の名前の Skill が増えたときは案内する", async () => {
    const dir = "/skills";
    const found = [{ scope: "personal" as const, dir, missing: ["dgwork", "dgplan"] }];
    const dismissed = dismissedAfter(undefined, ["dgwork", "dgplan"]);
    expect(dismissed).toEqual(["dgwork", "dgplan"]);
    expect(missingSkillNotices(found, dismissedSkillsOf(dismissed))).toEqual([]);

    const grown = [{ ...found[0]!, missing: ["dgwork", "dgplan", "dgnew"] }];
    expect(missingSkillNotices(grown, dismissed).map((n) => n.names)).toEqual([["dgnew"]]);
    // 前に覚えた名前に足す。壊れた値は覚えていないものとして扱う
    expect(dismissedAfter(dismissed, ["dgnew", "dgwork"])).toEqual(["dgwork", "dgplan", "dgnew"]);
    expect(dismissedSkillsOf("broken")).toEqual([]);
    expect(dismissedSkillsOf(["dgwork", 3])).toEqual(["dgwork"]);
  });
});
