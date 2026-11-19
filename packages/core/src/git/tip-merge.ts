// 作業ブランチのリモートの先端がマージコミットのときの事実を読む（RN-10）。base を取り込んだだけの更新では、取り込む前の先端の
// 見直しを数える。決めるのは facts-judge.ts の読まない関数（baseMergeParents・mergedBaseOnto）で、ここは親・tree・自動マージの
// 結果を git から集めるだけ

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { baseMergeParents, type TipMerge } from "./facts-judge.js";
import { baseRef, type BranchTip } from "./facts.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";

/**
 * work に base を自動でマージした結果の tree。競合した・作れなかったときは null。
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
 * 先端（sha）がマージコミットなら、その事実を読む。マージコミットでない・読めないときは undefined。
 * 自動マージの結果（autoTree）は時間がかかるので、親が「作業の先端と base のコミット」の形で、作業の先端が見直した SHA
 * （reviewed）にあるときだけ作る。fetch を渡せば、親が base のコミットかを比べる前に base を取り込む
 */
export async function readTipMerge(
  repo: GitRepo,
  sha: string,
  reviewed: readonly string[],
  opts: { fetch?: boolean } = {},
): Promise<TipMerge | undefined> {
  const read = await runGit(repo.dataDir, ["log", "-1", "--format=%P %T", sha], {
    allowFailure: true,
  });
  const fields = read.stdout.trim().split(" ").filter(Boolean);
  const tree = fields.pop();
  const parents = fields;
  if (read.code !== 0 || !tree || parents.length < 2) return undefined;
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
  const base = await baseRef(repo);
  const onBase: string[] = [];
  if (base)
    for (const parent of parents) {
      const r = await runGit(repo.dataDir, ["merge-base", "--is-ancestor", parent, base], {
        allowFailure: true,
      });
      if (r.code === 0) onBase.push(parent);
    }
  const pair = baseMergeParents({ parents, onBase });
  const autoTree =
    pair && reviewed.includes(pair.work) ? await autoMergeTree(repo, pair.work, pair.base) : null;
  return { parents, onBase, tree, autoTree };
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
