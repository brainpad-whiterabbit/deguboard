// 仮番号の振り直し（DT-5、ADR-034）。オフラインで起票した仮番号がリモートの番号と衝突したら、
// 未 push のコミットを「番号・ファイル名・参照」を書き換えながら分岐点の上に積み直し、マージドライバを通して取り込む。
// --resolve なしの対象は「競合がすべて tickets/tNN.md の add/add で、ローカル側が provisional」のときだけで、それ以外の競合は扱わない

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { idNumber, nextNumber } from "../model/id.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { commitAll, integrate, remoteRef, resetHard } from "./sync.js";

export interface Renumbered {
  from: string;
  to: string;
}

const TICKET_PATH = /^tickets\/(?:deleted\/)?(t[1-9]\d*)\.md$/;
const CONFLICT_PATH = /^tickets\/(t[1-9]\d*)\.md$/;

const git = (repo: GitRepo, args: string[]) =>
  runGit(repo.dataDir, args, { localDir: repo.localDir });

/** ref にあるファイルの中身。なければ undefined */
async function show(repo: GitRepo, ref: string, file: string): Promise<string | undefined> {
  const r = await runGit(repo.dataDir, ["show", `${ref}:${file}`], {
    localDir: repo.localDir,
    allowFailure: true,
  });
  return r.code === 0 ? r.stdout : undefined;
}

function isProvisional(ticketFile: string): boolean {
  const end = ticketFile.indexOf("\n---", 3);
  const frontmatter = end === -1 ? ticketFile : ticketFile.slice(0, end);
  return /^provisional:\s*true\s*$/m.test(frontmatter);
}

/** ref の tickets/ と墓標にある番号 */
async function ticketNumbers(repo: GitRepo, ref: string): Promise<number[]> {
  const out = (await git(repo, ["ls-tree", "-r", "--name-only", ref, "tickets"])).stdout;
  return out
    .split("\n")
    .map((p) => TICKET_PATH.exec(p)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(idNumber);
}

/** 文中の ID（t5 など）を対応表で置き換える。ファイル名・frontmatter・本文・コミットメッセージに同じ規則を使う */
function rewriteIds(text: string, mapping: ReadonlyMap<string, string>): string {
  return text.replace(/\bt[1-9]\d*\b/g, (id) => mapping.get(id) ?? id);
}

/** renumberProvisional の結果。取り込めなければ conflicts に残った競合が入り、振り直しは捨てて元の先端に戻っている */
export interface RenumberedSync {
  renumbered: Renumbered[];
  conflicts: string[];
}

/**
 * --resolve なしの dg sync の後段（DT-5）。rebase の競合が仮番号の衝突だけなら、renumberCollisions で分岐点の上で振り直してから
 * もう一度取り込む。リモートの先端に中身を書き写さずマージドライバを通すので、同じファイルの別のフィールドのリモートの変更も残る。
 * 扱えない競合なら null を返し、何も変えない。振り直した後の取り込みも競合したら、元の先端に戻して残った競合を返す
 * （振り直しより後のコミットの競合は、最初の rebase が手前の衝突で止まったので見えていなかった）。
 * 呼ぶ側は rebase を中止済み（HEAD はローカルの先端）であること。まとめ待ちがあれば振り直しの前後で退けて戻す
 */
export async function renumberProvisional(
  repo: GitRepo,
  conflicts: readonly string[],
): Promise<RenumberedSync | null> {
  if (!repo.remote || conflicts.length === 0) return null;
  const remote = remoteRef(repo);
  for (const file of conflicts) {
    if (!CONFLICT_PATH.test(file)) return null;
    const local = await show(repo, "HEAD", file);
    if (local === undefined || !isProvisional(local)) return null;
    if ((await show(repo, remote, file)) === undefined) return null;
  }

  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const pending = await readPending(repo);
  const renumbered = await renumberCollisions(repo);
  if (renumbered.length === 0) return null;
  const restore = async () => {
    await clearWorkTree(repo, head);
    await restorePending(repo, pending, new Map());
  };
  let r: Awaited<ReturnType<typeof integrate>>;
  try {
    r = await integrate(repo, { autostash: pending.size > 0 });
  } catch (e) {
    await restore();
    throw e;
  }
  if (r.ok) return { renumbered, conflicts: [] };
  // 振り直した番号のパスは、戻した後の番号に読み替えて返す
  const back = new Map(renumbered.map(({ from, to }) => [to, from]));
  await restore();
  return { renumbered: [], conflicts: r.conflicts.map((file) => rewriteIds(file, back)) };
}

/**
 * dg sync --resolve の前段（SY-4）と renumberProvisional の中で使う。ローカルで足した仮番号のチケットのうち、リモートにも同じ番号のファイルがあるものを振り直す。
 * 未 push のコミットを分岐点の上で書き換えて積み直すだけで、取り込み（rebase）は呼び手がこの後に行う
 * （リモートの先端に書き写さないので、リモートの変更は取り込みのドライバのマージに残る）。
 * 未コミットの変更（まとめ待ち）は退けておき、振り直した後に番号を書き換えて作業ツリーに戻す（コミットは呼び手）。
 * 衝突がなければ何も変えず空を返す
 */
export async function renumberCollisions(repo: GitRepo): Promise<Renumbered[]> {
  if (!repo.remote) return [];
  const remote = remoteRef(repo);
  const base = (await git(repo, ["merge-base", "HEAD", remote])).stdout.trim();
  const added = (
    await git(repo, ["diff", "--name-only", "--diff-filter=A", base, "HEAD", "--", "tickets"])
  ).stdout
    .split("\n")
    .filter(Boolean);
  const ids: string[] = [];
  for (const file of added) {
    const id = CONFLICT_PATH.exec(file)?.[1];
    if (!id) continue;
    const local = await show(repo, "HEAD", file);
    if (local === undefined || !isProvisional(local)) continue;
    if ((await show(repo, remote, file)) === undefined) continue;
    ids.push(id);
  }
  if (ids.length === 0) return [];

  const shas = await localCommits(repo, base);
  const mapping = await assignNumbers(repo, ids);
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const pending = await readPending(repo);
  // 読んだ後は、まとめ待ちの中身がメモリにしかない。作業ツリーを空にする所から try に入れ、
  // 途中で失敗したら元の先端に戻して書き戻す（失わない）
  try {
    await clearWorkTree(repo, "HEAD");
    await resetHard(repo, base);
    await replay(repo, shas, mapping);
  } catch (e) {
    try {
      // replay は振り直した番号のファイル（未追跡）を書いてからコミットするので、reset だけでなく clean も要る。
      // 残すと次の sync でまとめ待ちとして重複したチケットがコミットされる
      await clearWorkTree(repo, head);
      await restorePending(repo, pending, new Map());
    } catch (restoreError) {
      throw new Error(
        `Could not write the pending changes back after the renumbering failed: ${errorMessage(restoreError)}`,
        { cause: e },
      );
    }
    throw e;
  }
  await restorePending(repo, pending, mapping);
  return [...mapping].map(([from, to]) => ({ from, to }));
}

/** takePending で退けた中身を、パスと中身の番号を対応表で書き換えて作業ツリーに戻す */
async function restorePending(
  repo: GitRepo,
  pending: ReadonlyMap<string, string | null>,
  mapping: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [file, content] of pending) {
    const target = path.join(repo.dataDir, rewriteIds(file, mapping));
    if (content === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rewriteIds(content, mapping));
  }
}

