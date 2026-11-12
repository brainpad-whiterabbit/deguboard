// 取り込み・push・同期状態（SY-2、SY-4、UI-6）

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  attributesFile,
  isMergeDriverPath,
  MERGE_LOG_ENV,
  MERGE_PREFER_ENV,
  mergeDocuments,
  type ResolvedField,
} from "./merge.js";
import { DG_COMMIT_TRAILER } from "./outside.js";
import { abortRebase, markRebase, unmarkRebase } from "./rebase.js";
import type { GitRepo } from "./repo.js";
import { type ExecResult, GitError, runGit } from "./run.js";
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
/** 取り込みでドライバが解いた 1 件と、そのファイル（integrateLogged の結果） */
export type ResolvedFile = ResolvedField & { file: string };
export type PushResult =
  | { ok: true }
  | { ok: false; reason: "rejected" | "unreachable"; detail: string };

const git = (repo: GitRepo, args: string[], opts: Parameters<typeof runGit>[2] = {}) =>
  runGit(repo.dataDir, args, { localDir: repo.localDir, ...opts });

export function remoteRef(repo: GitRepo): string {
  return `refs/remotes/${repo.remote}/${DATA_BRANCH}`;
}

/** deguboard ブランチだけを取り込む。リモートにまだなければ remoteBranch: false。timeoutMs を過ぎたら届かないときと同じ失敗 */
export async function fetchData(repo: GitRepo, timeoutMs = 60_000): Promise<FetchResult> {
  if (!repo.remote) return { ok: true, remoteBranch: false };
  const result = await remoteGit(
    repo,
    ["fetch", repo.remote, `${DATA_BRANCH}:${remoteRef(repo)}`],
    timeoutMs,
  );
  if (result.code === 0) return { ok: true, remoteBranch: true };
  if (/couldn't find remote ref/i.test(result.stderr)) return { ok: true, remoteBranch: false };
  return { ok: false, detail: result.stderr.trim() };
}

/** 作業ブランチの照合に使うので、すべてのブランチを取り込む（消えたブランチは prune） */
export async function fetchAll(repo: GitRepo): Promise<FetchResult> {
  if (!repo.remote) return { ok: true, remoteBranch: false };
  const result = await remoteGit(repo, ["fetch", "--prune", repo.remote], 120_000);
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
  opts: { autostash?: boolean; resolve?: ResolveSide; log?: string } = {},
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
  // rebase はリモートの先端にローカルのコミットを積み直すので、ドライバの ours（%A）がリモート、theirs（%B）がローカルになる。
  // 自動で解いたフィールド（同じ status の時刻）も log に書くので、--resolve でなくても log を渡す
  const env: Record<string, string> | undefined = opts.log
    ? {
        ...(opts.resolve
          ? { [MERGE_PREFER_ENV]: opts.resolve === "remote" ? "ours" : "theirs" }
          : {}),
        [MERGE_LOG_ENV]: opts.log,
      }
    : undefined;
  // 時間切れや例外でも中止してから失敗を返す（途中の HEAD を基準に記録したり、その上でコミットしたりしない）。
  // dg ごと殺されたときに備えて印を置き、次の書き込みの入口（settleRebase）が取り消せるようにする（t753）
  await markRebase(repo);
  try {
    const result = await git(repo, args, { allowFailure: true, ...(env ? { env } : {}) }).catch(
      async (e: unknown) => {
        await abortRebase(repo);
        throw e;
      },
    );
    if (result.code === 0) return { ok: true, changed: (await headSha(repo)) !== before };
    try {
      const conflicts = (
        await git(repo, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true })
      ).stdout
        .split("\n")
        .filter(Boolean);
      return { ok: false, conflicts };
    } finally {
      await abortRebase(repo);
    }
  } finally {
    await unmarkRebase(repo);
  }
}

/** 取り込みの途中でドライバが書き足すログ（localDir に置く。書き込みのロックの中でだけ使うので名前は 1 つ） */
const RESOLVE_LOG = "resolve-log.jsonl";

/**
 * integrate に、ドライバが自動で解いたフィールドのログを付けて呼ぶ。全ての書き込みと sync の取り込みはこれを使い、
 * 自動で解いた時刻を警告に出せるようにする（SY-4）。取り込みを中止したときは解いた分も捨てられたので、resolved は空にする
 */
export async function integrateLogged(
  repo: GitRepo,
  opts: { autostash?: boolean; resolve?: ResolveSide } = {},
): Promise<{ result: IntegrateResult; resolved: ResolvedFile[] }> {
  const log = path.join(repo.localDir, RESOLVE_LOG);
  await writeFile(log, "");
  try {
    const result = await integrate(repo, { ...opts, log });
    return { result, resolved: result.ok ? await readResolveLog(log) : [] };
  } finally {
    await rm(log, { force: true });
  }
}

/** ドライバが書き足した 1 行 1 件の JSON を読む */
async function readResolveLog(file: string): Promise<ResolvedFile[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResolvedFile);
}

