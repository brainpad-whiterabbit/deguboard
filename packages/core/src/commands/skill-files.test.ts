import { access, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, createLocalOnlyRepo } from "../../test/helpers/git-fixture.js";
import {
  newerThan,
  olderVersionOf,
  putSkill as put,
  SKILL_MARKER as MARKER,
  skillsDir,
  skillVersionOf,
  skillWrittenBy,
} from "../../test/helpers/skills.js";
import * as guide from "../guide/guide.js";
import { GUIDE_TOPICS } from "../guide/topics.js";
import { brief } from "./brief.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { next } from "./next.js";
import { init } from "./setup.js";
import {
  buildSkills,
  findStaleSkills,
  refreshInstalledSkills,
  skillAgeOf,
  skillStateOf,
  staleSkillWarnings,
  staleSkillWarningsOf,
} from "./skill-files.js";
import { ticketCreate } from "./ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-skills-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** リモートのないリポジトリ（作業フォルダ）。Skill の置き場所はその最上位の下 */
async function repoDir(): Promise<string> {
  const repo = await createLocalOnlyRepo();
  cleanups.push(repo.cleanup);
  return repo.dir;
}

const contentOf = async (name: string) => (await buildSkills()).find((s) => s.name === name)!;

/** findStaleSkills の 1 つの置き場所の、名前のない分け方（要るものだけを上書きして使う） */
const NONE = { stale: [], edited: [], sameVersion: [], sameVersionEdited: [] };

describe("入れてある dg の Skill が今の dg のものと違うかの判定（AG-2・t858）", () => {
  it("skillStateOf は、ない・同じ・手を加えていない古いもの・手を加えたものを分ける", async () => {
    const skill = await contentOf("dgwork");
    expect(skillStateOf(undefined, skill)).toBe("missing");
    expect(skillStateOf(skill.content, skill)).toBe("current");
    expect(skillStateOf(olderVersionOf(skill.content), skill)).toBe("stale");
    expect(skillStateOf(`${skill.content}\nmy note\n`, skill)).toBe("edited");
    // 印を消したものは、手を加えたものとして扱う
    expect(skillStateOf(skill.content.replace(MARKER, ""), skill)).toBe("edited");
  });

  it("入れていない Skill と今の dg と同じ Skill は数えず、警告も出さない", async () => {
    const top = await tempDir();
    const home = await tempDir();
    expect(await findStaleSkills({ topLevel: top, env: { HOME: home } })).toEqual([]);
    for (const skill of await buildSkills()) await put(top, skill.name, skill.content);
    await put(home, "dgplan", (await contentOf("dgplan")).content);
    // 利用者が自分で作った Skill は見ない
    await put(top, "dgmine", "# mine\n");
    expect(await findStaleSkills({ topLevel: top, env: { HOME: home } })).toEqual([]);
    expect(await staleSkillWarningsOf(top, { HOME: home })).toEqual([]);
  });

  it("リポジトリと ~/.claude/skills の古い Skill を置き場所ごとに返し、手を加えたものは分ける", async () => {
    const top = await tempDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");
    const done = await contentOf("dgdone");
    await put(top, "dgwork", olderVersionOf(work.content));
    await put(top, "dgplan", `${olderVersionOf(plan.content)}\nmy note\n`);
    await put(top, "dgdone", done.content);
    await put(home, "dgdone", olderVersionOf(done.content));

    const found = await findStaleSkills({ topLevel: top, env: { HOME: home } });
    expect(found).toEqual([
      { scope: "project", dir: skillsDir(top), ...NONE, stale: ["dgwork"], edited: ["dgplan"] },
      { scope: "personal", dir: skillsDir(home), ...NONE, stale: ["dgdone"] },
    ]);
    expect(staleSkillWarnings(found)).toEqual([
      `These dg Skills in ${skillsDir(top)} are older than this dg (an older version of dg wrote them): dgwork. Update them with dg skill install`,
      `These dg Skills in ${skillsDir(top)} are older than this dg and were edited by hand, so dg skill install keeps them: dgplan. To overwrite them with the current Skills, run dg skill install --force`,
      `These dg Skills in ${skillsDir(home)} are older than this dg (an older version of dg wrote them): dgdone. Update them with dg skill install --personal`,
    ]);
    // リポジトリの外（topLevel なし）では個人の置き場所だけを見る
    expect(await findStaleSkills({ env: { HOME: home } })).toEqual([found[1]]);
  });

  it("今の版をもとに手を加えた Skill（印が今の dg のものと同じ）は古くないので数えない。印を消したものは数える", async () => {
    const top = await tempDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");
    await put(top, "dgwork", `${work.content}\nmy note\n`);
    await put(top, "dgplan", plan.content.replace(MARKER, ""));
    expect(await findStaleSkills({ topLevel: top, env: { HOME: home } })).toEqual([
      { scope: "project", dir: skillsDir(top), ...NONE, edited: ["dgplan"] },
    ]);
  });
});

