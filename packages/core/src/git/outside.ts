// dg の外の変更を見つける（SY-7・SY-8、ADR-026）。データのリポジトリ（.git/deguboard）を dg のコマンドを通さずに書き換えたら、
// dg が次にコマンドを実行するとき（runCommand）と Stop のフックで見つける。フックの粗い拒否（PreToolUse）の取りこぼしを事後に補う。
//   - コミット：dg が作るコミットはメッセージの末尾に印（DG_COMMIT_TRAILER）を持つ。基準の HEAD より後で、リモートの deguboard に
//     まだないコミットのうち、印のないものを dg の外のコミットとする（リモートから取り込んだコミットは、書いた人の dg が確かめている）
//   - 未コミットの変更：commit.mode が batch・manual なら dg 自身も作業ツリーに変更を残す。dg は書き込みのロックを放す前に、
//     作業ツリーの変更のあるファイルとその中身のハッシュを基準に記録する。今の作業ツリーが基準と違えば、違うファイルを dg の外の変更とする
//   基準は deguboard-local/outside-baseline.json（マシンごと）。初めて確かめるとき（基準がない）は今の状態を基準にする。
//   - 履歴：基準の HEAD が今の HEAD の祖先でなければ、dg の外の変更とする。dg 自身の rebase と CAS のやり直しはロックの中で行い、
//     放す前に基準を記録するので取り違えない
//   書き込みのロックの中で見つけたら書かない（見つけた変更を dg のコミットに入れて隠さない）。dg adopt が今の状態を基準にして取り込む
//   見つけないもの（受け入れる）：権限管理や偽装の防止はしないので、印を付けたコミットと基準のファイルの書き換えは見ない。
//   基準はマシンごとなので、別のマシンでの書き換えはそのマシンの dg が見つけ、push 済みの外のコミットは取り込んだ側では見ない
//   （書いたマシンの dg が push の前の書き込みで見つける）

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { OperationError } from "../errors.js";
import { writeFileAtomic } from "../storage/atomic.js";
import { lockHeld } from "./lock.js";
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
  /** 基準の HEAD が今の HEAD の祖先でない（dg の外で dg のコミットを捨てたか書き換えた） */
  rewritten: boolean;
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
 * 生きた dg が書き込みのロックを持っているか。持っている間は作業ツリーが書きかけなので、未コミットの変更は見ない
 * （その dg がロックを放す前に基準を記録する）。落ちた dg が残した古いロックは持たないとみなす（検査を黙って弱めない）
 */
const writeLocked = (repo: GitRepo) => lockHeld(repo.localDir, "write");

/** 基準のコミットが今の HEAD の祖先か（dg の外で履歴を捨てた・書き換えたなら偽） */
async function isAncestor(repo: GitRepo, base: string): Promise<boolean> {
  return (await git(repo, ["merge-base", "--is-ancestor", base, "HEAD"])).code === 0;
}

/** 基準のファイルの中身（比べるために文字のまま読む） */
const baselineText = (repo: GitRepo) => readFile(baselinePath(repo), "utf8").catch(() => "");

/**
 * 基準と今の状態を比べる。印のないコミットは基準によらず見つかる（dg のコミットは印を持つ）。作業ツリーと履歴の書き換えは、
 * 比べている間に基準が変わらず、ほかの dg が書き込みのロックを持たなかったときだけ見る（stable が偽なら捨てる）
 */
