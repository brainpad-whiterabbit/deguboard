// Git のテスト用：一時ディレクトリに bare リモートと 2 つの clone を作る（CLAUDE.md の規約）

import { afterAll } from "vitest";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRepoPaths, resolveRemote, type GitRepo } from "../../src/git/repo.js";
import { runGit } from "../../src/git/run.js";
import { ensureDeguboardWorktree } from "../../src/git/worktree.js";
import { Store } from "../../src/storage/store.js";

// 開発者のグローバル設定（hooksPath・gpgsign・defaultBranch）に影響されないようにする
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

// 裏の git maintenance・gc を起こさない。git は commit・fetch の後に maintenance run --auto --detach を起動し、
// 呼んだ git が終わっても一時ディレクトリに書き続けるため、後片付けの rm と競合する（ENOTEMPTY）
const backgroundOff: [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
];
process.env["GIT_CONFIG_COUNT"] = String(backgroundOff.length);
backgroundOff.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});

/** 裏の処理が残っていても消せるよう、rm を再試行させる */
const removeDir = (dir: string) =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** push を受けた receive-pack には環境変数が渡らないので、bare リモート自身の設定で止める */
async function disableBackgroundOnRemote(remoteDir: string): Promise<void> {
  const settings: [string, string][] = [...backgroundOff, ["receive.autogc", "false"]];
  for (const [key, value] of settings) {
    await runGit(remoteDir, ["config", key, value]);
  }
}

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

/** 1 つのテストファイルの中で 1 度だけ作る雛形（bare リモートと clone 2 つ、最初のコミット入り）のディレクトリ */
let template: Promise<string> | undefined;

async function buildTemplate(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-git-template-")));
  const remoteDir = path.join(root, "remote.git");
  await runGit(root, ["init", "--quiet", "--bare", "-b", "main", remoteDir]);
  await disableBackgroundOnRemote(remoteDir);
  const cloneA = path.join(root, "a");
  const cloneB = path.join(root, "b");
  await runGit(root, ["clone", "--quiet", remoteDir, cloneA]);
  await configureIdentity(cloneA);
  await runGit(cloneA, ["commit", "--quiet", "--allow-empty", "-m", "最初のコミット"]);
  await runGit(cloneA, ["push", "--quiet", "origin", "main"]);
  await runGit(root, ["clone", "--quiet", remoteDir, cloneB]);
  await configureIdentity(cloneB);
  return root;
}

/** 雛形のディレクトリ。まだ作っていなければ undefined（テストが雛形を消せたかを確かめるため） */
export async function fixtureTemplateDir(): Promise<string | undefined> {
  return template && (await template);
}

/** 雛形を消す。2 回目以降は何もしない */
export async function disposeFixtureTemplate(): Promise<void> {
  const dir = await fixtureTemplateDir();
  template = undefined;
  if (dir) await removeDir(dir);
}

// テストファイルが終わったら雛形を消す（写したものは各テストの cleanup が消す）
afterAll(disposeFixtureTemplate);

/**
 * 雛形を写し、clone の remote.origin.url を写した先の remote.git に書き換える。
 * 雛形の中で絶対パスを持つのは remote.origin.url だけなので、これで一から作ったものと同じ振る舞いになる。
 * 毎回 git の子プロセスで作り直すより速いことは、hook.test.ts の計測で確かめた（PR の本文）
 */
export async function createFixture(): Promise<Fixture> {
  template ??= buildTemplate();
  const templateRoot = await template;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-git-")));
  await cp(templateRoot, root, { recursive: true, verbatimSymlinks: true });
  const remoteDir = path.join(root, "remote.git");
  const cloneA = path.join(root, "a");
  const cloneB = path.join(root, "b");
  await runGit(cloneA, ["config", "remote.origin.url", remoteDir]);
  await runGit(cloneB, ["config", "remote.origin.url", remoteDir]);
  return {
    root,
    remoteDir,
    cloneA,
    cloneB,
    cleanup: () => removeDir(root),
  };
}

/** リモートのないリポジトリ */
export async function createLocalOnlyRepo(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-local-")));
  const dir = path.join(root, "work");
  await runGit(root, ["init", "--quiet", "-b", "main", dir]);
  await configureIdentity(dir);
  return { dir, cleanup: () => removeDir(root) };
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
  const store = await Store.open(repo.dataDir, { localDir: repo.localDir });
  return { repo, store };
}

export const git = (dir: string, args: string[]) => runGit(dir, args);
