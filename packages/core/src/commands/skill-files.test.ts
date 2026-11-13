import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import { brief } from "./brief.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { next } from "./next.js";
import { init } from "./setup.js";
import {
  buildSkills,
  findStaleSkills,
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

const MARKER = /<!-- dg skill sha256:[0-9a-f]{64} -->\n/;

/** 前の版の dg が入れたままの Skill：本文が今と違い、印はその本文のハッシュと合っている（手を加えていない） */
function olderVersionOf(content: string): string {
  const changed = content.replace("This Skill holds no steps.", "This Skill has no steps.");
  expect(changed).not.toBe(content);
  const hash = createHash("sha256").update(changed.replace(MARKER, "")).digest("hex");
  return changed.replace(MARKER, `<!-- dg skill sha256:${hash} -->\n`);
}

const skillsDir = (base: string) => path.join(base, ".claude", "skills");

async function put(base: string, name: string, content: string): Promise<void> {
  const file = path.join(skillsDir(base), name, "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

const contentOf = async (name: string) => (await buildSkills()).find((s) => s.name === name)!;

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
      { scope: "project", dir: skillsDir(top), stale: ["dgwork"], edited: ["dgplan"] },
      { scope: "personal", dir: skillsDir(home), stale: ["dgdone"], edited: [] },
    ]);
    expect(staleSkillWarnings(found)).toEqual([
      `These dg Skills in ${skillsDir(top)} are older than this dg (they differ from the Skills bundled with it): dgwork. Update them with dg skill install`,
      `These dg Skills in ${skillsDir(top)} are older than this dg and were edited by hand, so dg skill install keeps them: dgplan. To overwrite them with the current Skills, run dg skill install --force`,
      `These dg Skills in ${skillsDir(home)} are older than this dg (they differ from the Skills bundled with it): dgdone. Update them with dg skill install --personal`,
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
      { scope: "project", dir: skillsDir(top), stale: [], edited: ["dgplan"] },
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
    const stale = `These dg Skills in ${skillsDir(top)} are older than this dg (they differ from the Skills bundled with it): dgwork. Update them with dg skill install`;
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
      `These dg Skills in ${skillsDir(home)} are older than this dg (they differ from the Skills bundled with it): dgdone. Update them with dg skill install --personal`,
    ]);
  });
});
