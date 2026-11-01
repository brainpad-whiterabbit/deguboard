// 照合に使う事実の収集（ST-4〜ST-6、ADR-004）。取れない事実は undefined（不明）

import type { Status } from "../model/common.js";
import type { Facts } from "../workflow/conditions.js";
import type { GitRepo } from "./repo.js";
import { GitError, runGh, runGit } from "./run.js";

export interface BranchFactsOptions {
  /** チケットに記録された PR 番号。なければブランチ名で引く */
  pr?: number | undefined;
  /** Workflow が pr_* を参照するときだけ gh を呼ぶ */
  needPr: boolean;
  /** チケットの今の Status。in_progress で push していないブランチは作業がまだないとみなす（ST-5） */
  status?: Status | undefined;
}

export interface BranchFacts {
  facts: Facts;
  /** gh が見つけた PR の番号。チケットに記録がなければ照合がこれを `pr` に記録する（ST-6）。取れなければ undefined */
  pr?: number;
  /** gh が「PR がない」と答えた。pr_* はすべて偽になるが、閉じた PR とは区別する（ST-5） */
  prMissing?: boolean;
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
async function sha(repo: GitRepo, ref: string): Promise<string> {
  return (await runGit(repo.dataDir, ["rev-parse", ref])).stdout.trim();
}

export async function collectBranchFacts(
  repo: GitRepo,
  branch: string,
  opts: BranchFactsOptions,
): Promise<BranchFacts> {
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
    // 先端が base と同じなら、切ったばかりで作業のないブランチとみなして merged にしない。
    // ff マージの直後も同じ形になるが、base が進めば真の祖先になり、PR があれば pr_merged で先に拾える。
    // 先端が base の真の祖先でも、commit のないブランチは base が進めば同じ形になる（グラフだけでは
    // ff マージと区別できない）。in_progress で push していないブランチはまだ作業がないとみなして merged にしない
    const same = (await sha(repo, tip)) === (await sha(repo, base));
    const fresh = opts.status === "in_progress" && facts.branch_pushed === false;
    const r =
      same || fresh
        ? undefined
        : await runGit(repo.dataDir, ["merge-base", "--is-ancestor", tip, base], {
            allowFailure: true,
          });
    if (same || fresh || r?.code === 1) facts.branch_merged = false;
    else if (r?.code === 0) facts.branch_merged = true;
  } else if (!tip && base) {
    // ブランチがないならマージ済みとは言えない（消えたブランチは警告の対象）
    facts.branch_merged = false;
  }

  if (!opts.needPr) return { facts };
  const pr = await collectPrFacts(repo, branch, opts.pr);
  Object.assign(facts, pr.facts);
  return {
    facts,
    ...(pr.number === undefined ? {} : { pr: pr.number }),
    ...(pr.missing ? { prMissing: true } : {}),
  };
}

async function collectPrFacts(
  repo: GitRepo,
  branch: string,
  pr: number | undefined,
): Promise<{ facts: Facts; number?: number; missing?: boolean }> {
  if (!(await hasGh(repo.topLevel))) return { facts: {} };
  try {
    const result = await runGh(
      repo.topLevel,
      ["pr", "view", pr ? String(pr) : branch, "--json", "number,state,isDraft,mergedAt"],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      if (/no pull requests found|could not find|not found/i.test(result.stderr)) {
        return { facts: { pr_open: false, pr_draft: false, pr_merged: false }, missing: true };
      }
      return { facts: {} };
    }
    const data = JSON.parse(result.stdout) as { number?: number; state: string; isDraft: boolean };
    const facts: Facts = {
      pr_open: data.state === "OPEN",
      pr_draft: data.isDraft,
      pr_merged: data.state === "MERGED",
    };
    return Number.isInteger(data.number) && (data.number as number) > 0
      ? { facts, number: data.number as number }
      : { facts };
  } catch (error) {
    if (error instanceof GitError) return { facts: {} };
    throw error;
  }
}
