// deguboard worktree の用意（SY-1）。orphan ブランチ `deguboard` を <common-dir>/deguboard/ に checkout する。
// データのリモートでのブランチ名（git.data_branch。repo.dataBranch）は変えられるが、手元のブランチは名前によらず LOCAL_DATA_BRANCH にする。
// なぜ：データのブランチ名を変える移行（dg config set git.data_branch）で、手元のブランチを付け替えずに、取り込みと push の先だけを変えれば済むように

import { dataRemoteRef, ensureLocalDir, type RepoPaths } from "./repo.js";
import { pathExists } from "../storage/exists.js";
import { OperationError } from "../errors.js";
import { GitError, runGit } from "./run.js";

/** 手元のデータの worktree が checkout するブランチの名前（データのリモートでの名前は repo.dataBranch） */
export const LOCAL_DATA_BRANCH = "deguboard";

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
  const listed = await runGit(paths.topLevel, ["worktree", "list", "--porcelain"], {
    allowFailure: true,
  });
  // 一覧を読めなければ「なし」とする（ticket.show ごと落とさない）
  if (listed.code !== 0) return null;
  const out = listed.stdout;
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

/** init がデータのリモートに届かず、ボードを作らずに止まるときのエラー */
function remoteUnreachableError(
  remote: string,
  dataBranch: string,
  detail: string,
): OperationError {
  return new OperationError(
    "GIT_ERROR",
    `Cannot reach the data remote ${remote} to check for its ${dataBranch} branch, so dg init did not create a board. ` +
      `Fix the connection (network, credentials, or the remote's URL) and run dg init again to take in the team's board. ` +
      `To start with a board only on this machine instead, run dg init --new-board: if the remote already has a board, ` +
      `the new one is a separate board that shares no history with it, and dg sync stops with DATA_HISTORY_UNRELATED`,
    detail || undefined,
  );
}

/**
 * 既にあればそのまま、ローカルに deguboard ブランチ（LOCAL_DATA_BRANCH）があればそれを、データのリモートにデータのブランチ（dataBranch）が
 * あればそれを追うブランチを、なければ orphan を作って checkout する。データのリモートに届かなければ、newBoard のときだけ orphan を作り、
 * そうでなければ何も作らずに失敗する。リモートのほかのブランチ（ほかのカンバンのデータ）は見ない。
 * orphan は `worktree add --orphan`（git 2.42）を使わず plumbing で作り、git 2.30 と unborn HEAD でも動かす
 */
export async function ensureDeguboardWorktree(
  paths: RepoPaths,
  remote: string | null,
  dataBranch: string,
  options: { newBoard?: boolean | undefined } = {},
): Promise<WorktreeOrigin> {
  await ensureLocalDir(paths.localDir);
  const git = (args: string[]) => runGit(paths.topLevel, args, { localDir: paths.localDir });
  // 失敗した init の残骸（ディレクトリが消えた worktree の登録）を片付ける
  await git(["worktree", "prune"]);
  if (await hasWorktree(paths)) return "existing";

  if (await branchExists(paths, `refs/heads/${LOCAL_DATA_BRANCH}`)) {
    await git(["worktree", "add", paths.dataDir, LOCAL_DATA_BRANCH]);
    return "local_branch";
  }
  if (remote) {
    // 名前の末尾が合うだけのほかのブランチ（team/deguboard など）に当たらないよう、完全な ref で引く
    const remoteHas = await runGit(
      paths.topLevel,
      ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${dataBranch}`],
      {
        allowFailure: true,
        timeoutMs: 30_000,
      },
    ).catch((error: unknown) => {
      // 時間切れも届かないとみなす（GitError の timeout は allowFailure でも投げられる）
      if (error instanceof GitError && error.kind === "timeout")
        return { stdout: "", stderr: error.message, code: -1 };
      throw error;
    });
    // --exit-code の 2 は「届いて、そのブランチがない」。それ以外の失敗は届かなかった（接続・認証・時間切れ）。
    // なぜ止める：届かないまま orphan を作ると、チームのボードと履歴を共有しない別のボードができ、後の sync が
    // DATA_HISTORY_UNRELATED で止まるまで気づけない（SY-1）。手元だけで始めるのは newBoard で人が選ぶ
    if (remoteHas.code !== 0 && remoteHas.code !== 2 && !options.newBoard)
      throw remoteUnreachableError(remote, dataBranch, remoteHas.stderr.trim());
    if (remoteHas.code === 0) {
      await git([
        "fetch",
        remote,
        `refs/heads/${dataBranch}:${dataRemoteRef({ dataRemote: remote, dataBranch })}`,
      ]);
      await git([
        "worktree",
        "add",
        "--track",
        "-b",
        LOCAL_DATA_BRANCH,
        paths.dataDir,
        `${remote}/${dataBranch}`,
      ]);
      return "from_remote";
    }
  }
  const tree = (await git(["hash-object", "-t", "tree", "--stdin"])).stdout.trim();
  const commit = (
    await git(["commit-tree", tree, "-m", "Create the deguboard branch"])
  ).stdout.trim();
  await git(["branch", LOCAL_DATA_BRANCH, commit]);
  await git(["worktree", "add", paths.dataDir, LOCAL_DATA_BRANCH]);
  return "orphan";
}