describe("Skill の印の版と、今の dg との新旧（AG-2・ADR-030・t864）", () => {
  it("印は書いた dg の版を持つ。版が読めないときは版を書かない", async () => {
    const skill = await contentOf("dgwork");
    const version = skillVersionOf(skill.content);
    expect(skill.content).toMatch(
      new RegExp(`\\n<!-- dg skill v${version.replaceAll(".", "\\.")} sha256:[0-9a-f]{64} -->\\n`),
    );
    const given = (await buildSkills("9.8.7")).find((s) => s.name === "dgwork")!;
    expect(skillVersionOf(given.content)).toBe("9.8.7");
    const unknown = (await buildSkills("")).find((s) => s.name === "dgwork")!;
    expect(unknown.content).toMatch(/\n<!-- dg skill sha256:[0-9a-f]{64} -->\n/);
  });

  it("skillAgeOf は、印の版が今の dg より古いか・同じか・新しいかを返す。版のない印と印のないものは古い", async () => {
    const skill = await contentOf("dgwork");
    const mine = skillVersionOf(skill.content);
    expect(skillAgeOf(skillWrittenBy(skill.content, "0.0.0"), skill)).toBe("older");
    expect(skillAgeOf(skillWrittenBy(skill.content), skill)).toBe("older");
    expect(skillAgeOf(skill.content.replace(MARKER, ""), skill)).toBe("older");
    expect(skillAgeOf(skillWrittenBy(skill.content, mine), skill)).toBe("same");
    expect(skillAgeOf(skillWrittenBy(skill.content, newerThan(mine)), skill)).toBe("newer");
    // 数として比べる（0.10.0 は 0.9.0 より新しい）
    const [at9, at10] = await Promise.all(
      ["0.9.0", "0.10.0"].map(async (v) =>
        (await buildSkills(v)).find((s) => s.name === "dgwork")!,
      ),
    );
    expect(skillAgeOf(at9!.content, at10!)).toBe("older");
    expect(skillAgeOf(at10!.content, at9!)).toBe("newer");
  });

  it("本文が同じで印の版だけが違う Skill は current（古いと知らせず、書き直しもしない）", async () => {
    const top = await tempDir();
    const home = await tempDir();
    const skill = await contentOf("dgwork");
    const older = (await buildSkills("0.0.0")).find((s) => s.name === "dgwork")!;
    expect(older.content).not.toBe(skill.content);
    expect(skillStateOf(older.content, skill)).toBe("current");
    await put(top, "dgwork", older.content);
    expect(await findStaleSkills({ topLevel: top, env: { HOME: home } })).toEqual([]);
  });

  it("警告は、古い版の Skill だけを older と出し、同じ版で中身の違うものは differ と出し、新しい版のものは出さない", async () => {
    const top = await tempDir();
    const home = await tempDir();
    const mine = skillVersionOf((await contentOf("dgwork")).content);
    const by = async (name: string, version?: string, note = "") =>
      put(top, name, skillWrittenBy((await contentOf(name)).content, version) + note);
    await by("dgwork", "0.0.0");
    await by("dgplan", "0.0.0", "\nmy note\n");
    await by("dgdone", mine);
    await by("dgcheck", mine, "\nmy note\n");
    await by("dgimport", newerThan(mine));
    await by("dgaudit", newerThan(mine), "\nmy note\n");

    const found = await findStaleSkills({ topLevel: top, env: { HOME: home } });
    const dir = skillsDir(top);
    expect(found).toEqual([
      {
        scope: "project",
        dir,
        stale: ["dgwork"],
        edited: ["dgplan"],
        sameVersion: ["dgdone"],
        sameVersionEdited: ["dgcheck"],
      },
    ]);
    expect(staleSkillWarnings(found)).toEqual([
      `These dg Skills in ${dir} are older than this dg (an older version of dg wrote them): dgwork. Update them with dg skill install`,
      `These dg Skills in ${dir} are older than this dg and were edited by hand, so dg skill install keeps them: dgplan. To overwrite them with the current Skills, run dg skill install --force`,
      `These dg Skills in ${dir} differ from the Skills of this dg, though a dg of the same version wrote them (which is newer is unknown): dgdone. To replace them with the Skills of this dg, run dg skill install`,
      `These dg Skills in ${dir} differ from the Skills of this dg (a dg of the same version wrote them) and were edited by hand, so dg skill install keeps them: dgcheck. To overwrite them with the Skills of this dg, run dg skill install --force`,
    ]);
  });
});

