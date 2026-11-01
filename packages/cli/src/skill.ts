// dg skill install：dg guide を読む薄い Claude Code の Skill を置く（AG-2）。Skill は手順を持たず、正本は guide-*.md（CL-5）。
// 本文は隣の skill.md で、ビルドでは dist/ にコピーする（package.json の build）

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OperationError, resolveRepoPaths } from "@deguboard/core";

/** Skill の名前。置き場所は <基点>/.claude/skills/<名前>/SKILL.md */
export const SKILL_NAME = "deguboard";

export async function readSkillTemplate(): Promise<string> {
  return readFile(new URL("./skill.md", import.meta.url), "utf8");
}

export interface SkillInstallResult {
  /** 書いた SKILL.md の絶対パス */
  path: string;
  /** project（リポジトリの .claude/skills）か personal（~/.claude/skills）。Claude Code の呼び名に合わせる */
  scope: "project" | "personal";
  /** 既存のファイルを --force で上書きしたか */
  overwritten: boolean;
}

/**
 * Skill を書く。scope が project なら cwd を含むリポジトリの最上位、personal ならホームディレクトリの下に置く。
 * 既存のファイルがあれば force なしでは ALREADY_EXISTS で拒否する
 */
export async function installSkill(options: {
  cwd: string;
  scope: "project" | "personal";
  home: string;
  force: boolean;
}): Promise<SkillInstallResult> {
  const base =
    options.scope === "personal" ? options.home : (await resolveRepoPaths(options.cwd)).topLevel;
  const path = join(base, ".claude", "skills", SKILL_NAME, "SKILL.md");
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !options.force) {
    throw new OperationError(
      "ALREADY_EXISTS",
      `${path} はもうある。上書きするなら --force を付ける`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await readSkillTemplate(), "utf8");
  return { path, scope: options.scope, overwritten: exists };
}