/** 分岐点より後のローカルのコミット（古い順） */
async function localCommits(repo: GitRepo, base: string): Promise<string[]> {
  return (await git(repo, ["rev-list", "--reverse", `${base}..HEAD`])).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** 仮番号に、リモートとローカルのどちらでも使っていない番号を小さい順に割り当てる */
async function assignNumbers(repo: GitRepo, ids: string[]): Promise<Map<string, string>> {
  const used = new Set<number>([
    ...(await ticketNumbers(repo, remoteRef(repo))),
    ...(await ticketNumbers(repo, "HEAD")),
  ]);
  const mapping = new Map<string, string>();
  for (const id of [...ids].sort((a, b) => idNumber(a) - idNumber(b))) {
    const n = nextNumber(used);
    used.add(n);
    mapping.set(id, `t${n}`);
  }
  return mapping;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 作業ツリーを ref に戻し、未追跡のファイルも消す */
async function clearWorkTree(repo: GitRepo, ref: string): Promise<void> {
  await resetHard(repo, ref);
  await git(repo, ["clean", "-fdq"]);
}

/**
 * 未コミットの変更（パス → 中身。消したものは null）を読む。作業ツリーは変えない。
 * 読んだ中身は、呼び手が作業ツリーを空にして積み直した後に書き戻す
 */
async function readPending(repo: GitRepo): Promise<Map<string, string | null>> {
  const out = (await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const entries = out.split("\0");
  const pending = new Map<string, string | null>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const file = entry.slice(3);
    // 名前の変更とコピーは、次の要素に元のパスが続く（元のパスは消えたものとして戻す）
    if (entry[0] === "R") pending.set(entries[++i] ?? "", null);
    else if (entry[0] === "C") i++;
    pending.set(file, await readFile(path.join(repo.dataDir, file), "utf8").catch(() => null));
  }
  pending.delete("");
  return pending;
}

/** コミットを 1 つずつ、変えたファイルの中身とメッセージの番号を書き換えて、今の HEAD の上に積み直す */
async function replay(
  repo: GitRepo,
  shas: readonly string[],
  mapping: ReadonlyMap<string, string>,
): Promise<void> {
  for (const sha of shas) {
    const changes = (
      await git(repo, [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--name-status",
        "--no-renames",
        `${sha}^`,
        sha,
      ])
    ).stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t") as [string, string]);
    for (const [status, file] of changes) {
      const target = path.join(repo.dataDir, rewriteIds(file, mapping));
      if (status === "D") {
        await rm(target, { force: true });
        continue;
      }
      const content = (await show(repo, sha, file)) ?? "";
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, rewriteIds(content, mapping));
    }
    const message = (await git(repo, ["log", "--format=%B", "-1", sha])).stdout.trim();
    await commitAll(repo, rewriteIds(message, mapping));
  }
}
