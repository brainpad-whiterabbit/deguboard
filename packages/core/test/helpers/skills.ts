// 入れてある dg の Skill を作るテストの helper。core・cli・vscode のテストが同じものを使う

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** SKILL.md の印の行（frontmatter の直後。書いた dg の版と、印を除いた中身の sha256 を持つ。版を書く前の dg の印には版がない） */
export const SKILL_MARKER = /<!-- dg skill (?:v(\d+\.\d+\.\d+) )?sha256:[0-9a-f]{64} -->\n/;

/** 中身（content）の印に書いてある dg の版。今の dg の Skill に使うと、今の dg の版 */
export function skillVersionOf(content: string): string {
  const version = SKILL_MARKER.exec(content)?.[1];
  if (version === undefined) throw new Error("Skill の印に版がない");
  return version;
}

/** 版（major.minor.patch）の major を 1 つ上げた、より新しい版 */
export const newerThan = (version: string) => `${Number(version.split(".")[0]) + 1}.0.0`;

/** base（リポジトリの最上位かホームディレクトリ）の下の、Claude Code の Skill のディレクトリ */
export const skillsDir = (base: string) => path.join(base, ".claude", "skills");

/** base の下の Skill（name）の SKILL.md のパス */
export const skillFileOf = (base: string, name: string) =>
  path.join(skillsDir(base), name, "SKILL.md");

/**
 * 別の dg が入れたままの Skill の中身。今の dg の Skill の中身（content）から作り、
 * 本文が今と違い、印はその本文のハッシュと合っていて（手を加えていない）、版は version（省くと印に版を書かない）
 */
export function skillWrittenBy(content: string, version?: string): string {
  const changed = content.replace("This Skill holds no steps.", "This Skill has no steps.");
  if (changed === content) throw new Error("Skill の本文に、書き換える文がない");
  const hash = createHash("sha256").update(changed.replace(SKILL_MARKER, "")).digest("hex");
  const tag = version === undefined ? "" : `v${version} `;
  return changed.replace(SKILL_MARKER, `<!-- dg skill ${tag}sha256:${hash} -->\n`);
}

/** 版を書く前の dg が入れたままの Skill（古い Skill）の中身。印に版がない */
export const olderVersionOf = (content: string) => skillWrittenBy(content);

/** base の下に Skill（name）を中身 content で置く */
export async function putSkill(base: string, name: string, content: string): Promise<void> {
  const file = skillFileOf(base, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}
