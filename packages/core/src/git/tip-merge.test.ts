// 作業ブランチの先端がマージコミットのときの事実の読み取り（RN-10）を、本物の git で確かめる。
// 読んだ事実からの判定の組み合わせは facts-judge.test.ts と commands/gate-judge.test.ts が git なしで確かめる
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, openRepo } from "../../test/helpers/git-fixture.js";
import { mergedBaseOnto } from "./facts-judge.js";
import type { GitRepo } from "./repo.js";
import { readTipMerge, withTipMerge } from "./tip-merge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const head = async (cwd: string, rev = "HEAD") =>
  (await git(cwd, ["rev-parse", rev])).stdout.trim();

async function commitFile(cwd: string, file: string, text: string, message: string) {
  await writeFile(path.join(cwd, file), text);
  await git(cwd, ["add", "--", file]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return head(cwd);
}

/**
 * main に shared.txt があり、作業ブランチ t1 に 1 コミット（見直した SHA）を積んで push した後、別の clone が main を進めた形。
 * mainEdit は main の側で変えるファイルと中身（shared.txt を変えれば、t1 の変更と競合する）
 */
async function diverged(mainEdit: { file: string; text: string }) {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const a = f.cloneA;
  await commitFile(a, "shared.txt", "共有\n", "共有のファイル");
  await git(a, ["push", "-q", "origin", "HEAD:main"]);
  const { repo } = await openRepo(a);
  await git(a, ["checkout", "-qb", "t1"]);
  const reviewed = await commitFile(a, "shared.txt", "共有\n作業\n", "作業");
  await git(a, ["push", "-q", "origin", "t1"]);
  await git(f.cloneB, ["fetch", "-q", "origin"]);
  await git(f.cloneB, ["checkout", "-q", "--detach", "origin/main"]);
  const main = await commitFile(f.cloneB, mainEdit.file, mainEdit.text, "main を進める");
  await git(f.cloneB, ["push", "-q", "origin", "HEAD:main"]);
  await git(a, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  return { a, repo, reviewed, main };
}

/** 一時の worktree が残っていないか：登録（git worktree list）と管理ディレクトリ（.git/worktrees）を見る */
async function worktrees(repo: GitRepo) {
  const listed = (await git(repo.topLevel, ["worktree", "list", "--porcelain"])).stdout;
  const admin = await readdir(path.join(repo.commonDir, "worktrees")).catch(() => []);
  return { listed, admin: admin.sort() };
}

describe("先端のマージコミットの事実（readTipMerge。RN-10）", () => {
  it("base を競合なく取り込んだだけのマージコミットは、tree が一時の worktree で作った自動マージの結果と同じで、worktree は残らない", async () => {
    const { a, repo, reviewed, main } = await diverged({ file: "main.txt", text: "main\n" });
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const tip = await head(a);
    const before = await worktrees(repo);
    const merge = await readTipMerge(repo, tip, [reviewed]);
    expect(merge).toEqual({
      parents: [reviewed, main],
      onBase: [main],
      tree: await head(a, "HEAD^{tree}"),
      autoTree: await head(a, "HEAD^{tree}"),
    });
    expect(mergedBaseOnto(merge)).toBe(reviewed);
    // 判定の後に、一時の worktree の登録も管理ディレクトリも残らない
    expect(await worktrees(repo)).toEqual(before);
    expect(before.admin.some((name) => name.startsWith("dg-merge-"))).toBe(false);
    // 作業ブランチの worktree（clone A）は動かさない
    expect(await head(a)).toBe(tip);
    expect((await git(a, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("競合を手で解いたマージコミットは、自動マージの結果がなく（競合）、競合した一時の worktree も残らない", async () => {
    const { a, repo, reviewed } = await diverged({ file: "shared.txt", text: "共有\nmain\n" });
    const merged = await git(a, ["merge", "-q", "--no-edit", "origin/main"]).catch(() => undefined);
    expect(merged).toBeUndefined();
    await commitFile(a, "shared.txt", "共有\n作業と main\n", "競合を解く");
    const before = await worktrees(repo);
    const merge = await readTipMerge(repo, await head(a), [reviewed]);
    expect(merge).toMatchObject({ parents: [reviewed, expect.any(String)], autoTree: null });
    expect(mergedBaseOnto(merge)).toBeUndefined();
    expect(await worktrees(repo)).toEqual(before);
  });

  it("競合はないがマージコミットに別の変更を混ぜると、tree が自動マージの結果と違う", async () => {
    const { a, repo, reviewed } = await diverged({ file: "main.txt", text: "main\n" });
    await git(a, ["merge", "-q", "--no-commit", "--no-ff", "origin/main"]);
    await commitFile(a, "extra.txt", "混ぜた変更\n", "main を取り込む");
    const merge = await readTipMerge(repo, await head(a), [reviewed]);
    expect(merge?.autoTree).not.toBeNull();
    expect(merge?.autoTree).not.toBe(merge?.tree);
    expect(mergedBaseOnto(merge)).toBeUndefined();
  });

  it("取り込みの後に別のコミットがある先端と、rebase した先端は、マージコミットでないので事実を持たない", async () => {
    const { a, repo, reviewed } = await diverged({ file: "main.txt", text: "main\n" });
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const after = await commitFile(a, "later.txt", "後のコミット\n", "取り込みの後");
    expect(await readTipMerge(repo, after, [reviewed])).toBeUndefined();
    await git(a, ["reset", "-q", "--hard", reviewed]);
    await git(a, ["rebase", "-q", "origin/main"]);
    expect(await readTipMerge(repo, await head(a), [reviewed])).toBeUndefined();
  });

  it("base でない親を見直した見直しがなければ、自動マージの結果を作らない。先端を見直した見直しがあれば事実を読まない", async () => {
    const { a, repo, reviewed, main } = await diverged({ file: "main.txt", text: "main\n" });
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const sha = await head(a);
    expect(await readTipMerge(repo, sha, [main])).toMatchObject({ onBase: [main], autoTree: null });
    const tip = { sha, at: "2026-01-01T00:00:00Z" };
    expect(await withTipMerge(repo, tip, [{ head: sha }, { head: reviewed }])).toBe(tip);
    expect(await withTipMerge(repo, tip, [{}])).toBe(tip);
    expect((await withTipMerge(repo, tip, [{ head: reviewed }])).merge?.autoTree).toBe(
      await head(a, "HEAD^{tree}"),
    );
  });
});
