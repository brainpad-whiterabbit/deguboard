// リポジトリの位置の解決（requirements.md 5.1、ADR-034）

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationError } from "../errors.js";
import type { UserSource } from "../model/actor.js";
import { pathExists } from "../storage/exists.js";
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
  return { topLevel, commonDir, ...repoDirsOf(commonDir) };
}

/** git common dir の下の置き場所：データ worktree（deguboard/）と Git 管理外の deguboard-local/。拡張の見張り（watch.ts）も同じ場所をここで求める */
export function repoDirsOf(commonDir: string): Pick<GitRepo, "dataDir" | "localDir"> {
  return {
    dataDir: path.join(commonDir, "deguboard"),
    localDir: path.join(commonDir, "deguboard-local"),
  };
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

/**
 * リモートの URL を Web で開ける URL（https://github.com/owner/repo）に直す。PR へのリンクに使う（UI-4）。
 * https・ssh:// と scp 形式（git@host:owner/repo）だけを直し、認証情報・ポート・末尾の .git は落とす。ローカルのパスなどは null
 */
export function webUrlOf(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  let host: string;
  let pathname: string;
  if (scp) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git+ssh:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    pathname = parsed.pathname;
  }
  const repoPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || repoPath.split("/").length < 2) return null;
  return `https://${host}/${repoPath}`;
}

/** リモートの Web の URL。リモートがない・直せなければ null */
export async function remoteWebUrl(
  repo: Pick<GitRepo, "topLevel" | "remote">,
): Promise<string | null> {
  if (!repo.remote) return null;
  const result = await runGit(repo.topLevel, ["remote", "get-url", repo.remote], {
    allowFailure: true,
  });
  return result.code === 0 ? webUrlOf(result.stdout) : null;
}

export async function isInitialized(paths: RepoPaths): Promise<boolean> {
  return pathExists(path.join(paths.dataDir, ".git"));
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

/**
 * 主体の既定のユーザ名と出どころ。git config の deguboard.user、なければ user.name、なければ OS のユーザ名（ホスト名は含めない）。
 * deguboard.user は人ごとの設定（--global かリポジトリの .git/config）で、環境変数の届かない入口（VS Code）でも効く
 */
export async function defaultUser(
  repo: Pick<GitRepo, "dataDir">,
): Promise<{ user: string; source: Extract<UserSource, "git-config" | "user.name" | "os"> }> {
  for (const [key, source] of [
    ["deguboard.user", "git-config"],
    ["user.name", "user.name"],
  ] as const) {
    const name = (
      await runGit(repo.dataDir, ["config", "--get", key], { allowFailure: true })
    ).stdout.trim();
    if (name) return { user: name, source };
  }
  return { user: osUserName(), source: "os" };
}

/**
 * OS のユーザ名。passwd に項目がない環境（コンテナで任意の UID を使うときなど）では os.userInfo() が例外を投げるので、
 * そのときは環境変数 USER、USERNAME（Windows）の順に使い、どちらもなければ "unknown" にする（主体名は必ず決まる）。
 * 引数はテストで差し替えるためのもの
 */
export function osUserName(
  userInfo: () => { username: string } = () => os.userInfo(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    // passwd に項目がない。下の代わりの値を使う
  }
  return env["USER"] || env["USERNAME"] || "unknown";
}
