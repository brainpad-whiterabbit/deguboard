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
  /**
   * ブランチを記録した時刻（ISO）。ブランチ名で引いた PR がこれより前にマージされていたら、
   * 同じ名前を使い回した別の作業の PR とみなして PR はないと読む（ST-6）。記録した番号で引くときは見ない
   */
  since?: string | undefined;
}

export interface BranchFacts {
  facts: Facts;
  /** gh が見つけた PR の番号。チケットに記録がなければ照合がこれを `pr` に記録する（ST-6）。取れなければ undefined */
  pr?: number;
  /** gh が「PR がない」と答えた。pr_* はすべて偽になるが、閉じた PR とは区別する（ST-5） */
  prMissing?: boolean;
  /** ブランチ名で見つけたが、`since` より前にマージされていたので外した PR（照合が警告する） */
  ignoredPr?: { number: number; mergedAt: string };
}

let ghAvailable: boolean | undefined;

/** gh があるか（1 プロセスで 1 回だけ調べる） */
async function hasGh(cwd: string): Promise<boolean> {
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

/** 照合の base。リモートの追跡ブランチがあればそれ、なければローカルのもの */
async function baseRef(repo: GitRepo): Promise<string | undefined> {
  if (repo.remote && (await refExists(repo, `refs/remotes/${repo.remote}/${repo.baseBranch}`)))
    return `refs/remotes/${repo.remote}/${repo.baseBranch}`;
  if (await refExists(repo, `refs/heads/${repo.baseBranch}`))
    return `refs/heads/${repo.baseBranch}`;
  return undefined;
}

/**
 * 記録しようとするブランチ名に、前の作業でマージ済みのブランチが残っているか（ADR-004）。
 * 残ったブランチの先端は base の真の祖先なので、同じ名前で claim すると照合が branch_merged で done にする。
 * 残っていればその ref を返す。先端が base と同じ（切ったばかり）・base にない作業がある・ref がないときは undefined。
 * claim の取り込みは deguboard ブランチだけなので、ここで base と対象のブランチを取り込む。取り込めなければ手元の ref で判定する
 */
export async function findMergedLeftover(
  repo: GitRepo,
  branch: string,
): Promise<string | undefined> {
  const refs = [`refs/heads/${branch}`];
  if (repo.remote) {
    const remoteRef = `refs/remotes/${repo.remote}/${branch}`;
    await runGit(
      repo.dataDir,
      [
        "fetch",
        repo.remote,
        `+refs/heads/${repo.baseBranch}:refs/remotes/${repo.remote}/${repo.baseBranch}`,
      ],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    const fetched = await runGit(
      repo.dataDir,
      ["fetch", repo.remote, `+refs/heads/${branch}:${remoteRef}`],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    // リモートで消えたブランチの追跡 ref は古い名残なので見ない
    if (!/couldn't find remote ref/i.test(fetched.stderr)) refs.push(remoteRef);
  }
  const base = await baseRef(repo);
  if (!base) return undefined;
  const baseSha = await sha(repo, base);
  for (const ref of refs) {
    if (!(await refExists(repo, ref))) continue;
    if ((await sha(repo, ref)) === baseSha) continue;
    const r = await runGit(repo.dataDir, ["merge-base", "--is-ancestor", ref, base], {
      allowFailure: true,
    });
    if (r.code === 0) return ref.replace(/^refs\/(heads|remotes)\//, "");
  }
  return undefined;
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
  const base = await baseRef(repo);
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
  const pr = await collectPrFacts(repo, branch, opts.pr, opts.since);
  Object.assign(facts, pr.facts);
  return {
    facts,
    ...(pr.number === undefined ? {} : { pr: pr.number }),
    ...(pr.missing ? { prMissing: true } : {}),
    ...(pr.ignored ? { ignoredPr: pr.ignored } : {}),
  };
}

async function collectPrFacts(
  repo: GitRepo,
  branch: string,
  pr: number | undefined,
  since: string | undefined,
): Promise<{
  facts: Facts;
  number?: number;
  missing?: boolean;
  ignored?: { number: number; mergedAt: string };
}> {
  const missing = { facts: { pr_open: false, pr_draft: false, pr_merged: false }, missing: true };
  if (!(await hasGh(repo.topLevel))) return { facts: {} };
  try {
    const result = await runGh(
      repo.topLevel,
      ["pr", "view", pr ? String(pr) : branch, "--json", "number,state,isDraft,mergedAt"],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      if (/no pull requests found|could not find|not found/i.test(result.stderr)) {
        return missing;
      }
      return { facts: {} };
    }
    const data = JSON.parse(result.stdout) as {
      number?: number;
      state: string;
      isDraft: boolean;
      mergedAt?: string | null;
    };
    // ブランチを記録する前にマージされた PR は、同じブランチ名で出した前の作業のもの（t206）
    if (
      pr === undefined &&
      since !== undefined &&
      data.state === "MERGED" &&
      typeof data.mergedAt === "string" &&
      Date.parse(data.mergedAt) < Date.parse(since)
    ) {
      return Number.isInteger(data.number) && (data.number as number) > 0
        ? { ...missing, ignored: { number: data.number as number, mergedAt: data.mergedAt } }
        : missing;
    }
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
