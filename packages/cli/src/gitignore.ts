// dg skill install・dg hooks install が入れたファイルのうち、すでに git に追跡されているものを見つける（AG-2・AG-9）。
// 無視の行を足すのは core の ensureIgnoreLines。追跡済みのファイルには無視の行が効かないので、追跡済みかを見て、呼び出し側が git rm --cached を案内する

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** target（ファイルかディレクトリ）の下で git が追跡しているファイル。リポジトリの最上位からの相対パス（区切りは /）で返す */
export async function trackedFiles(topLevel: string, target: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", target], {
    cwd: topLevel,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((p) => p !== "");
}
