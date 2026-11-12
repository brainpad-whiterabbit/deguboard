// rebase の途中の状態（SY-9）。dg の取り込み（integrate）は時間切れや例外でも rebase --abort してから失敗を返すが、
// dg のプロセスごと殺されると途中の状態（rebase-merge）が残る。途中の HEAD を外の変更の基準に記録したり、その上でコミットしたりしないよう、
// 書き込みの入口（write のロックの中）で片付ける。dg が始めた rebase には印（deguboard-local/rebase-by-dg）を置き、
// 印があれば落ちた dg の残りとして取り消す。印がなければ人が始めた rebase（UNRESOLVABLE_REMEDY の手順など）なので、取り消さずに止める

import { access, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { OperationError } from "../errors.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";

const MARK_FILE = "rebase-by-dg";

const markPath = (repo: Pick<GitRepo, "localDir">) => path.join(repo.localDir, MARK_FILE);

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** データの worktree で rebase が途中か（rebase-merge か rebase-apply があるか） */
export async function rebaseInProgress(repo: GitRepo): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const r = await runGit(repo.dataDir, ["rev-parse", "--git-path", name], { allowFailure: true });
    if (r.code === 0 && (await exists(path.resolve(repo.dataDir, r.stdout.trim())))) return true;
  }
  return false;
}

/** 途中の rebase が dg の残したものか（印があるか） */
export const rebaseLeftByDg = (repo: GitRepo) => exists(markPath(repo));

/** dg が rebase を始める前に印を置く */
export const markRebase = (repo: GitRepo) => writeFile(markPath(repo), `${process.pid}\n`);

/**
 * rebase を中止する。中止の失敗（時間切れを含む）は投げず、途中の状態が残ったかは rebaseInProgress で確かめる。
 * マージドライバの途中で止められた git は、ドライバに渡す一時ファイル（.merge_file_*）を worktree の根に残すので消す
 * （残すと未コミットの外の変更に見える）
 */
export async function abortRebase(repo: GitRepo): Promise<void> {
  await runGit(repo.dataDir, ["rebase", "--abort"], {
    localDir: repo.localDir,
    allowFailure: true,
  }).catch(() => undefined);
  const names = await readdir(repo.dataDir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.startsWith(".merge_file_")))
    await rm(path.join(repo.dataDir, name), { force: true });
}

/** rebase が途中でなければ印を外す（中止できずに残ったら、次の書き込みの入口が取り消せるよう印を残す） */
export async function unmarkRebase(repo: GitRepo): Promise<void> {
  if (!(await rebaseInProgress(repo))) await rm(markPath(repo), { force: true });
}

/** 人が始めた rebase の途中で止めるときの文（書き込みのエラーと、読むだけのコマンドの警告） */
export const REBASE_REMEDY =
  'Do not continue or abort it yourself; tell the human. If the human is resolving a conflict by the steps in "When sync stops" in dg guide overview, they finish it with git rebase --continue in the deguboard worktree and make the current state the baseline with dg adopt. Otherwise they cancel it with git rebase --abort';

/**
 * 書き込みの入口（write のロックの中）で、途中の rebase を片付ける。dg の残したものは中止して元の HEAD と作業ツリーに戻す
 * （--autostash で退けた変更も戻る）。人が始めたものと中止できなかったものは、書かずに SYNC_CONFLICT で止める（外の変更とは報告しない）
 */
export async function settleRebase(repo: GitRepo): Promise<void> {
  const left = await rebaseLeftByDg(repo);
  if (!(await rebaseInProgress(repo))) {
    if (left) await rm(markPath(repo), { force: true });
    return;
  }
  if (left) {
    await abortRebase(repo);
    await unmarkRebase(repo);
    if (!(await rebaseInProgress(repo))) return;
    throw new OperationError(
      "SYNC_CONFLICT",
      `A rebase that an earlier dg left halfway (it was stopped or timed out) could not be aborted, so dg does not write. ${REBASE_REMEDY}`,
    );
  }
  throw new OperationError(
    "SYNC_CONFLICT",
    `A rebase started outside dg is in progress in the deguboard worktree, so dg does not write. ${REBASE_REMEDY}`,
  );
}