describe("VS Code 拡張の起動時の Skill の更新（AG-2・t857）", () => {
  const read = (base: string, name: string) =>
    readFile(path.join(skillsDir(base), name, "SKILL.md"), "utf8");
  const exists = (base: string, name: string) =>
    access(path.join(skillsDir(base), name)).then(
      () => true,
      () => false,
    );

  it("手を加えていない古い Skill を今の dg のもので上書きし、置き場所ごとに更新したものを返す", async () => {
    const top = await repoDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const done = await contentOf("dgdone");
    await put(top, "dgwork", olderVersionOf(work.content));
    await put(home, "dgdone", olderVersionOf(done.content));

    expect(await refreshInstalledSkills({ folders: [top], env: { HOME: home } })).toEqual([
      { scope: "project", dir: skillsDir(top), updated: ["dgwork"], edited: [] },
      { scope: "personal", dir: skillsDir(home), updated: ["dgdone"], edited: [] },
    ]);
    expect(await read(top, "dgwork")).toBe(work.content);
    expect(await read(home, "dgdone")).toBe(done.content);
    // そろったら変えるものはなく、何も返さない（通知しない）
    expect(await refreshInstalledSkills({ folders: [top], env: { HOME: home } })).toEqual([]);
  });

  it("古い版の dg が書いた Skill は、印に版のないものと同じく更新する", async () => {
    const top = await repoDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");
    await put(top, "dgwork", skillWrittenBy(work.content, "0.0.0"));
    await put(top, "dgplan", skillWrittenBy(plan.content));
    expect(await refreshInstalledSkills({ folders: [top], env: { HOME: home } })).toEqual([
      { scope: "project", dir: skillsDir(top), updated: ["dgplan", "dgwork"], edited: [] },
    ]);
    expect(await read(top, "dgwork")).toBe(work.content);
    expect(await read(top, "dgplan")).toBe(plan.content);
  });

  it("新しい版の dg が書いた Skill と、同じ版の dg が書いた中身の違う Skill は、上書きせず知らせもしない（t864）", async () => {
    const top = await repoDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const mine = skillVersionOf(work.content);
    const newer = skillWrittenBy(work.content, newerThan(mine));
    const same = skillWrittenBy((await contentOf("dgplan")).content, mine);
    const newerEdited = `${skillWrittenBy((await contentOf("dgdone")).content, newerThan(mine))}\nmy note\n`;
    await put(top, "dgwork", newer);
    await put(top, "dgplan", same);
    await put(home, "dgdone", newerEdited);

    expect(await refreshInstalledSkills({ folders: [top], env: { HOME: home } })).toEqual([]);
    expect(await read(top, "dgwork")).toBe(newer);
    expect(await read(top, "dgplan")).toBe(same);
    expect(await read(home, "dgdone")).toBe(newerEdited);
  });

  it("拡張が渡した版（version）で新旧を比べる。拡張より新しい dg が書いた Skill は戻さず、拡張より古い dg が書いたものは更新する", async () => {
    const top = await repoDir();
    const home = await tempDir();
    // 今の dg（core の版）が書いた Skill を、それより古い拡張と新しい拡張が見る
    const work = await contentOf("dgwork");
    const mine = skillVersionOf(work.content);
    const written = skillWrittenBy(work.content, mine);
    await put(top, "dgwork", written);
    const query = { folders: [top], env: { HOME: home } };
    expect(await refreshInstalledSkills({ ...query, version: "0.0.0" })).toEqual([]);
    expect(await read(top, "dgwork")).toBe(written);
    expect(await refreshInstalledSkills({ ...query, version: newerThan(mine) })).toEqual([
      { scope: "project", dir: skillsDir(top), updated: ["dgwork"], edited: [] },
    ]);
    expect(skillVersionOf(await read(top, "dgwork"))).toBe(newerThan(mine));
  });

  it("手で直した古い Skill は書き換えずに edited に返す", async () => {
    const top = await repoDir();
    const home = await tempDir();
    const edited = `${olderVersionOf((await contentOf("dgplan")).content)}\nmy note\n`;
    await put(top, "dgplan", edited);
    const expected = [{ scope: "project", dir: skillsDir(top), updated: [], edited: ["dgplan"] }];
    const query = { folders: [top], env: { HOME: home } };
    expect(await refreshInstalledSkills(query)).toEqual(expected);
    expect(await read(top, "dgplan")).toBe(edited);
    // 書き換えないので、次の起動でも同じように知らせる
    expect(await refreshInstalledSkills(query)).toEqual(expected);
  });

  it("dg の Skill を入れていない置き場所には書かず、入れてある置き場所でも入れていない Skill は足さない", async () => {
    const top = await repoDir();
    const home = await tempDir();
    await put(home, "dgwork", olderVersionOf((await contentOf("dgwork")).content));
    await refreshInstalledSkills({ folders: [top], env: { HOME: home } });
    expect(await exists(top, "")).toBe(false);
    expect(await exists(home, "dgwork")).toBe(true);
    expect(await exists(home, "dgplan")).toBe(false);
  });

  it("作業フォルダごとのリポジトリと個人の置き場所を見て、同じ置き場所は 1 つにまとめる。リポジトリの外のフォルダは個人の置き場所だけを見る", async () => {
    const repo = await repoDir();
    const other = await repoDir();
    const outside = await tempDir();
    const home = await tempDir();
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");
    await put(repo, "dgwork", olderVersionOf(work.content));
    await put(other, "dgplan", olderVersionOf(plan.content));
    const edited = `${olderVersionOf(plan.content)}\nmy note\n`;
    await put(home, "dgplan", edited);
    await put(home, "dgwork", olderVersionOf(work.content));

    // 同じリポジトリの中のフォルダを 2 つ開いていても、その置き場所は 1 回だけ返す
    const sub = path.join(repo, ".claude");
    expect(
      await refreshInstalledSkills({ folders: [repo, outside, sub, other], env: { HOME: home } }),
    ).toEqual([
      { scope: "project", dir: skillsDir(repo), updated: ["dgwork"], edited: [] },
      { scope: "personal", dir: skillsDir(home), updated: ["dgwork"], edited: ["dgplan"] },
      { scope: "project", dir: skillsDir(other), updated: ["dgplan"], edited: [] },
    ]);
    expect(await read(repo, "dgwork")).toBe(work.content);
    expect(await read(other, "dgplan")).toBe(plan.content);
    // 手で直したものは書き換えない
    expect(await read(home, "dgplan")).toBe(edited);
    // リポジトリの外のフォルダには書かず、入れていない Skill も足さない
    await expect(readdir(path.join(outside, ".claude"))).rejects.toThrow();
    expect(await readdir(skillsDir(repo))).toEqual(["dgwork"]);
  });

  it("作業フォルダがなくても個人の置き場所は見る", async () => {
    const home = await tempDir();
    const work = await contentOf("dgwork");
    await put(home, "dgwork", work.content);
    expect(await refreshInstalledSkills({ folders: [], env: { HOME: home } })).toEqual([]);
    await put(home, "dgwork", olderVersionOf(work.content));
    expect(await refreshInstalledSkills({ folders: [], env: { HOME: home } })).toEqual([
      { scope: "personal", dir: skillsDir(home), updated: ["dgwork"], edited: [] },
    ]);
  });
});

