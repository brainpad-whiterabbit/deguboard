// 照合に使う事実の収集（ST-4〜ST-6、ADR-004）。取れない事実は undefined（不明）

import type { Facts } from "../workflow/conditions.js";
import type { GitRepo } from "./repo.js";
import { GitError, runGh, runGit } from "./run.js";

export interface PrFactsOptions {
  /** チケットに記録された PR 番号。なければブランチ名で引く */
  pr?: number | undefined;
  /** Workflow が pr_* を参照するときだけ gh を呼ぶ */
  needPr: boolean;
}

let ghAvailable: boolean | undefined;

/** gh があるか（1 プロセスで 1 回だけ調べる） */
export async function hasGh(cwd: string): Promise<boolean> {
  if (ghAvailable !== undefined) return ghAvailable;
  try {
    await runGh(cwd, ["--version"], { timeoutMs: 10_000 });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }
  return ghAvailable;
}

/** テスト用 */
export function resetGhCache(): void {
  ghAvailable = undefined;
}

async function refExists(repo: GitRepo, ref: string): Promise<boolean> {
  return (
    (await runGit(repo.dataDir, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }))
      .code === 0
  );
}

/** 呼ぶ前に fetchAll で取り込んでおく（ここでは fetch しない） */
export async function collectBranchFacts(
  repo: GitRepo,
  branch: string,
  opts: PrFactsOptions,
): Promise<Facts> {
  const facts: Facts = {};
  const localRef = `refs/heads/${branch}`;
  const remoteRef = repo.remote ? `refs/remotes/${repo.remote}/${branch}` : undefined;
  const local = await refExists(repo, localRef);
  const remote = remoteRef ? await refExists(repo, remoteRef) : false;
  facts.branch_exists = local || remote;
  if (repo.remote) facts.branch_pushed = remote;

  const tip = remote ? remoteRef : local ? localRef : undefined;
  const base =
    repo.remote && (await refExists(repo, `refs/remotes/${repo.remote}/${repo.baseBranch}`))
      ? `refs/remotes/${repo.remote}/${repo.baseBranch}`
      : (await refExists(repo, `refs/heads/${repo.baseBranch}`))
        ? `refs/heads/${repo.baseBranch}`
        : undefined;
  if (tip && base) {
    const r = await runGit(repo.dataDir, ["merge-base", "--is-ancestor", tip, base], {
      allowFailure: true,
    });
    if (r.code === 0) facts.branch_merged = true;
    else if (r.code === 1) facts.branch_merged = false;
  } else if (!tip && base) {
    // ブランチがないならマージ済みとは言えない（消えたブランチは警告の対象）
    facts.branch_merged = false;
  }

  if (opts.needPr) Object.assign(facts, await collectPrFacts(repo, branch, opts.pr));
  return facts;
}

async function collectPrFacts(
  repo: GitRepo,
  branch: string,
  pr: number | undefined,
): Promise<Facts> {
  if (!(await hasGh(repo.topLevel))) return {};
  try {
    const result = await runGh(
      repo.topLevel,
      ["pr", "view", pr ? String(pr) : branch, "--json", "state,isDraft,mergedAt"],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      if (/no pull requests found|could not find|not found/i.test(result.stderr)) {
        return { pr_open: false, pr_draft: false, pr_merged: false };
      }
      return {};
    }
    const data = JSON.parse(result.stdout) as { state: string; isDraft: boolean };
    return {
      pr_open: data.state === "OPEN",
      pr_draft: data.isDraft,
      pr_merged: data.state === "MERGED",
    };
  } catch (error) {
    if (error instanceof GitError) return {};
    throw error;
  }
}
