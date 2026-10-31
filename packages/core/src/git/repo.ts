// リポジトリの位置の解決（requirements.md 5.1、ADR-002）

import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationError } from "../errors.js";
import { GitError, runGit } from "./run.js";

export interface GitRepo {
  /** dg を呼んだ作業ツリーの最上位 */
  topLevel: string;
  /** 絶対パスの git common dir（worktree からでも同じ場所） */
  commonDir: string;
  /** deguboard ブランチを checkout した専用 worktree */
  dataDir: string;
  /** Git 管理外の置き場所（ロック・hooks 無効化・索引） */
  localDir: string;
  /** 使えるリモート。なければ null（同期なしで動く。SY-6） */
  remote: string | null;
  baseBranch: string;
}

/** リモートと base_branch は後から決める（config を読む前に呼ぶため） */
export type RepoPaths = Omit<GitRepo, "remote" | "baseBranch">;

export async function resolveRepoPaths(cwd: string): Promise<RepoPaths> {
  let topLevel: string;
  let commonDir: string;
  try {
    topLevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const raw = (await runGit(topLevel, ["rev-parse", "--git-common-dir"])).stdout.trim();
    commonDir = path.resolve(topLevel, raw);
  } catch (error) {
    if (error instanceof GitError && error.kind === "missing") {
      throw new OperationError("GIT_ERROR", "git が見つからない。git 2.30 以上を入れる");
    }
    throw new OperationError("GIT_ERROR", `${cwd} は Git リポジトリの中ではない`, String(error));
  }
  const localDir = path.join(commonDir, "deguboard-local");
  return { topLevel, commonDir, dataDir: path.join(commonDir, "deguboard"), localDir };
}

/** deguboard-local/ と hooks を無効にする空ディレクトリを用意する */
export async function ensureLocalDir(localDir: string): Promise<void> {
  await mkdir(path.join(localDir, "no-hooks"), { recursive: true });
  await mkdir(path.join(localDir, "locks"), { recursive: true });
}

/** 名前のリモートがあればその名前、なければ null */
export async function resolveRemote(paths: RepoPaths, name: string): Promise<string | null> {
  const result = await runGit(paths.topLevel, ["remote", "get-url", name], { allowFailure: true });
  return result.code === 0 ? name : null;
}

export async function isInitialized(paths: RepoPaths): Promise<boolean> {
  try {
    await access(path.join(paths.dataDir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** コミットの作者が決まるか。決まらなければ IDENTITY_MISSING（捏造しない） */
export async function requireIdentity(
  repo: Pick<GitRepo, "dataDir">,
): Promise<{ name: string; email: string }> {
  const name = (
    await runGit(repo.dataDir, ["config", "--get", "user.name"], { allowFailure: true })
  ).stdout.trim();
  const email = (
    await runGit(repo.dataDir, ["config", "--get", "user.email"], { allowFailure: true })
  ).stdout.trim();
  if (!name || !email) {
    throw new OperationError(
      "IDENTITY_MISSING",
      "git の user.name と user.email を設定する（claim と実績の作者に使う）",
    );
  }
  return { name, email };
}

/** 主体の既定のユーザ名。git の user.name、なければ OS のユーザ名（ホスト名は含めない） */
export async function defaultUser(repo: Pick<GitRepo, "dataDir">): Promise<string> {
  const name = (
    await runGit(repo.dataDir, ["config", "--get", "user.name"], { allowFailure: true })
  ).stdout.trim();
  return name || os.userInfo().username;
}
