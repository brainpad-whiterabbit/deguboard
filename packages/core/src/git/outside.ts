// dg の外の変更を見つける（t546・ADR-021）。データのリポジトリ（.git/deguboard）を dg のコマンドを通さずに書き換えたら、
// dg が次にコマンドを実行するとき（runCommand）と Stop のフックで見つける。フックの粗い拒否（PreToolUse）の取りこぼしを事後に補う。
//   - コミット：dg が作るコミットはメッセージの末尾に印（DG_COMMIT_TRAILER）を持つ。基準の HEAD より後で、リモートの deguboard に
//     まだないコミットのうち、印のないものを dg の外のコミットとする（リモートから取り込んだコミットは、書いた人の dg が確かめている）
//   - 未コミットの変更：commit.mode が batch・manual なら dg 自身も作業ツリーに変更を残す。dg は書き込みのロックを放す前に、
//     作業ツリーの変更のあるファイルとその中身のハッシュを基準に記録する。今の作業ツリーが基準と違えば、違うファイルを dg の外の変更とする
//   基準は deguboard-local/outside-baseline.json（マシンごと）。初めて確かめるとき（基準がない）は今の状態を基準にする。
//   見つけたまま書き込んだときは基準を進めない（見つけた変更を dg の書き込みで隠さない）。dg adopt が今の状態を基準にして取り込む

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../storage/atomic.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { DATA_BRANCH } from "./worktree.js";

/** dg が作るコミットのメッセージの末尾の行（git のトレーラーの形）。これのないコミットは dg の外のもの */
export const DG_COMMIT_TRAILER = "Deguboard-Commit: dg";

const BASELINE_FILE = "outside-baseline.json";

/** 基準：最後に確かめた HEAD と、そのときの作業ツリーの変更（パス → 中身のハッシュ。消えたファイルは "deleted"） */
export interface OutsideBaseline {
  head: string;
  dirty: Record<string, string>;
}

export interface OutsideCommit {
  sha: string;
  subject: string;
  files: string[];
}

export interface OutsideFile {
  path: string;
  /** changed：基準と中身が違う（足した・書き換えた・消した）。reverted：dg が残した変更が戻された */
  change: "changed" | "reverted";
}

export interface OutsideChanges {
  /** 基準の HEAD。dg の外のコミットを捨てるときの戻り先 */
  baseline: string;
  commits: OutsideCommit[];
  files: OutsideFile[];
}

export type OutsideCheck =
  | { kind: "clean"; initial: boolean }
  | { kind: "found"; changes: OutsideChanges };

const git = (repo: GitRepo, args: string[]) =>
  runGit(repo.dataDir, args, { localDir: repo.localDir, allowFailure: true });

const baselinePath = (repo: Pick<GitRepo, "localDir">) => path.join(repo.localDir, BASELINE_FILE);

async function readBaseline(repo: GitRepo): Promise<OutsideBaseline | undefined> {
  const text = await readFile(baselinePath(repo), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const d = JSON.parse(text) as Partial<OutsideBaseline>;
    if (typeof d.head !== "string" || typeof d.dirty !== "object" || d.dirty === null)
      return undefined;
    return { head: d.head, dirty: d.dirty };
  } catch {
    return undefined;
  }
}

async function headOf(repo: GitRepo): Promise<string | undefined> {
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** 作業ツリーの変更のあるファイルと、その中身のハッシュ（消えたものは "deleted"）。無視したファイルは見ない */
async function dirtyFiles(repo: GitRepo): Promise<Record<string, string>> {
  const r = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = r.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // 名前の変更とコピーは、次の要素に元のパスが続く
    if (entry[0] === "R" || entry[0] === "C") paths.push(entries[++i] ?? "");
  }
  const dirty: Record<string, string> = {};
  for (const p of paths.filter(Boolean).sort()) {
    const file = path.join(repo.dataDir, p);
    dirty[p] = await readFile(file)
      .then((b) => createHash("sha256").update(b).digest("hex"))
      .catch(() => "deleted");
  }
  return dirty;
}

/** 今の状態を基準に記録する */
export async function recordBaseline(repo: GitRepo): Promise<void> {
  const head = await headOf(repo);
  if (head === undefined) return;
  const baseline: OutsideBaseline = { head, dirty: await dirtyFiles(repo) };
  await writeFileAtomic(baselinePath(repo), `${JSON.stringify(baseline)}\n`);
}