async function compare(
  repo: GitRepo,
  baseline: OutsideBaseline,
): Promise<{ commits: OutsideCommit[]; files: OutsideFile[]; rewritten: boolean }> {
  const head = await headOf(repo);
  if (head === undefined) return { commits: [], files: [], rewritten: false };
  const commits = head === baseline.head ? [] : await outsideCommits(repo, baseline.head);
  const rewritten = head !== baseline.head && !(await isAncestor(repo, baseline.head));
  const files: OutsideFile[] = [];
  const now = await dirtyFiles(repo);
  for (const [p, hash] of Object.entries(now))
    if (baseline.dirty[p] !== hash) files.push({ path: p, change: "changed" });
  // dg が残した変更が消えた：HEAD が進んでいれば dg のコミットに入ったとみなす（印のないコミットは上で見つかる）
  if (head === baseline.head)
    for (const p of Object.keys(baseline.dirty))
      if (!(p in now)) files.push({ path: p, change: "reverted" });
  return { commits, files, rewritten };
}

/**
 * dg の外の変更を確かめる。基準がなければ clean（initial）。opts.underLock は、呼び出し側が書き込みのロックを持っていること。
 * 持っていなければ、ほかの dg の書き込み（ロックを取ってから基準を記録して放すまで）と重なりうるので、比べる前後で基準とロックを確かめ、
 * 重なったら比べ直す。重なり続けたら、作業ツリーと履歴の書き換えは見ずに、印のないコミットだけを返す（並べて動く dg の書きかけを取り違えない）
 */
export async function checkOutside(
  repo: GitRepo,
  opts: { underLock?: boolean } = {},
): Promise<OutsideCheck> {
  for (let attempt = 0; ; attempt++) {
    const before = await baselineText(repo);
    const baseline = await readBaseline(repo);
    if (!baseline) {
      // 初めて確かめる：今の状態を基準にする（ロックの中なら、持ち主が放す前に記録する。ほかの dg が書き込み中なら任せる）
      if (!opts.underLock && !(await writeLocked(repo))) await recordBaseline(repo);
      return { kind: "clean", initial: true };
    }
    const lockedBefore = !opts.underLock && (await writeLocked(repo));
    const found = await compare(repo, baseline);
    const stable =
      opts.underLock ||
      (!lockedBefore && !(await writeLocked(repo)) && (await baselineText(repo)) === before);
    if (!stable && attempt < 2) continue;
    const files = stable ? found.files : [];
    const rewritten = stable && found.rewritten;
    if (found.commits.length === 0 && files.length === 0 && !rewritten)
      return { kind: "clean", initial: false };
    return {
      kind: "found",
      changes: { baseline: baseline.head, commits: found.commits, files, rewritten },
    };
  }
}

/** 書き込みのロックの中で dg の外の変更を見つけたときの例外（書く前に止め、外の変更を dg のコミットに入れない） */
export function outsideError(changes: OutsideChanges, command = "dg"): OperationError {
  return new OperationError(
    "OUTSIDE_CHANGES",
    `データのリポジトリに dg の外の変更があるので、${command} は書かない。${outsideRemedy(changes)}`,
    describeOutside(changes),
  );
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
  if (changes.rewritten)
    parts.push(
      `基準のコミット ${changes.baseline.slice(0, 7)} が今の HEAD の祖先でない（dg の外で履歴を捨てたか書き換えた）`,
    );
  return parts.join("。");
}

/** 見つけたときの戻し方と取り込み方（help・guide と同じ。dg guide overview の「dg の外の変更」） */
export function outsideRemedy(changes: OutsideChanges): string {
  return (
    "データ（.git/deguboard/）は dg のコマンドでだけ書く。dg の外の変更を正しいと確かめたら dg adopt で取り込む" +
    "（検査を通してから今の状態を基準にする）。この版より前の dg（版の古い VS Code 拡張や CLI）が書いた変更も外の変更に見えるので、そのときは版を揃えてから dg adopt で取り込む。" +
    `捨てるなら、人が deguboard worktree で未コミットの変更を git restore で戻し（足したファイルは消す。まとめ待ちの dg の変更も戻る）、` +
    `dg の外のコミットを git reset --keep ${changes.baseline.slice(0, 12)} で外してから、dg adopt で今の状態を基準にする（手順は dg guide overview の「dg の外の変更」）`
  );
}
