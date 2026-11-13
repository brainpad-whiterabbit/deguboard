// dg skill install・dg hooks install が各自のマシンで入れるファイル（dg の Skill・追跡しない設定）を git に追跡させない（AG-2・AG-9）。
// 入れたファイルの親のディレクトリ（Claude Code は .claude/）の .gitignore に自分の行を足す。この .gitignore はコミットして共有する。
// すでに追跡されているファイルには無視の行が効かないので、追跡済みかを見て、呼び出し側が git rm --cached を案内する

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * .gitignore に行がなければ末尾に足す。足したら true。利用者の行は残し、同じ行（前後の空白を除いて一致）があれば書かない。
 * 同じ意味の別の書き方（頭に / を付けた行など）は見分けずに足す（無視の行が重なっても害がない）
 */
export async function ensureIgnoreLine(file: string, line: string): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`,
    "utf8",
  );
  return true;
}

/** target（ファイルかディレクトリ）の下で git が追跡しているファイル。リポジトリの最上位からの相対パス（区切りは /）で返す */
export async function trackedFiles(topLevel: string, target: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", target], {
    cwd: topLevel,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((p) => p !== "");
}
