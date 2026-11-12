import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFixture,
  createFixtureFrom,
  disposeFixtureTemplate,
  fixtureTemplateDir,
  git,
  openRepo,
  type Fixture,
  type Layout,
} from "../../test/helpers/git-fixture.js";
import { resolveRepoPaths } from "./repo.js";
import { ensureDeguboardWorktree } from "./worktree.js";

// 雛形から写したリポジトリが、一から作ったものと同じに振る舞うことを確かめる

afterAll(async () => {
  // テストファイルの終わりに雛形が消えていることを確かめる（消すのは fixture の afterAll と同じ関数）
  const dirs = [await fixtureTemplateDir(), await fixtureTemplateDir("worktree")];
  await disposeFixtureTemplate();
  for (const dir of dirs) if (dir) expect(existsSync(dir)).toBe(false);
});

/** 中身（git の object を除く）に needle を含むファイルの一覧 */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === "objects") continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && (await readFile(p, "utf8")).includes(needle)) hits.push(p);
    }
  };
  await walk(dir);
  return hits;
}

/** worktree の一覧の形（HEAD の ID を除き、写した先の場所を <ROOT> に置く） */
async function worktreeShape(f: Fixture): Promise<string[]> {
  const listed = (await git(f.cloneA, ["worktree", "list", "--porcelain"])).stdout;
  return listed
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("HEAD "))
    .map((line) => line.replace(f.root, "<ROOT>"));
}

const worktreeSetup = async (f: Layout): Promise<void> => {
  await openRepo(f.cloneA);
};

describe("createFixture（雛形から写す）", () => {
  it("写した clone の remote.origin.url は写した先の remote.git を指し、雛形を指さない", async () => {
    const f = await createFixture();
    const template = await fixtureTemplateDir();
    expect(template).toBeDefined();
    for (const clone of [f.cloneA, f.cloneB]) {
      const url = (await git(clone, ["config", "--get", "remote.origin.url"])).stdout.trim();
      expect(url).toBe(f.remoteDir);
      expect(url.startsWith(template ?? "")).toBe(false);
    }
    await f.cleanup();
  });

  it("一から作ったものと同じく、remote に main が 1 つだけあり、deguboard のブランチはない", async () => {
    const f = await createFixture();
    const heads = (await git(f.cloneB, ["ls-remote", "--heads", "origin"])).stdout;
    expect(heads).toContain("refs/heads/main");
    expect(heads).not.toContain("refs/heads/deguboard");
    const log = (await git(f.cloneB, ["log", "--format=%s", "origin/main"])).stdout.trim();
    expect(log).toBe("最初のコミット");
    await f.cleanup();
  });

  it("clone の identity は一から作ったものと同じく設定されている", async () => {
    const f = await createFixture();
    expect((await git(f.cloneA, ["config", "user.name"])).stdout.trim()).toBe("テスト");
    expect((await git(f.cloneB, ["config", "user.email"])).stdout.trim()).toBe("test@example.com");
    await f.cleanup();
  });

  it("写した先どうしと雛形は互いに影響しない（push は写した先の remote だけに届く）", async () => {
    const f1 = await createFixture();
    const f2 = await createFixture();
    await git(f1.cloneA, ["commit", "--quiet", "--allow-empty", "-m", "f1 の変更"]);
    await git(f1.cloneA, ["push", "--quiet", "origin", "main"]);
    const seenInF1 = (await git(f1.cloneB, ["fetch", "--quiet", "origin"])).stdout;
    expect(seenInF1).toBe("");
    const logF1 = (await git(f1.cloneB, ["log", "--format=%s", "origin/main"])).stdout;
    expect(logF1).toContain("f1 の変更");
    const logF2 = (await git(f2.cloneB, ["log", "--format=%s", "origin/main"])).stdout;
    expect(logF2).not.toContain("f1 の変更");
    const template = await fixtureTemplateDir();
    const logTemplate = (
      await git(template ?? "", ["--git-dir", "remote.git", "log", "--format=%s", "main"])
    ).stdout;
    expect(logTemplate).not.toContain("f1 の変更");
    await f1.cleanup();
    await f2.cleanup();
  });

  it("cleanup は写した先を消す", async () => {
    const f = await createFixture();
    expect(existsSync(f.root)).toBe(true);
    await f.cleanup();
    expect(existsSync(f.root)).toBe(false);
  });
});

