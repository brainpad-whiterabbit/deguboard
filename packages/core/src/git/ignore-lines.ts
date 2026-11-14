// 各自のマシンで入れるファイル（dg の Skill・追跡しない設定）を git に追跡させない行を .gitignore に足す（AG-2・AG-9）。
// dg skill install・dg hooks install（CLI）と、VS Code 拡張の足りない Skill の案内の Install（commands/skill-files.ts）が使う。
// 入れたファイルの親のディレクトリ（agent の設定のディレクトリ）の .gitignore に足し、この .gitignore はコミットして共有する

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * .gitignore にない行を、渡した順に末尾に足す。1 行でも足したら true。利用者の行は残し、同じ行（前後の空白を除いて一致）があれば書かない。
 * 同じ意味の別の書き方（頭に / を付けた行など）は見分けずに足す（無視の行が重なっても害がない）
 */
export async function ensureIgnoreLines(file: string, lines: readonly string[]): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => "");
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((line, i) => !present.has(line) && lines.indexOf(line) === i);
  if (missing.length === 0) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${missing.map((l) => `${l}\n`).join("")}`,
    "utf8",
  );
  return true;
}
