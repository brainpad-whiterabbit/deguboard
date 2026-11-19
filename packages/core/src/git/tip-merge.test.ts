// 作業ブランチの先端がマージコミットのときの事実の読み取り（RN-10）を、本物の git で確かめる。
// 読んだ事実からの判定の組み合わせは facts-judge.test.ts と commands/gate-judge.test.ts が git なしで確かめる
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, openRepo } from "../../test/helpers/git-fixture.js";
import { mergedBaseOnto } from "./facts-judge.js";
import type { GitRepo } from "./repo.js";
import { autoMergeTree, readTipMerge, withTipMerge } from "./tip-merge.js";

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
  /** 別の clone が main をもう 1 つ進め、clone A がそれを読む（取り込みはしない）。進めた main の SHA を返す */
  const advanceMain = async (file: string, text: string) => {
    const sha = await commitFile(f.cloneB, file, text, `main を進める（${file}）`);
    await git(f.cloneB, ["push", "-q", "origin", "HEAD:main"]);
    await git(a, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    return sha;
  };
  return { a, repo, reviewed, main, advanceMain };
}

/** 自動マージを作った回数と引数を数える差し替え（中身は本物の autoMergeTree） */
function countedAutoMerge() {
  const calls: Array<{ work: string; base: string }> = [];
  const autoMerge: typeof autoMergeTree = (repo, work, base) => {
    calls.push({ work, base });
    return autoMergeTree(repo, work, base);
  };
  return { calls, autoMerge };
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
      earlier: [],
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

describe("base を 2 回以上取り込んだ先端（取り込みの連なり。RN-10）", () => {
  it("base を 3 回取り込んだ先端は、連なりを見直した SHA まで辿り、その SHA に先端の base の親を 1 回だけ自動でマージして比べる。worktree は残らない", async () => {
    const { a, repo, reviewed, main, advanceMain } = await diverged({
      file: "main.txt",
      text: "main\n",
    });
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const first = await head(a);
    const main2 = await advanceMain("main2.txt", "main 2\n");
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const second = await head(a);
    const main3 = await advanceMain("main3.txt", "main 3\n");
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const tip = await head(a);
    const tree = await head(a, "HEAD^{tree}");
    const before = await worktrees(repo);
    const { calls, autoMerge } = countedAutoMerge();
    const merge = await readTipMerge(repo, tip, [reviewed], { autoMerge });
    expect(merge).toEqual({
      parents: [second, main3],
      onBase: [main3],
      earlier: [
        { sha: second, parents: [first, main2], onBase: [main2] },
        { sha: first, parents: [reviewed, main], onBase: [main] },
      ],
      tree,
      autoTree: tree,
    });
    // 取り込みは 3 回でも、自動マージは見直した SHA と先端の base の親で 1 回だけ
    expect(calls).toEqual([{ work: reviewed, base: main3 }]);
    expect(mergedBaseOnto(merge)).toBe(reviewed);
    expect(await worktrees(repo)).toEqual(before);
    expect(before.admin.some((name) => name.startsWith("dg-merge-"))).toBe(false);
    // 途中のマージコミット（1 回目の取り込み）を見直していれば、そこで止めて 1 回だけ作る
    const fromFirst = countedAutoMerge();
    const stopped = await readTipMerge(repo, tip, [first], { autoMerge: fromFirst.autoMerge });
    expect(stopped?.earlier.map((c) => c.sha)).toEqual([second]);
    expect(fromFirst.calls).toEqual([{ work: first, base: main3 }]);
    expect(mergedBaseOnto(stopped)).toBe(first);
    expect(await worktrees(repo)).toEqual(before);
  });

  it("連なりの途中に取り込みの後の別のコミットがある・rebase した先に取り込んだ先端は、見直した SHA に着かず、自動マージを作らない", async () => {
    const { a, repo, reviewed, advanceMain } = await diverged({ file: "main.txt", text: "main\n" });
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    await commitFile(a, "later.txt", "後のコミット\n", "取り込みの後");
    await advanceMain("main2.txt", "main 2\n");
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const between = countedAutoMerge();
    const merge = await readTipMerge(repo, await head(a), [reviewed], between);
    expect(merge).toMatchObject({ earlier: [], autoTree: null });
    expect(between.calls).toEqual([]);
    expect(mergedBaseOnto(merge)).toBeUndefined();
    // 見直した SHA を rebase し、その後に進んだ main を取り込む
    await git(a, ["reset", "-q", "--hard", reviewed]);
    await git(a, ["rebase", "-q", "origin/main"]);
    await advanceMain("main3.txt", "main 3\n");
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const rebased = countedAutoMerge();
    const afterRebase = await readTipMerge(repo, await head(a), [reviewed], rebased);
    expect(afterRebase).toMatchObject({ earlier: [], autoTree: null });
    expect(rebased.calls).toEqual([]);
    expect(mergedBaseOnto(afterRebase)).toBeUndefined();
  });

  it("連なりの途中の取り込みで競合を手で解いた・変更を混ぜた先端は、1 回の自動マージの結果と tree が合わない", async () => {
    // 1 回目の取り込みが競合し、手で解く。2 回目は競合なく取り込む
    const conflicted = await diverged({ file: "shared.txt", text: "共有\nmain\n" });
    const a = conflicted.a;
    const failed = await git(a, ["merge", "-q", "--no-edit", "origin/main"]).catch(() => undefined);
    expect(failed).toBeUndefined();
    await commitFile(a, "shared.txt", "共有\n作業と main\n", "競合を解く");
    await conflicted.advanceMain("main2.txt", "main 2\n");
    await git(a, ["merge", "-q", "--no-edit", "origin/main"]);
    const before = await worktrees(conflicted.repo);
    const resolved = await readTipMerge(conflicted.repo, await head(a), [conflicted.reviewed]);
    // 連なりは見直した SHA に着くが、その SHA に今の base をマージすると競合するので結果がない
    expect(resolved?.earlier).toHaveLength(1);
    expect(resolved?.autoTree).toBeNull();
    expect(mergedBaseOnto(resolved)).toBeUndefined();
    expect(await worktrees(conflicted.repo)).toEqual(before);

    // 1 回目の取り込みのマージコミットに別の変更を混ぜ、2 回目は競合なく取り込む
    const mixed = await diverged({ file: "main.txt", text: "main\n" });
    await git(mixed.a, ["merge", "-q", "--no-commit", "--no-ff", "origin/main"]);
    await commitFile(mixed.a, "extra.txt", "混ぜた変更\n", "main を取り込む");
    await mixed.advanceMain("main2.txt", "main 2\n");
    await git(mixed.a, ["merge", "-q", "--no-edit", "origin/main"]);
    const merge = await readTipMerge(mixed.repo, await head(mixed.a), [mixed.reviewed]);
    expect(merge?.earlier).toHaveLength(1);
    expect(merge?.autoTree).not.toBeNull();
    expect(merge?.autoTree).not.toBe(merge?.tree);
    expect(mergedBaseOnto(merge)).toBeUndefined();
  });
});