describe("createFixtureFrom（setup を済ませた雛形から写す）", () => {
  it("setup は同じ key で 1 度だけ走り、写すたびには走らない", async () => {
    let runs = 0;
    const setup = async (): Promise<void> => {
      runs += 1;
    };
    const f1 = await createFixtureFrom("once", setup);
    const f2 = await createFixtureFrom("once", setup);
    expect(runs).toBe(1);
    await f1.cleanup();
    await f2.cleanup();
  });

  it("写した先の worktree は一から作ったものと同じ場所と枝を持ち、ensure は既存として扱う", async () => {
    const copy = await createFixtureFrom("worktree", worktreeSetup);
    const fresh = await createFixture();
    await openRepo(fresh.cloneA);
    expect(await worktreeShape(copy)).toEqual(await worktreeShape(fresh));
    const paths = await resolveRepoPaths(copy.cloneA);
    expect(await ensureDeguboardWorktree(paths, "origin")).toBe("existing");
    expect((await git(paths.dataDir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(
      "deguboard",
    );
    await copy.cleanup();
    await fresh.cleanup();
  });

  it("写した先の絶対パスは写した先を指す（worktree の .git と管理ディレクトリの gitdir）", async () => {
    const copy = await createFixtureFrom("worktree", worktreeSetup);
    const template = await fixtureTemplateDir("worktree");
    const dataDir = path.join(copy.cloneA, ".git", "deguboard");
    const dotGit = await readFile(path.join(dataDir, ".git"), "utf8");
    expect(dotGit.startsWith(`gitdir: ${copy.cloneA}`)).toBe(true);
    const adminGitdir = await readFile(
      path.join(copy.cloneA, ".git", "worktrees", "deguboard", "gitdir"),
      "utf8",
    );
    expect(adminGitdir.trim()).toBe(path.join(dataDir, ".git"));
    expect(dotGit.includes(template ?? "")).toBe(false);
    expect(adminGitdir.includes(template ?? "")).toBe(false);
    await copy.cleanup();
  });

  it("写した先のデータ worktree への書き込みは、その写した先だけに残る", async () => {
    const copy1 = await createFixtureFrom("worktree", worktreeSetup);
    const copy2 = await createFixtureFrom("worktree", worktreeSetup);
    const dataDir1 = path.join(copy1.cloneA, ".git", "deguboard");
    await git(dataDir1, ["commit", "--quiet", "--allow-empty", "-m", "写した先の書き込み"]);
    const log1 = (await git(copy1.cloneA, ["log", "--format=%s", "deguboard"])).stdout;
    expect(log1).toContain("写した先の書き込み");
    const dataDir2 = path.join(copy2.cloneA, ".git", "deguboard");
    const log2 = (await git(dataDir2, ["log", "--format=%s"])).stdout;
    expect(log2).not.toContain("写した先の書き込み");
    expect(log2).toContain("Create the deguboard branch");
    await copy1.cleanup();
    await copy2.cleanup();
  });

  it("写した先に雛形の場所は残らない（雛形の中には残ることを正の対照で確かめる）", async () => {
    const copy = await createFixtureFrom("worktree", worktreeSetup);
    const template = await fixtureTemplateDir("worktree");
    expect(template).toBeDefined();
    expect(await filesContaining(template ?? "", template ?? "")).not.toEqual([]);
    expect(await filesContaining(copy.root, template ?? "")).toEqual([]);
    await copy.cleanup();
  });

  it("写した先を消しても雛形は残り、残りの写した先も使える", async () => {
    const copy1 = await createFixtureFrom("worktree", worktreeSetup);
    const template = await fixtureTemplateDir("worktree");
    await copy1.cleanup();
    expect(existsSync(copy1.root)).toBe(false);
    expect(existsSync(template ?? "")).toBe(true);
    const copy2 = await createFixtureFrom("worktree", worktreeSetup);
    expect(await worktreeShape(copy2)).toContain(`worktree <ROOT>/a/.git/deguboard`);
    await copy2.cleanup();
  });
});
