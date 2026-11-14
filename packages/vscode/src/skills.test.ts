import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSkills, refreshInstalledSkills } from "@deguboard/core";
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
import { skillRefreshNotices } from "./skills.js";

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