describe("dg next と dg brief の古い Skill の警告（t858）", () => {
  async function prepared() {
    const f = await createFixture();
    cleanups.push(f.cleanup);
    const actor = { kind: "agent" as const, user: "eiki" };
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {
      template: "software-development",
    });
    const ctx = await openContext({ cwd: f.cloneA, actor });
    // 本物の ~/.claude/skills を読まない
    ctx.env = { HOME: await tempDir() };
    await runCommand(ticketCreate, ctx, { title: "A" });
    return ctx;
  }
  const warningsOf = async (ctx: Awaited<ReturnType<typeof prepared>>) => ({
    next: (await runCommand(next, ctx, { ticket: "t1" })).warnings ?? [],
    brief: (await runCommand(brief, ctx, { ticket: "t1", role: "implement" })).warnings ?? [],
  });
  const aboutSkills = (warnings: readonly string[]) =>
    warnings.filter((w) => w.includes("dg skill install"));

  it("古い Skill があるときだけ、warnings に名前と dg skill install を出す。手を加えたものは --force を分けて出す", async () => {
    const ctx = await prepared();
    const top = ctx.repo.topLevel;
    const work = await contentOf("dgwork");
    const plan = await contentOf("dgplan");

    // 入れていない・今の dg と同じなら何も足さない
    expect(await warningsOf(ctx)).toEqual({ next: [], brief: [] });
    await put(top, "dgwork", work.content);
    expect(await warningsOf(ctx)).toEqual({ next: [], brief: [] });

    await put(top, "dgwork", olderVersionOf(work.content));
    const stale = `These dg Skills in ${skillsDir(top)} are older than this dg (an older version of dg wrote them): dgwork. Update them with dg skill install`;
    expect(await warningsOf(ctx)).toEqual({ next: [stale], brief: [stale] });

    await put(top, "dgplan", `${olderVersionOf(plan.content)}\nmy note\n`);
    const edited = `These dg Skills in ${skillsDir(top)} are older than this dg and were edited by hand, so dg skill install keeps them: dgplan. To overwrite them with the current Skills, run dg skill install --force`;
    const both = await warningsOf(ctx);
    expect(aboutSkills(both.next)).toEqual([stale, edited]);
    expect(aboutSkills(both.brief)).toEqual([stale, edited]);
  });

  it("~/.claude/skills の古い Skill も知らせ、--personal を付けた呼び方を案内する", async () => {
    const ctx = await prepared();
    const home = ctx.env!["HOME"]!;
    await put(home, "dgdone", olderVersionOf((await contentOf("dgdone")).content));
    const { next: fromNext } = await warningsOf(ctx);
    expect(aboutSkills(fromNext)).toEqual([
      `These dg Skills in ${skillsDir(home)} are older than this dg (an older version of dg wrote them): dgdone. Update them with dg skill install --personal`,
    ]);
  });

  it("1 回の更新と 1 回の dg next・dg brief で、Skill の組み立て（guide の読み込み）は 1 回に収まる", async () => {
    // buildSkills はトピックごとに readGuideMeta を 1 回呼ぶ。手順の文（brief）が読まないトピックの回数で、組み立ての回数を数える
    expect(GUIDE_TOPICS).toContain("retro");
    const meta = vi.spyOn(guide, "readGuideMeta");
    cleanups.push(async () => meta.mockRestore());
    const builds = () => meta.mock.calls.filter(([topic]) => topic === "retro").length;

    const ctx = await prepared();
    const top = ctx.repo.topLevel;
    const home = ctx.env!["HOME"]!;
    // 置き場所が 2 つあり、どちらにも書くものがあっても 1 回
    await put(top, "dgwork", olderVersionOf((await contentOf("dgwork")).content));
    await put(home, "dgdone", olderVersionOf((await contentOf("dgdone")).content));

    meta.mockClear();
    await runCommand(next, ctx, { ticket: "t1" });
    expect(builds()).toBe(1);
    meta.mockClear();
    await runCommand(brief, ctx, { ticket: "t1", role: "implement" });
    expect(builds()).toBe(1);
    meta.mockClear();
    const refreshed = await refreshInstalledSkills({ folders: [top, top], env: ctx.env! });
    expect(refreshed.map((r) => r.updated)).toEqual([["dgwork"], ["dgdone"]]);
    expect(builds()).toBe(1);
  });
});
