// 照合に使う事実の収集（ST-4〜ST-6、ADR-028）。取れない事実は undefined（不明）

import { toIsoDateTime, type Status } from "../model/common.js";
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
   * ブランチを記録した時刻（ISO）。ブランチ名で引いた PR のうち、開いていない（マージ済みか閉じた）もので
   * 作成がこれより前のものは、同じ名前を使い回した前の作業の PR とみなして PR はないと読む（ST-6）。
   * 記録した番号で引くときは見ない
   */
  since?: string | undefined;
  /** claim が記録した作業ブランチの起点の SHA（`branch_base`）。先端がこれと同じならマージ済みにしない（ST-4）。なければ見ない */
  start?: string | undefined;
}

export interface BranchFacts {
  facts: Facts;
  /** gh が見つけた PR の番号。チケットに記録がなければ照合がこれを `pr` に記録する（ST-6）。取れなければ undefined */
  pr?: number;
  /** 見つけた PR の作成時刻（ISO）。照合が実装の Run を閉じるときの finished_at（RN-6）。取れなければ undefined */
  prCreatedAt?: string;
  /** 見つけた PR のマージ時刻（ISO）。ブランチが消えて push の時刻を取れないとき、照合が手直しの Run を閉じる finished_at（RN-6） */
  prMergedAt?: string;
  /** マージされた PR の追加・削除の行数。照合がチケットの `lines` に記録する（MT-6）。マージ前・読めないときは undefined */
  prLines?: PrLines;
  /** gh が「PR がない」と答えた。pr_* はすべて偽になるが、閉じた PR とは区別する（ST-5） */
  prMissing?: boolean;
  /** ブランチ名で見つけたが、`since` より前に作られ開いていなかったので外した PR（照合が警告する） */
  ignoredPr?: { number: number; state: string; createdAt: string };
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
 * 作業ブランチを切る起点の SHA（照合の base の先端）。claim が `branch_base` に記録し、同じ SHA からブランチを切る（ST-4）。
 * ここでは fetch しない（claim は findMergedLeftover で base を取り込んだ後に呼ぶ）。base がなければ undefined
 */
export async function baseTip(repo: GitRepo): Promise<string | undefined> {
  const base = await baseRef(repo);
  return base ? await sha(repo, base) : undefined;
}

/**
 * 記録しようとするブランチ名に、前の作業でマージ済みのブランチが残っているか（ST-3）。
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
    const baseFetch = await runGit(
      repo.dataDir,
      [
        "fetch",
        repo.remote,
        `+refs/heads/${repo.baseBranch}:refs/remotes/${repo.remote}/${repo.baseBranch}`,
      ],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    // base に届かなければリモートに届かないとみなし、ブランチの取り込みで待たない
    const fetched =
      baseFetch.code === 0
        ? await runGit(repo.dataDir, ["fetch", repo.remote, `+refs/heads/${branch}:${remoteRef}`], {
            allowFailure: true,
            timeoutMs: 60_000,
          })
        : undefined;
    // リモートで消えたブランチの追跡 ref は古い名残なので見ない
    if (!fetched || !/couldn't find remote ref/i.test(fetched.stderr)) refs.push(remoteRef);
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
    // ff マージと区別できない）。in_progress で push していないブランチはまだ作業がないとみなして merged にしない。
    // push した後は、claim が記録した起点（start）と先端が同じなら作業がないとみなして merged にしない（t764）。
    // claim はブランチをその起点から切るので、claim の後に人が別の起点から切り直した形だけが拾えない（受け入れる）。
    // 起点のない前からのチケットは祖先かだけで判定する。先端のコミット日時と branch_at を比べると
    // PC ごとの時計のずれで判定が変わるので採らない。push せずローカルで ff マージした形は拾えない
    const tipSha = await sha(repo, tip);
    const same = tipSha === (await sha(repo, base));
    const unworked = opts.start !== undefined && tipSha === opts.start;
    const fresh = opts.status === "in_progress" && facts.branch_pushed === false;
    const r =
      same || fresh || unworked
        ? undefined
        : await runGit(repo.dataDir, ["merge-base", "--is-ancestor", tip, base], {
            allowFailure: true,
          });
    if (same || fresh || unworked || r?.code === 1) facts.branch_merged = false;
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
    ...(pr.createdAt === undefined ? {} : { prCreatedAt: pr.createdAt }),
    ...(pr.mergedAt === undefined ? {} : { prMergedAt: pr.mergedAt }),
    ...(pr.lines === undefined ? {} : { prLines: pr.lines }),
    ...(pr.missing ? { prMissing: true } : {}),
    ...(pr.ignored ? { ignoredPr: pr.ignored } : {}),
  };
}

/** gh pr view の JSON の形（取る項目は PR_FIELDS） */
interface PrView {
  number?: number;
  state: string;
  isDraft: boolean;
  mergedAt?: string | null;
  createdAt?: string | null;
  additions?: number | null;
  deletions?: number | null;
  /** 変えたファイルの数（PR_FILE_FIELDS で取る） */
  changedFiles?: number | null;
  /** 変えたファイル（PR_FILE_FIELDS で取る。gh は先頭の 100 件までしか返さない） */
  files?: Array<{ path?: unknown }> | null;
}

const PR_FIELDS = "number,state,isDraft,mergedAt,createdAt,additions,deletions";

/** PR の追加・削除の行数（gh の additions・deletions。base との差分で、squash のコミットの行数と同じ） */
export interface PrLines {
  additions: number;
  deletions: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * マージされた PR の行数だけを採る。開いている PR の行数は push のたびに変わり、閉じた PR の行数は base に入っていないので採らない。
 * 行数が読めなければ undefined
 */
function mergedLines(data: PrView): PrLines | undefined {
  return data.state === "MERGED" && isCount(data.additions) && isCount(data.deletions)
    ? { additions: data.additions, deletions: data.deletions }
    : undefined;
}

/**
 * 記録した番号の PR の行数（`dg metrics lines` が done のチケットに後から記録する。MT-6）。
 * マージされていない・gh がない・読めないときは理由を返す
 */
export async function fetchMergedPrLines(
  repo: GitRepo,
  pr: number,
): Promise<{ lines: PrLines; reason?: undefined } | { lines?: undefined; reason: string }> {
  const viewed = await viewPr(repo, String(pr));
  if (!viewed) return { reason: "Cannot read the PR with gh" };
  if ("missing" in viewed) return { reason: `PR #${pr} not found` };
  if (viewed.data.state !== "MERGED")
    return { reason: `PR #${pr} is not merged (${String(viewed.data.state).toLowerCase()})` };
  const lines = mergedLines(viewed.data);
  return lines ? { lines } : { reason: `Cannot read the changed lines of PR #${pr}` };
}

const PR_FILE_FIELDS = "number,state,changedFiles,files";

/**
 * 記録した番号の PR が変えたファイルのパス（`dg metrics sources` が振り返りの指標の元のデータとして返す。MT-8）。
 * 行数と同じく、マージされた PR だけを採る（開いている PR のファイルは push のたびに変わり、閉じた PR の変更は base に入っていない）。
 * マージされていない・gh がない・読めないときは理由を返す。gh pr view の files は先頭の 100 件までなので、
 * 件数（changedFiles）と合わないときは、欠けた一覧を返さずに理由を返す
 */
export async function fetchMergedPrFiles(
  repo: GitRepo,
  pr: number,
): Promise<{ files: string[]; reason?: undefined } | { files?: undefined; reason: string }> {
  const viewed = await viewPr(repo, String(pr), PR_FILE_FIELDS);
  if (!viewed) return { reason: "Cannot read the PR with gh" };
  if ("missing" in viewed) return { reason: `PR #${pr} not found` };
  const { state, changedFiles, files } = viewed.data;
  if (state !== "MERGED")
    return { reason: `PR #${pr} is not merged (${String(state).toLowerCase()})` };
  const paths = Array.isArray(files)
    ? files.map((f) => f?.path).filter((p): p is string => typeof p === "string" && p !== "")
    : undefined;
  if (!paths || !isCount(changedFiles) || paths.length !== files?.length)
    return { reason: `Cannot read the changed files of PR #${pr}` };
  if (paths.length !== changedFiles)
    return {
      reason: `PR #${pr} changed ${changedFiles} files and gh returned ${paths.length} of them`,
    };
  return { files: paths };
}

/** gh pr view を番号かブランチ名で呼ぶ。PR がなければ missing、gh がない・読めないときは undefined */
async function viewPr(
  repo: GitRepo,
  selector: string,
  fields: string = PR_FIELDS,
): Promise<{ data: PrView } | { missing: true } | undefined> {
  if (!(await hasGh(repo.topLevel))) return undefined;
  try {
    const result = await runGh(repo.topLevel, ["pr", "view", selector, "--json", fields], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (result.code !== 0) {
      return /no pull requests found|could not find|not found/i.test(result.stderr)
        ? { missing: true }
        : undefined;
    }
    return { data: JSON.parse(result.stdout) as PrView };
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

/** 品質ゲート（dg gate）が見る PR の事実 */
export interface PrGateFacts {
  number: number;
  state: string;
  isDraft: boolean;
  /** gh の mergeable（MERGEABLE・CONFLICTING・UNKNOWN） */
  mergeable: string;
  /** gh の headRefOid（PR の先端のコミット）。読めなければ undefined（t750） */
  head: string | undefined;
}

/**
 * 品質ゲートの PR の事実を、番号かブランチ名で読む。PR がなければ missing、gh がない・読めないときは理由を返す
 */
export async function fetchPrGateFacts(
  repo: GitRepo,
  selector: string,
): Promise<{ pr: PrGateFacts } | { missing: true } | { reason: string }> {
  if (!(await hasGh(repo.topLevel))) return { reason: "gh is not installed" };
  try {
    const result = await runGh(
      repo.topLevel,
      ["pr", "view", selector, "--json", "number,state,isDraft,mergeable,headRefOid"],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      return /no pull requests found|could not find|not found/i.test(result.stderr)
        ? { missing: true }
        : { reason: `Cannot read the PR with gh (${result.stderr.trim().split("\n")[0] ?? ""})` };
    }
    let data: Partial<PrGateFacts> & { headRefOid?: unknown };
    try {
      data = JSON.parse(result.stdout) as typeof data;
    } catch {
      return { reason: "Cannot read the output of gh" };
    }
    if (!Number.isInteger(data.number)) return { reason: "Cannot read the PR number from gh" };
    return {
      pr: {
        number: data.number!,
        state: String(data.state ?? ""),
        isDraft: data.isDraft === true,
        mergeable: String(data.mergeable ?? "UNKNOWN"),
        head:
          typeof data.headRefOid === "string" && data.headRefOid !== ""
            ? data.headRefOid
            : undefined,
      },
    };
  } catch (error) {
    if (error instanceof GitError) return { reason: `Cannot call gh (${error.message})` };
    throw error;
  }
}

/** 時刻の文字列だけを採る（gh は null を返しうる） */
const isoOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;

/**
 * PR の作成時刻（ISO）。`ticket update --pr` が実装の Run を閉じるときの finished_at（RN-6）。
 * gh がない・PR が見つからない・読めないときは理由を返し、呼び出し側が今の時刻を使う
 */
export async function fetchPrCreatedAt(
  repo: GitRepo,
  pr: number,
): Promise<{ createdAt: string; reason?: undefined } | { createdAt?: undefined; reason: string }> {
  const viewed = await viewPr(repo, String(pr));
  if (!viewed) return { reason: "Cannot read the PR with gh" };
  if ("missing" in viewed) return { reason: `PR #${pr} not found` };
  const createdAt = isoOrUndefined(viewed.data.createdAt);
  return createdAt ? { createdAt } : { reason: `Cannot read the creation time of PR #${pr}` };
}

async function collectPrFacts(
  repo: GitRepo,
  branch: string,
  pr: number | undefined,
  since: string | undefined,
): Promise<{
  facts: Facts;
  number?: number;
  createdAt?: string;
  mergedAt?: string;
  lines?: PrLines;
  missing?: boolean;
  ignored?: { number: number; state: string; createdAt: string };
}> {
  const missing = { facts: { pr_open: false, pr_draft: false, pr_merged: false }, missing: true };
  const viewed = await viewPr(repo, pr ? String(pr) : branch);
  if (!viewed) return { facts: {} };
  if ("missing" in viewed) return missing;
  const data = viewed.data;
  const createdAt = isoOrUndefined(data.createdAt);
  // ブランチを記録する前に作られ、開いていない PR（マージ済みも閉じたものも）は、同じブランチ名で出した前の作業のもの（t206・t747）。
  // 開いたままの PR は、記録より前に作られても今の作業の PR として使う（手放して claim し直した後も続けられるように）。
  // 作成の時刻が読めないときは外さない
  if (
    pr === undefined &&
    since !== undefined &&
    data.state !== "OPEN" &&
    createdAt !== undefined &&
    Date.parse(createdAt) < Date.parse(since)
  ) {
    return Number.isInteger(data.number) && (data.number as number) > 0
      ? {
          ...missing,
          ignored: { number: data.number as number, state: data.state, createdAt },
        }
      : missing;
  }
  const facts: Facts = {
    pr_open: data.state === "OPEN",
    pr_draft: data.isDraft,
    pr_merged: data.state === "MERGED",
  };
  const mergedAt = isoOrUndefined(data.mergedAt);
  const lines = mergedLines(data);
  return Number.isInteger(data.number) && (data.number as number) > 0
    ? {
        facts,
        number: data.number as number,
        ...(createdAt ? { createdAt } : {}),
        ...(mergedAt ? { mergedAt } : {}),
        ...(lines ? { lines } : {}),
      }
    : { facts };
}

/**
 * 作業ブランチの追跡ブランチにあって base にないコミット（マージを除く）の、sha とコミッタの時刻（push の近似、ISO）。
 * lint が実装の Run の期間に入らないコミットを探すのに使う。fetch はしない（照合と同じく手元の ref を読む）。
 * リモートがない・追跡ブランチがない（push していない・マージ後に消した）・base がないときは undefined
 */
export async function branchCommitTimes(
  repo: GitRepo,
  branch: string,
): Promise<{ sha: string; at: string }[] | undefined> {
  if (!repo.remote) return undefined;
  const ref = `refs/remotes/${repo.remote}/${branch}`;
  if (!(await refExists(repo, ref))) return undefined;
  const base = await baseRef(repo);
  if (!base) return undefined;
  const r = await runGit(
    repo.dataDir,
    ["log", "--no-merges", "--format=%H %cI", `${base}..${ref}`],
    {
      allowFailure: true,
    },
  );
  if (r.code !== 0) return undefined;
  const commits: { sha: string; at: string }[] = [];
  for (const line of r.stdout.split("\n")) {
    const [sha, at] = line.trim().split(" ");
    if (sha && isoOrUndefined(at) !== undefined) commits.push({ sha, at: at as string });
  }
  return commits;
}

/**
 * 作業ブランチに最後に push したコミットの時刻（ISO、UTC）。リモートの追跡ブランチの先端のコミットの時刻で、
 * 照合ともう一度の claim が、開いたままの手直しの Run を閉じる finished_at にする（RN-6）。
 * fetch を渡せばそのブランチだけ取り込んでから読む（照合は fetchAll の後に呼ぶので渡さない）。
 * リモートがない・追跡ブランチがない（push していない・マージ後に消した）・読めないときは undefined
 */
export async function lastPushedAt(
  repo: GitRepo,
  branch: string,
  opts: { fetch?: boolean } = {},
): Promise<string | undefined> {
  return (await remoteTip(repo, branch, opts))?.at;
}

/** 作業ブランチのリモートの先端（追跡ブランチ）の SHA と、そのコミットの時刻（ISO、UTC） */
export interface BranchTip {
  sha: string;
  at: string;
}

/**
 * 作業ブランチのリモートの先端の SHA とコミットの時刻。lastPushedAt と同じ読み方（fetch・読めないときは undefined）。
 * 見直しの新しさ（dg gate の review・dg next の段階）は、見直しに記録した SHA があればこの SHA と比べ、なければ時刻と比べる（t763）
 */
export async function remoteTip(
  repo: GitRepo,
  branch: string,
  opts: { fetch?: boolean } = {},
): Promise<BranchTip | undefined> {
  if (!repo.remote) return undefined;
  const ref = `refs/remotes/${repo.remote}/${branch}`;
  if (opts.fetch) {
    const fetched = await runGit(
      repo.dataDir,
      ["fetch", repo.remote, `+refs/heads/${branch}:${ref}`],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    // リモートで消えたブランチの追跡 ref は古い名残なので見ない
    if (fetched.code !== 0 && /couldn't find remote ref/i.test(fetched.stderr)) return undefined;
  }
  if (!(await refExists(repo, ref))) return undefined;
  const r = await runGit(repo.dataDir, ["log", "-1", "--format=%H %cI", ref], {
    allowFailure: true,
  });
  const [tip, raw] = r.stdout.trim().split(" ");
  const at = isoOrUndefined(raw);
  return tip && at !== undefined ? { sha: tip, at: toIsoDateTime(new Date(at)) } : undefined;
}

/**
 * 作業ブランチのローカルの先端（refs/heads/<branch>）の SHA。見直しの Run と保留の見直しの結果が、見直した状態として記録する（t763）。
 * fetch はしない。ブランチがない・読めないときは undefined
 */
export async function localTip(repo: GitRepo, branch: string): Promise<string | undefined> {
  const r = await runGit(
    repo.dataDir,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    { allowFailure: true },
  );
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : undefined;
}
