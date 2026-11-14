import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSkills,
  findMissingSkills,
  installMissingSkills,
  refreshInstalledSkills,
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
  missingSkillAction,
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
        scope: "project",
        dir: skillsDir(repo.dir),
        names: rest,
        text: `These dg Skills bundled with this extension are not installed in ${skillsDir(repo.dir)}, where other dg Skills are: ${rest.join(", ")}`,
      },
      {
        scope: "personal",
        dir: skillsDir(home),
        names: rest,
        text: `These dg Skills bundled with this extension are not installed in ${skillsDir(home)}, where other dg Skills are: ${rest.join(", ")}`,
      },
    ]);

    // Install（拡張は案内の names を渡す）。手を加えた Skill はそのまま
    const result = await installMissingSkills(notices[0]!, { names: notices[0]!.names, skills });
    expect(result.written).toEqual(rest);
    expect(await readFile(skillFileOf(repo.dir, "dgwork"), "utf8")).toBe(edited);
    expect(await readdir(skillsDir(repo.dir))).not.toContain("dgplan");
    for (const name of rest)
      expect(await readFile(skillFileOf(repo.dir, name), "utf8")).toBe(
        skills.find((s) => s.name === name)!.content,
      );
  });

  it("リポジトリの置き場所に Install すると、書いた Skill ごとの無視の行を .claude/.gitignore に足し、既にある行は重ねない（t926）", async () => {
    const repo = await createLocalOnlyRepo();
    cleanups.push(repo.cleanup);
    const home = await tempDir();
    const skills = await buildSkills();
    await putSkill(repo.dir, "dgwork", (await contentOf("dgwork")).content);
    const rest = skills.map((s) => s.name).filter((n) => n !== "dgwork");
    const ignoreFile = path.join(repo.dir, ".claude", ".gitignore");
    // 利用者の行と、dg skill install が前に足した行（rest の 1 つ目）がある
    await writeFile(ignoreFile, `mine\nskills/${rest[0]}/\n`, "utf8");

    const [notice] = missingSkillNotices(
      await findMissingSkills({ folders: [repo.dir], env: { HOME: home } }),
      [],
    );
    expect(notice!.scope).toBe("project");
    const result = await installMissingSkills(notice!, { names: notice!.names, skills });
    expect(result.written).toEqual(rest);
    expect(result.ignoreFile).toBe(ignoreFile);
    expect(await readFile(ignoreFile, "utf8")).toBe(
      `mine\nskills/${rest[0]}/\n${rest
        .slice(1)
        .map((n) => `skills/${n}/\n`)
        .join("")}`,
    );
    // 書かなかった Skill（入れてあった dgwork）の行は足さない
    expect(await readFile(ignoreFile, "utf8")).not.toContain("skills/dgwork/");
  });

  it("個人の置き場所に Install するときは .gitignore を書かない（t926）", async () => {
    const home = await tempDir();
    const skills = await buildSkills();
    await putSkill(home, "dgwork", (await contentOf("dgwork")).content);

    const [notice] = missingSkillNotices(
      await findMissingSkills({ folders: [], env: { HOME: home } }),
      [],
    );
    expect(notice!.scope).toBe("personal");
    const result = await installMissingSkills(notice!, { names: notice!.names, skills });
    expect(result.written.length).toBeGreaterThan(0);
    expect(result.ignoreFile).toBeNull();
    expect(await readdir(path.join(home, ".claude"))).toEqual(["skills"]);
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

  it("通知のボタンの選択から、Install は案内した名前を書き、Don't show again は覚えた名前に足し、閉じたら何もしない", () => {
    const buttons = { install: "Install", never: "Don't show again" };
    const notice = { names: ["dgwork", "dgnew"] };
    expect(missingSkillAction("Install", buttons, notice, ["dgplan"])).toEqual({
      kind: "install",
      names: ["dgwork", "dgnew"],
    });
    expect(missingSkillAction("Don't show again", buttons, notice, ["dgplan", "dgwork"])).toEqual({
      kind: "dismiss",
      dismissed: ["dgplan", "dgwork", "dgnew"],
    });
    // 壊れた値は覚えていないものとして、案内した名前だけを覚える
    expect(missingSkillAction("Don't show again", buttons, notice, "broken")).toEqual({
      kind: "dismiss",
      dismissed: ["dgwork", "dgnew"],
    });
    expect(missingSkillAction(undefined, buttons, notice, ["dgplan"])).toEqual({ kind: "none" });
  });
});
