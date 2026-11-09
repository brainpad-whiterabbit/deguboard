// 取り込み・push・同期状態（SY-2、SY-4、UI-6）

import { attributesFile, MERGE_LOG_ENV, MERGE_PREFER_ENV } from "./merge.js";
import { DG_COMMIT_TRAILER } from "./outside.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { DATA_BRANCH } from "./worktree.js";

export interface SyncStatus {
  /** 未 push のコミット数 */
  ahead: number;
  /** 取り込んでいないリモートのコミット数 */
  behind: number;
  /** 未コミットの変更があるか */
  dirty: boolean;
  remote: string | null;
}

/** dg sync --resolve で競合したフィールドに採る側（SY-4）。remote はリモートの値、local はローカルのコミットの値 */
export type ResolveSide = "remote" | "local";

export type FetchResult = { ok: true; remoteBranch: boolean } | { ok: false; detail: string };
export type IntegrateResult = { ok: true; changed: boolean } | { ok: false; conflicts: string[] };
export type PushResult =
  | { ok: true }
  | { ok: false; reason: "rejected" | "unreachable"; detail: string };

const git = (repo: GitRepo, args: string[], opts: Parameters<typeof runGit>[2] = {}) =>
  runGit(repo.dataDir, args, { localDir: repo.localDir, ...opts });

export function remoteRef(repo: GitRepo): string {
  return `refs/remotes/${repo.remote}/${DATA_BRANCH}`;
}

