// bin/dg.js が、ビルド済みの dist が今の checkout から作ったものかを確かめる（t973）。
// mise run build の最後に scripts/write-build-info.mjs が、ビルドしたコミットを packages/cli/dist/build-info.json に書く。
// dg.js はそれを、dist のある worktree の今の HEAD と比べ、違えば mise run build を案内する英語の警告を stderr に出す。
// マージのあとに main の worktree で git pull しても dist は古いまま残り、フックと mise run dg が古い dg のまま動くため。
// 警告だけで、JSON の出力と終了コードは変えない（フックの答えを変えない）。
// dg は呼び出しのたびに起動するので、git を起動せずに .git のファイル（HEAD・refs・packed-refs）を読む。
// 読めないとき（build-info.json がない・git の checkout でない・reftable など読めない形）は判定できないので黙る。
// このファイルは node の組み込みのほかを読まない

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** packages/cli/dist の中の、ビルドしたコミットを書くファイルの名前。scripts/prune-dist.mjs はこれを消さない */
export const BUILD_INFO_FILE = "build-info.json";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** worktree の最上位の .git（ディレクトリか、git worktree の "gitdir: …" のファイル）から git のディレクトリを返す */
function gitDirOf(root) {
  const dotGit = path.join(root, ".git");
  let info;
  try {
    info = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) return dotGit;
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "")?.[1];
  return target === undefined ? undefined : path.resolve(root, target);
}

/** ref（refs/heads/main など）の指すコミット。worktree ごとの git のディレクトリ、共有の git のディレクトリ、packed-refs の順に引く */
function resolveRef(gitDir, commonDir, ref) {
  for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    const loose = readText(path.join(dir, ref))?.trim();
    if (loose !== undefined && SHA.test(loose)) return loose;
  }
  for (const line of (readText(path.join(commonDir, "packed-refs")) ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && SHA.test(sha)) return sha;
  }
  return undefined;
}

/** root（worktree の最上位）の今の HEAD のコミット。git を起動せずにファイルから読み、読めなければ undefined */
export function readHeadCommit(root) {
  const gitDir = gitDirOf(root);
  if (gitDir === undefined) return undefined;
  const head = readText(path.join(gitDir, "HEAD"))?.trim();
  if (head === undefined) return undefined;
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (ref === undefined) return undefined;
  const common = readText(path.join(gitDir, "commondir"))?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  return resolveRef(gitDir, commonDir, ref);
}

/** dist の build-info.json に書いたコミット。読めなければ undefined */
export function readBuiltCommit(distDir) {
  try {
    const commit = JSON.parse(readText(path.join(distDir, BUILD_INFO_FILE)) ?? "")?.commit;
    return typeof commit === "string" && SHA.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * root（dist のある worktree の最上位）の dist が今の HEAD から作ったものでなければ、mise run build を案内する英語の文（末尾に改行）。
 * 同じか、どちらかが読めなければ undefined
 */
export function staleDistWarningOf(rootPath) {
  const root = path.resolve(rootPath);
  const built = readBuiltCommit(path.join(root, "packages", "cli", "dist"));
  if (built === undefined) return undefined;
  const head = readHeadCommit(root);
  if (head === undefined || head === built) return undefined;
  return [
    `dg: warning: the built CLI in dist/ was built from commit ${built.slice(0, 12)}, but HEAD of ${root} is ${head.slice(0, 12)}, so dg may run old code.`,
    `Run \`mise run build\` in ${root} to rebuild it (this run goes on with the old build).`,
    "",
  ].join("\n");
}