/** 基準の HEAD より後で、リモートの deguboard にない、印のないコミット（新しい順） */
async function outsideCommits(repo: GitRepo, base: string): Promise<OutsideCommit[]> {
  const known = await git(repo, ["cat-file", "-e", `${base}^{commit}`]);
  // 基準のコミットがない（履歴を作り直した）ときは、リモートにないコミットだけを見る。リモートもなければ見ない
  const remote = repo.remote ? `refs/remotes/${repo.remote}/${DATA_BRANCH}` : undefined;
  const hasRemote =
    remote !== undefined &&
    (await git(repo, ["show-ref", "--verify", "--quiet", remote])).code === 0;
  if (known.code !== 0 && !hasRemote) return [];
  const range = known.code === 0 ? [`${base}..HEAD`] : ["HEAD"];
  const r = await git(repo, [
    "log",
    "--invert-grep",
    "--fixed-strings",
    `--grep=${DG_COMMIT_TRAILER}`,
    "--format=%x1e%H%x1f%s",
    "--name-only",
    ...range,
    ...(hasRemote ? ["--not", remote!] : []),
    "--",
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\x1e")
    .filter((block) => block.trim())
    .map((block) => {
      const [first, ...rest] = block.split("\n");
      const [sha, subject] = first!.split("\x1f");
      return { sha: sha!, subject: subject ?? "", files: rest.filter(Boolean) };
    });
}

/**
 * 書き込みのロックを持っている dg がいるか。持っている間は作業ツリーが書きかけなので、未コミットの変更は見ない
 * （その dg がロックを放す前に基準を記録する）
 */
async function writeLocked(repo: GitRepo): Promise<boolean> {
  return stat(path.join(repo.localDir, "locks", "write")).then(
    () => true,
    () => false,
  );
}

/**
 * dg の外の変更を確かめる。基準がなければ clean（initial）。opts.underLock は、呼び出し側が書き込みのロックを持っていること
 * （持っていなければ、ほかの dg が書き込み中のときは未コミットの変更を見ない）
 */
export async function checkOutside(
  repo: GitRepo,
  opts: { underLock?: boolean } = {},
): Promise<OutsideCheck> {
  const baseline = await readBaseline(repo);
  if (!baseline) {
    // 初めて確かめる：今の状態を基準にする（ロックの中なら、持ち主が放す前に記録する。ほかの dg が書き込み中なら任せる）
    if (!opts.underLock && !(await writeLocked(repo))) await recordBaseline(repo);
    return { kind: "clean", initial: true };
  }
  const head = await headOf(repo);
  if (head === undefined) return { kind: "clean", initial: false };
  const commits = head === baseline.head ? [] : await outsideCommits(repo, baseline.head);
  const files: OutsideFile[] = [];
  if (opts.underLock || !(await writeLocked(repo))) {
    const now = await dirtyFiles(repo);
    for (const [p, hash] of Object.entries(now))
      if (baseline.dirty[p] !== hash) files.push({ path: p, change: "changed" });
    // dg が残した変更が消えた：HEAD が進んでいれば dg のコミットに入ったとみなす（印のないコミットは上で見つかる）
    if (head === baseline.head)
      for (const p of Object.keys(baseline.dirty))
        if (!(p in now)) files.push({ path: p, change: "reverted" });
  }
  if (commits.length === 0 && files.length === 0) return { kind: "clean", initial: false };
  return { kind: "found", changes: { baseline: baseline.head, commits, files } };
}

/** 見つけた変更の一覧の文（警告・エラー・フックの理由に使う） */
export function describeOutside(changes: OutsideChanges): string {
  const parts: string[] = [];
  if (changes.files.length > 0)
    parts.push(
      `未コミットの変更: ${changes.files
        .map((f) => (f.change === "reverted" ? `${f.path}（dg の変更が戻された）` : f.path))
        .join("、")}`,
    );
  for (const c of changes.commits)
    parts.push(
      `コミット ${c.sha.slice(0, 7)}「${c.subject}」: ${c.files.join("、") || "（ファイルの変更なし）"}`,
    );
  return parts.join("。");
}

/** 見つけたときの戻し方と取り込み方（help・guide と同じ。dg guide overview の「dg の外の変更」） */
export function outsideRemedy(changes: OutsideChanges): string {
  return (
    "データ（.git/deguboard/）は dg のコマンドでだけ書く。dg の外の変更を正しいと確かめたら dg adopt で取り込む" +
    `（検査を通してから今の状態を基準にする）。捨てるなら、人が deguboard worktree で未コミットの変更を git restore で戻し、` +
    `dg の外のコミットを git reset --keep ${changes.baseline.slice(0, 12)} で外してから、dg adopt で今の状態を基準にする（dg guide overview の「dg の外の変更」）`
  );
}