/** deguboard ブランチだけを取り込む。リモートにまだなければ remoteBranch: false */
export async function fetchData(repo: GitRepo): Promise<FetchResult> {
  if (!repo.remote) return { ok: true, remoteBranch: false };
  const result = await git(repo, ["fetch", repo.remote, `${DATA_BRANCH}:${remoteRef(repo)}`], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  if (result.code === 0) return { ok: true, remoteBranch: true };
  if (/couldn't find remote ref/i.test(result.stderr)) return { ok: true, remoteBranch: false };
  return { ok: false, detail: result.stderr.trim() };
}

/** 作業ブランチの照合に使うので、すべてのブランチを取り込む（消えたブランチは prune） */
export async function fetchAll(repo: GitRepo): Promise<FetchResult> {
  if (!repo.remote) return { ok: true, remoteBranch: false };
  const result = await git(repo, ["fetch", "--prune", repo.remote], {
    allowFailure: true,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) return { ok: false, detail: result.stderr.trim() };
  const has = await git(repo, ["show-ref", "--verify", "--quiet", remoteRef(repo)], {
    allowFailure: true,
  });
  return { ok: true, remoteBranch: has.code === 0 };
}

export async function headSha(repo: GitRepo): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function isDirty(repo: GitRepo): Promise<boolean> {
  return (await git(repo, ["status", "--porcelain"])).stdout.trim().length > 0;
}

/**
 * リモートの deguboard に rebase する。競合したら中止してローカルのコミットを残す（SY-4）。
 * frontmatter の別々のフィールドの変更はマージドライバ（merge.ts）が解く。.gitattributes がまだリモートにない間も効くよう、
 * deguboard-local/ の属性ファイルを core.attributesFile で渡す。
 * 空のコミットは落とす（--no-keep-empty）：別々に作った orphan の根（空のツリー）を積み直して履歴に割り込ませないため。
 * 根は作成時刻が同じ秒なら同じ SHA になって fast-forward し、違えば別の根になるので、落とさないと結果が時刻に依る
 */
export async function integrate(
  repo: GitRepo,
  opts: { autostash?: boolean; resolve?: { side: ResolveSide; log: string } } = {},
): Promise<IntegrateResult> {
  if (!repo.remote) return { ok: true, changed: false };
  const has = await git(repo, ["show-ref", "--verify", "--quiet", remoteRef(repo)], {
    allowFailure: true,
  });
  if (has.code !== 0) return { ok: true, changed: false };
  const before = await headSha(repo);
  const args = [
    "-c",
    `core.attributesFile=${attributesFile(repo)}`,
    "rebase",
    "--no-keep-empty",
    ...(opts.autostash ? ["--autostash"] : []),
    remoteRef(repo),
  ];
  // rebase はリモートの先端にローカルのコミットを積み直すので、ドライバの ours（%A）がリモート、theirs（%B）がローカルになる
  const env = opts.resolve
    ? {
        [MERGE_PREFER_ENV]: opts.resolve.side === "remote" ? "ours" : "theirs",
        [MERGE_LOG_ENV]: opts.resolve.log,
      }
    : undefined;
  const result = await git(repo, args, { allowFailure: true, ...(env ? { env } : {}) });
  if (result.code === 0) return { ok: true, changed: (await headSha(repo)) !== before };
  const conflicts = (
    await git(repo, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true })
  ).stdout
    .split("\n")
    .filter(Boolean);
  await git(repo, ["rebase", "--abort"], { allowFailure: true });
  return { ok: false, conflicts };
}

/** push の結果を --porcelain の行で判定する（文言に依存しない） */
export async function push(repo: GitRepo): Promise<PushResult> {
  if (!repo.remote) return { ok: false, reason: "unreachable", detail: "リモートがない" };
  const result = await git(
    repo,
    ["push", "--porcelain", "-u", repo.remote, `${DATA_BRANCH}:${DATA_BRANCH}`],
    {
      allowFailure: true,
      timeoutMs: 60_000,
    },
  );
  if (result.code === 0) return { ok: true };
  const rejected = result.stdout.split("\n").some((line) => line.startsWith("!"));
  return {
    ok: false,
    reason: rejected ? "rejected" : "unreachable",
    detail: (result.stderr || result.stdout).trim(),
  };
}

/** 指定したパスだけをコミットする（まとめ待ちの他の変更は残す）。コミットしたら true */
export async function commitPaths(
  repo: GitRepo,
  paths: string[],
  message: string,
): Promise<boolean> {
  await git(repo, ["add", "--", ...paths]);
  const staged = await git(repo, ["diff", "--cached", "--quiet", "--", ...paths], {
    allowFailure: true,
  });
  if (staged.code === 0) return false;
  await git(repo, [
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    message,
    "-m",
    DG_COMMIT_TRAILER,
    "--",
    ...paths,
  ]);
  return true;
}

/** まとめてコミットする。dg のコミットの印（DG_COMMIT_TRAILER）を末尾に付ける（dg の外のコミットと見分ける。SY-8） */
export async function commitAll(repo: GitRepo, message: string): Promise<boolean> {
  await git(repo, ["add", "-A"]);
  const staged = await git(repo, ["diff", "--cached", "--quiet"], { allowFailure: true });
  if (staged.code === 0) return false;
  await git(repo, ["commit", "--quiet", "--no-verify", "-m", message, "-m", DG_COMMIT_TRAILER]);
  return true;
}

export async function amendAll(repo: GitRepo): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "--no-verify", "--amend", "--no-edit"]);
}

export async function resetHard(repo: GitRepo, sha: string): Promise<void> {
  await git(repo, ["reset", "--hard", "--quiet", sha]);
}

export async function syncStatus(repo: GitRepo): Promise<SyncStatus> {
  const dirty = await isDirty(repo);
  if (!repo.remote) return { ahead: 0, behind: 0, dirty, remote: null };
  const has = await git(repo, ["show-ref", "--verify", "--quiet", remoteRef(repo)], {
    allowFailure: true,
  });
  if (has.code !== 0) {
    const ahead = Number((await git(repo, ["rev-list", "--count", "HEAD"])).stdout.trim());
    return { ahead, behind: 0, dirty, remote: repo.remote };
  }
  const out = (
    await git(repo, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef(repo)}`])
  ).stdout.trim();
  const [ahead = "0", behind = "0"] = out.split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind), dirty, remote: repo.remote };
}
