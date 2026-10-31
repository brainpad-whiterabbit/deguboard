// 仮番号の振り直し（DT-5、ADR-002）。オフラインで起票した仮番号がリモートの番号と衝突したら、
// 未 push のコミットを「番号・ファイル名・参照」を書き換えながらリモートの上に積み直す。
// 対象は「競合がすべて tickets/tNN.md の add/add で、ローカル側が provisional」のときだけで、それ以外の競合は扱わない

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { idNumber, nextNumber } from "../model/id.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { commitAll, remoteRef, resetHard } from "./sync.js";

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
export function rewriteIds(text: string, mapping: ReadonlyMap<string, string>): string {
  return text.replace(/\bt[1-9]\d*\b/g, (id) => mapping.get(id) ?? id);
}

/**
 * rebase の競合が仮番号の衝突だけなら振り直して積み直し、対応表を返す。扱えない競合なら null を返し、何も変えない。
 * 呼ぶ側は rebase を中止済み（HEAD はローカルの先端、作業ツリーは clean）であること
 */
export async function renumberProvisional(
  repo: GitRepo,
  conflicts: readonly string[],
): Promise<Renumbered[] | null> {
  if (!repo.remote || conflicts.length === 0) return null;
  const remote = remoteRef(repo);
  const ids: string[] = [];
  for (const file of conflicts) {
    const id = CONFLICT_PATH.exec(file)?.[1];
    if (!id) return null;
    const local = await show(repo, "HEAD", file);
    if (local === undefined || !isProvisional(local)) return null;
    if ((await show(repo, remote, file)) === undefined) return null;
    ids.push(id);
  }

  const base = (await git(repo, ["merge-base", "HEAD", remote])).stdout.trim();
  const shas = (await git(repo, ["rev-list", "--reverse", `${base}..HEAD`])).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  const used = new Set<number>([
    ...(await ticketNumbers(repo, remote)),
    ...(await ticketNumbers(repo, "HEAD")),
  ]);
  const mapping = new Map<string, string>();
  for (const id of ids.sort((a, b) => idNumber(a) - idNumber(b))) {
    const n = nextNumber(used);
    used.add(n);
    mapping.set(id, `t${n}`);
  }

  // リモートの先端に移り、未 push のコミットを 1 つずつ書き換えて積み直す
  await resetHard(repo, remote);
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
  return [...mapping].map(([from, to]) => ({ from, to }));
}
