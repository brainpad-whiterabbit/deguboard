// 作業ブランチの変更の一覧と、片側のファイルの中身（UI-4）。読むだけで、fetch もしない。
// 比べるのは base（`git.base_branch`）と作業ブランチの merge-base から作業ブランチの先端まで（`base...branch`。PR と同じ見え方）。
// 手元の ref だけを見るので、リモートの更新は同期（dg sync）で取り込んでから映る

import { OperationError } from "../errors.js";
import { baseRef, refExists } from "./facts.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";

/** 変更の種類。git の name-status の A・M・D・R・C（T は modified に入れる） */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface ChangedFile {
  kind: ChangeKind;
  /** 作業ブランチの側のパス（削除なら base の側のパス） */
  path: string;
  /** 名前を変えた・写したときの元のパス。ほかは null */
  old_path: string | null;
  /** 足した行と消した行。バイナリなら null */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface BranchChanges {
  branch: string;
  /** 比べた base の ref（origin/main か main） */
  base_ref: string;
  /** 比べた作業ブランチの ref（origin/feat/x か feat/x） */
  head_ref: string;
  /** 左側（merge-base）と右側（作業ブランチの先端）のコミット */
  base_commit: string;
  head_commit: string;
  files: ChangedFile[];
}

/** 片側のファイルの中身。ない（追加の左・削除の右）なら exists が false で text は空 */
export interface FileAtSide {
  path: string;
  commit: string;
  exists: boolean;
  /** NUL を含むので文字として出さない。text は空 */
  binary: boolean;
  /** サブモジュール（木の項目が commit）。中身は出さず、text はそのコミットの ID */
  submodule: boolean;
  text: string;
}

export type DiffSide = "base" | "head";

const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

async function revParse(repo: GitRepo, ref: string): Promise<string> {
  return (
    await runGit(repo.topLevel, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  ).stdout.trim();
}

/**
 * 作業ブランチの ref。リモートの追跡ブランチとローカルのブランチのうち新しい方：
 * ローカルがリモートを含む（同じか先に進んでいる）ならローカル、ほか（リモートが先・分かれた）はリモート（PR と同じ）。
 * どちらもなければ NOT_FOUND で、「同期すれば取り込める」かを添える
 */
async function headRef(repo: GitRepo, branch: string): Promise<string> {
  const local = `refs/heads/${branch}`;
  const remote = repo.remote ? `refs/remotes/${repo.remote}/${branch}` : undefined;
  const hasLocal = await refExists(repo, local);
  const hasRemote = remote ? await refExists(repo, remote) : false;
  if (hasLocal && hasRemote) {
    const r = await runGit(repo.topLevel, ["merge-base", "--is-ancestor", remote!, local], {
      allowFailure: true,
    });
    return r.code === 0 ? local : remote!;
  }
  if (hasLocal) return local;
  if (hasRemote) return remote!;
  // 画面はエラーの message だけを出すので、理由と次の手を message に入れる
  throw new OperationError(
    "NOT_FOUND",
    `ブランチ ${branch} がローカルにもリモートの追跡ブランチにもないので、変更を出せない。` +
      (repo.remote
        ? `リモートにあれば dg sync か git fetch ${repo.remote} で取り込んでから開き直す`
        : "リモートがないので、このリポジトリで作ったブランチだけを見られる"),
  );
}

/** base と作業ブランチの ref と、両側のコミット（merge-base と先端）。base がない・共通の祖先がなければ NOT_FOUND */
export async function resolveChangeRefs(
  repo: GitRepo,
  branch: string,
): Promise<{ base: string; head: string; baseCommit: string; headCommit: string }> {
  const head = await headRef(repo, branch);
  const base = await baseRef(repo);
  if (!base) {
    throw new OperationError("NOT_FOUND", `base のブランチ ${repo.baseBranch} がない`);
  }
  const mb = await runGit(repo.topLevel, ["merge-base", base, head], { allowFailure: true });
  if (mb.code !== 0) {
    throw new OperationError(
      "NOT_FOUND",
      `${short(head)} と ${short(base)} に共通の祖先がない`,
      mb.stderr.trim() || undefined,
    );
  }
  return { base, head, baseCommit: mb.stdout.trim(), headCommit: await revParse(repo, head) };
}

/** 一覧の git diff に共通の引数。利用者の設定（外部の diff・相対パス）に左右されないようにし、名前の変更を拾う */
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-relative", "-M", "-z"];

/** 作業ブランチの変更の一覧（追加・変更・削除・名前の変更の別と行数）。パスは git の並び（パスの順） */
export async function listBranchChanges(repo: GitRepo, branch: string): Promise<BranchChanges> {
  const refs = await resolveChangeRefs(repo, branch);
  const range = [refs.baseCommit, refs.headCommit];
  const [names, numbers] = await Promise.all([
    runGit(repo.topLevel, [...DIFF_ARGS, "--name-status", ...range, "--"]),
    runGit(repo.topLevel, [...DIFF_ARGS, "--numstat", ...range, "--"]),
  ]);
  return {
    branch,
    base_ref: short(refs.base),
    head_ref: short(refs.head),
    base_commit: refs.baseCommit,
    head_commit: refs.headCommit,
    files: mergeChanges(parseNameStatus(names.stdout), parseNumstat(numbers.stdout)),
  };
}

export interface NameStatusEntry {
  kind: ChangeKind;
  path: string;
  old_path: string | null;
}

/** `git diff --name-status -z` を読む。R・C は「R087\0元\0先\0」、ほかは「M\0パス\0」 */
export function parseNameStatus(out: string): NameStatusEntry[] {
  const parts = out.split("\0");
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!status) continue;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const from = parts[i++] ?? "";
      const to = parts[i++] ?? "";
      entries.push({ kind: letter === "R" ? "renamed" : "copied", path: to, old_path: from });
      continue;
    }
    const p = parts[i++] ?? "";
    const kind: ChangeKind = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    entries.push({ kind, path: p, old_path: null });
  }
  return entries;
}