/** 競合したフィールド 1 件（dg sync の data.conflict_fields）。値がない（その側が消した）ときは null */
export interface ConflictField {
  file: string;
  field: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

/**
 * 競合したフィールドと両側の値（SY-4）。分岐点・ローカルの先頭（HEAD）・リモートの先頭の 3 つで、マージドライバと同じ判定
 * （mergeDocuments）を、採る側を渡さずに回して集める。rebase は止まったコミットで中止するので、git の報告する競合のファイルからは、
 * 後のコミットでぶつかる分が分からない。先頭どうしで比べれば、--resolve が積み直しの中で解く競合をまとめて示せる。
 * 中止した後（HEAD がローカルの先頭に戻った後）に呼ぶ。ドライバの対象でないファイル（config.yaml・workflows）と、
 * 片側にないファイル（add/add・削除）は行単位のマージなので入れない。
 * ローカルの途中のコミットで変えて先頭で分岐点の値に戻したフィールドは、先頭どうしではぶつからないので入らない。
 * manual でコミットしていない変更も HEAD にないので入らない
 */
export async function conflictFields(repo: GitRepo): Promise<ConflictField[]> {
  if (!repo.remote) return [];
  const remote = remoteRef(repo);
  const mb = await git(repo, ["merge-base", "HEAD", remote], { allowFailure: true });
  if (mb.code !== 0) return [];
  const base = mb.stdout.trim();
  const changed = async (to: string) =>
    (await git(repo, ["diff", "--name-only", "--no-renames", base, to])).stdout
      .split("\n")
      .filter(Boolean);
  const [local, upstream] = await Promise.all([changed("HEAD"), changed(remote)]);
  const both = local.filter((f) => upstream.includes(f) && isMergeDriverPath(f));
  const show = async (rev: string, file: string) => {
    const r = await git(repo, ["show", `${rev}:${file}`], { allowFailure: true });
    return r.code === 0 ? r.stdout : undefined;
  };
  const fields: ConflictField[] = [];
  for (const file of both) {
    const [o, l, r] = await Promise.all([base, "HEAD", remote].map((rev) => show(rev, file)));
    if (o === undefined || l === undefined || r === undefined) continue;
    // rebase と同じ向き：ours（%A）がリモート、theirs（%B）がローカル
    const outcome = await mergeDocuments(o, r, l);
    if (!outcome || outcome.ok) continue;
    for (const d of outcome.details) {
      fields.push({
        file,
        field: d.field,
        base: d.base ?? null,
        local: d.theirs ?? null,
        remote: d.ours ?? null,
      });
    }
  }
  return fields;
}

/** 警告に載せる値の上限の字数。全体は data.conflict_fields にある */
const VALUE_LIMIT = 80;

/** 本文のフィールドの名前（マージドライバの対象の 1 つ。frontmatter のフィールドは英語の名前のまま） */
export const BODY_FIELD = "本文";

/** 英語の文に出すフィールドの名前。本文は行のまとまりとして英語で言う */
export function fieldLabel(field: string): string {
  return field === BODY_FIELD ? "body lines" : field;
}

/** 文に出す値の字数（JSON の書き方で、上限を超えたら … で切る）。全体は data にある */
export function showValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
}

/** sync の警告に足す、競合したフィールドと両側の値の文（先頭に空白を付ける）。1 件もなければ空 */
export function describeConflictFields(fields: readonly ConflictField[]): string {
  if (fields.length === 0) return "";
  const items = fields.map(
    (f) =>
      `${f.file} ${fieldLabel(f.field)} (local ${showValue(f.local)}, remote ${showValue(f.remote)}, base ${showValue(f.base)})`,
  );
  return ` Conflicting fields (full values in data.conflict_fields): ${items.join("; ")}.`;
}

/**
 * 警告に足す、自動で解いたフィールドの文（SAME_STATUS_TIMES の規則。ファイル・フィールド・採った値・捨てた値）。1 件もなければ空。
 * 自動で解いたのは人が確かめていないので、どの値を捨てたかを残す（--resolve と違い、取り消すのは人が値を直す）。
 * sync は data.resolved に全体の値を返すので inResult を true にする。書き込みの結果には data.resolved がないので false にする
 */
export function describeAutoResolved(fields: readonly ResolvedFile[], inResult: boolean): string {
  const auto = fields.filter((f) => f.auto);
  if (auto.length === 0) return "";
  const items = auto.map(
    (f) =>
      `${f.file} ${f.field} (taken ${showValue(f.taken)}, discarded ${showValue(f.discarded)})`,
  );
  const full = inResult ? "; full values in data.resolved" : "";
  return `Resolved automatically, not a conflict (both sides have the same status and differ only in the time that goes with it, so the earlier time is taken${full}): ${items.join("; ")}.`;
}

/** 時間切れは、リモートに届かないときと同じ失敗にする（投げると CAS が自分のコミットを捨てずに抜ける。t753） */
async function remoteGit(repo: GitRepo, args: string[], timeoutMs: number): Promise<ExecResult> {
  try {
    return await git(repo, args, { allowFailure: true, timeoutMs });
  } catch (e) {
    if (e instanceof GitError && e.kind === "timeout")
      return {
        stdout: "",
        stderr: `git ${args[0]} did not finish in ${timeoutMs / 1000} seconds`,
        code: -1,
      };
    throw e;
  }
}

/** push の結果を --porcelain の行で判定する（文言に依存しない） */
export async function push(repo: GitRepo): Promise<PushResult> {
  if (!repo.remote) return { ok: false, reason: "unreachable", detail: "No remote" };
  const result = await remoteGit(
    repo,
    ["push", "--porcelain", "-u", repo.remote, `${DATA_BRANCH}:${DATA_BRANCH}`],
    60_000,
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
