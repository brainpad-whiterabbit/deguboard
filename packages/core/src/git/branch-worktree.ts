// 作業ブランチの worktree を作る（ST-3・AG-6）。claim（core/commands）と create_worktree の Action が同じ手順を使うよう、
// actions ではなく git の層に置く（commands は actions に依存しない。ADR-033）。git は引数配列で呼び、シェルを経由しない

import path from "node:path";
import { OperationError } from "../errors.js";
import type { GitRepo, RepoPaths } from "./repo.js";
import { runGit } from "./run.js";
import { findBranchWorktree } from "./worktree.js";

/**
 * `git check-ref-format --branch` 相当の検査。先頭の `-` を拒み、git にオプションとして読まれないようにする
 * （`--upload-pack=<コマンド>` のような注入で actions.shell を回り込ませない。AG-7）
 */
export function isSafeBranchName(name: string): boolean {
  if (name === "" || name === "@" || name.startsWith("-")) return false;
  // 制御文字・空白・~ ^ : ? * [ \ と、`..`・`@{`・`//` を含むもの
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** worktree.root（`<repo>` を置き換え、メインの作業ツリーからの相対）にブランチ名をつないだ場所 */
export function defaultWorktreePath(
  repo: Pick<RepoPaths, "commonDir" | "topLevel">,
  root: string,
  branch: string,
): string {
  const main =
    path.basename(repo.commonDir) === ".git" ? path.dirname(repo.commonDir) : repo.topLevel;
  const resolvedRoot = path.resolve(main, root.replaceAll("<repo>", path.basename(main)));
  return path.join(resolvedRoot, branch);
}

/** 作業ブランチの起点。リモートがあれば取り込んでから <remote>/<base>、なければローカルの <base> */
export async function branchStartPoint(
  cwd: string,
  repo: Pick<GitRepo, "remote">,
  base: string,
): Promise<string> {
  // base は config（Git で共有される）から来るので、ここでも検査する
  if (!isSafeBranchName(base)) {
    throw new OperationError("REJECTED", `Cannot be used as the base branch name: ${base}`);
  }
  if (!repo.remote) return base;
  await runGit(cwd, ["fetch", "--", repo.remote, base], { timeoutMs: 120_000 });
  return `${repo.remote}/${base}`;
}

/** base から作業ブランチ branch を切り、dir に checkout した worktree を作る。上流は付けない（--no-track） */
export async function createBranchWorktree(
  cwd: string,
  repo: Pick<GitRepo, "remote">,
  input: { branch: string; base: string; dir: string },
): Promise<{ branch: string; path: string; base: string }> {
  if (!isSafeBranchName(input.branch)) {
    throw new OperationError("REJECTED", `Cannot be used as a branch name: ${input.branch}`);
  }
  const start = await branchStartPoint(cwd, repo, input.base);
  await runGit(cwd, ["worktree", "add", "--no-track", "-b", input.branch, "--", input.dir, start]);
  return { branch: input.branch, path: input.dir, base: start };
}

/**
 * ブランチ branch の worktree を用意して場所を返す（claim。ST-3）。既にそのブランチの worktree があればそれを返し、
 * ローカルにブランチだけ残っていれば（unclaim の後など）そのブランチを dir に checkout し、なければ base から切って dir に作る。
 * created は今作ったかどうか（既存のものは false）。worktree.setup を回すかの判断に使う（t621）
 */
export async function ensureBranchWorktree(
  repo: GitRepo,
  input: { branch: string; base: string; dir: string },
): Promise<{ path: string; created: boolean }> {
  const existing = await findBranchWorktree(repo, input.branch);
  if (existing) return { path: existing, created: false };
  const local = await runGit(
    repo.topLevel,
    ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
    { allowFailure: true },
  );
  if (local.code === 0) {
    await runGit(repo.topLevel, ["worktree", "add", "--", input.dir, input.branch]);
    return { path: input.dir, created: true };
  }
  return { path: (await createBranchWorktree(repo.topLevel, repo, input)).path, created: true };
}
