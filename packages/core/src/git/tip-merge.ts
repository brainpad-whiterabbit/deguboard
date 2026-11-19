// 作業ブランチのリモートの先端がマージコミットのときの事実を読む（RN-10）。base を取り込んだだけの更新（2 回以上の取り込みの
// 連なりも）では、取り込む前の先端の見直しを数える。決めるのは facts-judge.ts の読まない関数（baseMergeChain・
// nextInBaseMergeChain・mergedBaseOnto）で、ここは親・tree・自動マージの結果を git から集めるだけ

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  baseMergeChain,
  nextInBaseMergeChain,
  type MergeParents,
  type TipMerge,
} from "./facts-judge.js";
import { baseRef, type BranchTip } from "./facts.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";

/**
 * work に base を自動でマージした結果の tree。競合した・作れなかったときは null。readTipMerge が 1 回の判定に 1 回だけ呼ぶ。
 * 一時の worktree を work に checkout してコミットなしのマージをし、index から tree を書く。作業ツリーなしで tree を作る
 * `git merge-tree --write-tree` は git 2.38 からで、動かす条件の git 2.30 では使えない。worktree は結果によらず消す。
 * 利用者の hooks は動かさず（空の hooksPath）、rerere も切る（前に手で解いた競合を自動の結果に混ぜない）
 */
export async function autoMergeTree(
  repo: Pick<GitRepo, "topLevel" | "localDir">,
  work: string,
  base: string,
): Promise<string | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dg-merge-"));
  const opts = { allowFailure: true, localDir: repo.localDir, timeoutMs: 120_000 } as const;
  try {
    const added = await runGit(
      repo.topLevel,
      ["worktree", "add", "--detach", "--", dir, work],
      opts,
    );
    if (added.code !== 0) return null;
    const merged = await runGit(
      dir,
      ["-c", "rerere.enabled=false", "merge", "--no-commit", "--no-ff", base],
      opts,
    );
    if (merged.code !== 0) return null;
    const tree = await runGit(dir, ["write-tree"], opts);
    const out = tree.stdout.trim();
    return tree.code === 0 && out ? out : null;
  } catch {
    // git がない・時間切れは、自動マージの結果がないとして数えない側に倒す
    return null;
  } finally {
    const removed = await runGit(repo.topLevel, ["worktree", "remove", "--force", "--", dir], {
      allowFailure: true,
    }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    // worktree remove が消せなかったときも、ディレクトリを消した後の prune で登録を残さない
    if (removed?.code !== 0)
      await runGit(repo.topLevel, ["worktree", "prune"], { allowFailure: true }).catch(
        () => undefined,
      );
  }
}

/**
 * sha がマージコミットなら、親・そのうち base（の先端かその祖先）のコミットであるもの・tree を読む。
 * マージコミットでない・読めないときは undefined。base は比べる base の ref（なければどの親も base のコミットとしない）
 */
async function readMergeCommit(
  repo: GitRepo,
  sha: string,
  base: () => Promise<string | undefined>,
): Promise<(MergeParents & { tree: string }) | undefined> {
  const read = await runGit(repo.dataDir, ["log", "-1", "--format=%P %T", sha], {
    allowFailure: true,
  });
  const fields = read.stdout.trim().split(" ").filter(Boolean);
  const tree = fields.pop();
  const parents = fields;
  if (read.code !== 0 || !tree || parents.length < 2) return undefined;
  const ref = await base();
  const onBase: string[] = [];
  if (ref)
    for (const parent of parents) {
      const r = await runGit(repo.dataDir, ["merge-base", "--is-ancestor", parent, ref], {
        allowFailure: true,
      });
      if (r.code === 0) onBase.push(parent);
    }
  return { parents, onBase, tree };
}

/**
 * 先端（sha）がマージコミットなら、その事実を読む。マージコミットでない・読めないときは undefined。
 * 先端が base を取り込んだだけの形なら、base でない親を辿って、見直した SHA（reviewed）に着くかマージコミットでなくなるまで
 * マージコミットを読む（どこまで辿るかは nextInBaseMergeChain が決める）。
 * 自動マージの結果（autoTree）は時間がかかるので、連なりの先が見直した SHA にあるときだけ、取り込みの回数によらず 1 回だけ作る
 * （見直した SHA に、先端の base の親をマージする）。fetch を渡せば、親が base のコミットかを比べる前に base を取り込む。
 * autoMerge は自動マージを作る関数の差し替え（テストが呼んだ回数と引数を見る）
 */
export async function readTipMerge(
  repo: GitRepo,
  sha: string,
  reviewed: readonly string[],
  opts: { fetch?: boolean; autoMerge?: typeof autoMergeTree } = {},
): Promise<TipMerge | undefined> {
  let ref: Promise<string | undefined> | undefined;
  // base の ref は、先端がマージコミットと分かってから（fetch の後に）1 回だけ引く
  const base = () => (ref ??= fetchedBaseRef(repo, opts));
  const tip = await readMergeCommit(repo, sha, base);
  if (!tip) return undefined;
  const earlier: Array<MergeParents & { sha: string }> = [];
  const chain = { parents: tip.parents, onBase: tip.onBase, earlier };
  for (let next = nextInBaseMergeChain(chain, reviewed); next !== undefined;) {
    const commit = await readMergeCommit(repo, next, base);
    if (!commit) break;
    earlier.push({ sha: next, parents: commit.parents, onBase: commit.onBase });
    next = nextInBaseMergeChain(chain, reviewed);
  }
  const end = baseMergeChain(chain);
  const autoTree =
    end && reviewed.includes(end.work)
      ? await (opts.autoMerge ?? autoMergeTree)(repo, end.work, end.base)
      : null;
  return { ...chain, tree: tip.tree, autoTree };
}

/** 比べる base の ref。fetch を渡せば、その前に base を取り込む */
async function fetchedBaseRef(
  repo: GitRepo,
  opts: { fetch?: boolean },
): Promise<string | undefined> {
  if (opts.fetch && repo.codeRemote)
    await runGit(
      repo.dataDir,
      [
        "fetch",
        repo.codeRemote,
        `+refs/heads/${repo.baseBranch}:refs/remotes/${repo.codeRemote}/${repo.baseBranch}`,
      ],
      { allowFailure: true, timeoutMs: 60_000 },
    );
  return baseRef(repo);
}

/**
 * リモートの先端に、マージコミットのときの事実を足す（dg gate の review と dg next の段階が同じ読み方をする）。
 * runs は見直しの Run（見直した SHA を head に持つ）。先端を見直した見直しがあれば、取り込みを調べるまでもないので読まない
 */
export async function withTipMerge(
  repo: GitRepo,
  tip: BranchTip,
  runs: ReadonlyArray<{ head?: string | undefined }>,
  opts: { fetch?: boolean } = {},
): Promise<BranchTip> {
  const reviewed = runs.map((r) => r.head).filter((h): h is string => h !== undefined);
  if (reviewed.length === 0 || reviewed.includes(tip.sha)) return tip;
  const merge = await readTipMerge(repo, tip.sha, reviewed, opts).catch(() => undefined);
  return merge ? { ...tip, merge } : tip;
}