export interface NumstatEntry {
  path: string;
  additions: number | null;
  deletions: number | null;
}

/** `git diff --numstat -z` を読む。名前の変更は「足\t消\t\0元\0先\0」、バイナリは数が「-」 */
export function parseNumstat(out: string): NumstatEntry[] {
  const parts = out.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < parts.length;) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let p = m[3]!;
    if (p === "") {
      // 名前の変更：元と先が続く。一覧は先のパスで引く
      i++;
      p = parts[i++] ?? "";
    }
    const count = (v: string) => (v === "-" ? null : Number(v));
    entries.push({ path: p, additions: count(m[1]!), deletions: count(m[2]!) });
  }
  return entries;
}

/** name-status と numstat をパスで突き合わせる。数のない（numstat にない）ものは 0 行とする */
export function mergeChanges(names: NameStatusEntry[], numbers: NumstatEntry[]): ChangedFile[] {
  const byPath = new Map(numbers.map((n) => [n.path, n]));
  return names.map((n) => {
    const stat = byPath.get(n.path);
    const binary = stat !== undefined && stat.additions === null;
    return {
      ...n,
      additions: binary ? null : (stat?.additions ?? 0),
      deletions: binary ? null : (stat?.deletions ?? 0),
      binary,
    };
  });
}

/**
 * 作業ブランチの変更の片側のファイルの中身。base は merge-base、head は作業ブランチの先端のもの。
 * 読めるのは変更の一覧にあるファイルだけで（base の側は名前の変更の元のパス）、ほかは NOT_FOUND。
 * その側にないファイル（追加の base・削除の head）は exists: false で空にする（差分エディタの片側を空にする）。
 * expected（一覧で読んだその側のコミット）を渡すと、ブランチが進んで変わっていれば REJECTED にする（一覧と違う中身を出さない）
 */
export async function readChangedFile(
  repo: GitRepo,
  branch: string,
  side: DiffSide,
  filePath: string,
  expected?: string,
): Promise<FileAtSide> {
  const refs = await resolveChangeRefs(repo, branch);
  const commit = side === "base" ? refs.baseCommit : refs.headCommit;
  if (expected !== undefined && expected !== commit) {
    throw new OperationError(
      "REJECTED",
      `一覧を読んだ後に ${short(side === "base" ? refs.base : refs.head)} が変わったので、変更の一覧を読み直す`,
    );
  }
  // 読めるのは変更の一覧にあるファイルだけ（base の側は名前の変更の元のパス）。dg serve や MCP から木の中の任意のファイルを読ませない
  const listed = parseNameStatus(
    (
      await runGit(repo.topLevel, [
        ...DIFF_ARGS,
        "--name-status",
        refs.baseCommit,
        refs.headCommit,
        "--",
      ])
    ).stdout,
  );
  const allowed = listed.some(
    (e) => (side === "base" ? (e.old_path ?? e.path) : e.path) === filePath,
  );
  if (!allowed) {
    throw new OperationError("NOT_FOUND", `${filePath} は ${branch} の変更の一覧にない`);
  }
  const missing = {
    path: filePath,
    commit,
    exists: false,
    binary: false,
    submodule: false,
    text: "",
  };
  // 木の項目の種類で、ファイル（blob）とサブモジュール（commit）を分ける。パスは字のまま（glob にしない）
  const entry = await runGit(
    repo.topLevel,
    ["--literal-pathspecs", "ls-tree", "-z", commit, "--", filePath],
    { allowFailure: true },
  );
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry.stdout.split("\0")[0] ?? "");
  if (entry.code !== 0 || !m || m[4] !== filePath) return missing;
  if (m[2] === "commit") {
    return { ...missing, exists: true, submodule: true, text: m[3]! };
  }
  if (m[2] !== "blob") return missing;
  // `<commit>:<path>` のパスはリポジトリの最上位から。「./」で始めると cwd からになるので付けない
  const shown = await runGit(repo.topLevel, ["cat-file", "blob", `${commit}:${filePath}`]);
  const binary = shown.stdout.includes("\0");
  return {
    path: filePath,
    commit,
    exists: true,
    binary,
    submodule: false,
    text: binary ? "" : shown.stdout,
  };
}
