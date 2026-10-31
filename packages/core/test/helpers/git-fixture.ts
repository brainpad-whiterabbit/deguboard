// Git のテスト用：一時ディレクトリに bare リモートと 2 つの clone を作る（CLAUDE.md の規約）

import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRepoPaths, resolveRemote, type GitRepo } from "../../src/git/repo.js";
import { runGit } from "../../src/git/run.js";
import { ensureDeguboardWorktree } from "../../src/git/worktree.js";
import { Store } from "../../src/storage/store.js";

// 開発者のグローバル設定（hooksPath・gpgsign・defaultBranch）に影響されないようにする
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

export interface Fixture {
  root: string;
  remoteDir: string;
  cloneA: string;
  cloneB: string;
  cleanup(): Promise<void>;
}

async function configureIdentity(dir: string): Promise<void> {
  await runGit(dir, ["config", "user.name", "テスト"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
}

export async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-git-")));
  const remoteDir = path.join(root, "remote.git");
  await runGit(root, ["init", "--quiet", "--bare", "-b", "main", remoteDir]);
  const cloneA = path.join(root, "a");
  const cloneB = path.join(root, "b");
  await runGit(root, ["clone", "--quiet", remoteDir, cloneA]);
  await configureIdentity(cloneA);
  await runGit(cloneA, ["commit", "--quiet", "--allow-empty", "-m", "最初のコミット"]);
  await runGit(cloneA, ["push", "--quiet", "origin", "main"]);
  await runGit(root, ["clone", "--quiet", remoteDir, cloneB]);
  await configureIdentity(cloneB);
  return {
    root,
    remoteDir,
    cloneA,
    cloneB,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** リモートのないリポジトリ */
export async function createLocalOnlyRepo(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-local-")));
  const dir = path.join(root, "work");
  await runGit(root, ["init", "--quiet", "-b", "main", dir]);
  await configureIdentity(dir);
  return { dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export interface OpenedRepo {
  repo: GitRepo;
  store: Store;
}

/** worktree を用意して Store を開く。init コマンドを通さずに git モジュールを単体で試すため */
export async function openRepo(
  dir: string,
  opts: { remote?: string | null; baseBranch?: string } = {},
): Promise<OpenedRepo> {
  const paths = await resolveRepoPaths(dir);
  const remote = opts.remote === undefined ? await resolveRemote(paths, "origin") : opts.remote;
  await ensureDeguboardWorktree(paths, remote);
  const repo: GitRepo = { ...paths, remote, baseBranch: opts.baseBranch ?? "main" };
  const store = await Store.open(repo.dataDir);
  return { repo, store };
}

export const git = (dir: string, args: string[]) => runGit(dir, args);
