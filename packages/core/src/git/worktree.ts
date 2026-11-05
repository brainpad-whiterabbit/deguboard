// deguboard worktree の用意（SY-1）。orphan ブランチ `deguboard` を <common-dir>/deguboard/ に checkout する

import { ensureLocalDir, type RepoPaths } from "./repo.js";
import { pathExists } from "../storage/exists.js";
import { runGit } from "./run.js";

export const DATA_BRANCH = "deguboard";

export type WorktreeOrigin = "existing" | "local_branch" | "from_remote" | "orphan";

async function branchExists(paths: RepoPaths, ref: string): Promise<boolean> {
  return (
    (await runGit(paths.topLevel, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }))
      .code === 0
  );
}

async function hasWorktree(paths: RepoPaths): Promise<boolean> {
  const out = (await runGit(paths.topLevel, ["worktree", "list", "--porcelain"])).stdout;
  return out.split("\n").some((line) => line === `worktree ${paths.dataDir}`);
}

/**
 * 作業ブランチ branch を checkout している worktree のパス（絶対パス）。なければ null。
 * 場所は `config.worktree.root` とは限らない（手で作った worktree もある）ので、置き場所を決めつけず git の一覧で引く。
 * ディレクトリが消えた登録（prunable）と、deguboard の専用 worktree は対象にしない。読むだけで、何も書かない
 */
export async function findBranchWorktree(paths: RepoPaths, branch: string): Promise<string | null> {
  const out = (await runGit(paths.topLevel, ["worktree", "list", "--porcelain"])).stdout;
  for (const block of out.split("\n\n")) {
    let dir: string | null = null;
    let checkedOut: string | null = null;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) checkedOut = line.slice("branch ".length);
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
    }
    if (dir === null || prunable || dir === paths.dataDir) continue;
    if (checkedOut === `refs/heads/${branch}` && (await pathExists(dir))) return dir;
  }
  return null;
}

/**
 * 既にあればそのまま、ローカルかリモートに deguboard ブランチがあればそれを、なければ orphan を作って checkout する。
 * orphan は `worktree add --orphan`（git 2.42）を使わず plumbing で作り、git 2.30 と unborn HEAD でも動かす
 */
export async function ensureDeguboardWorktree(
  paths: RepoPaths,
  remote: string | null,
): Promise<WorktreeOrigin> {
  await ensureLocalDir(paths.localDir);
  const git = (args: string[]) => runGit(paths.topLevel, args, { localDir: paths.localDir });
  // 失敗した init の残骸（ディレクトリが消えた worktree の登録）を片付ける
  await git(["worktree", "prune"]);
  if (await hasWorktree(paths)) return "existing";

  if (await branchExists(paths, `refs/heads/${DATA_BRANCH}`)) {
    await git(["worktree", "add", paths.dataDir, DATA_BRANCH]);
    return "local_branch";
  }
  if (remote) {
    const remoteHas = await runGit(
      paths.topLevel,
      ["ls-remote", "--exit-code", "--heads", remote, DATA_BRANCH],
      {
        allowFailure: true,
        timeoutMs: 30_000,
      },
    );
    if (remoteHas.code === 0) {
      await git(["fetch", remote, `${DATA_BRANCH}:refs/remotes/${remote}/${DATA_BRANCH}`]);
      await git([
        "worktree",
        "add",
        "--track",
        "-b",
        DATA_BRANCH,
        paths.dataDir,
        `${remote}/${DATA_BRANCH}`,
      ]);
      return "from_remote";
    }
  }
  const tree = (await git(["hash-object", "-t", "tree", "--stdin"])).stdout.trim();
  const commit = (await git(["commit-tree", tree, "-m", "deguboard ブランチを作成"])).stdout.trim();
  await git(["branch", DATA_BRANCH, commit]);
  await git(["worktree", "add", paths.dataDir, DATA_BRANCH]);
  return "orphan";
}
