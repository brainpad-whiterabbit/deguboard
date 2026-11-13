// 入れてある dg の Skill を作るテストの helper。core・cli・vscode のテストが同じものを使う

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** SKILL.md の印の行（frontmatter の直後。印を除いた中身の sha256 を持つ） */
export const SKILL_MARKER = /<!-- dg skill sha256:[0-9a-f]{64} -->\n/;

/** base（リポジトリの最上位かホームディレクトリ）の下の、Claude Code の Skill のディレクトリ */
export const skillsDir = (base: string) => path.join(base, ".claude", "skills");

/** base の下の Skill（name）の SKILL.md のパス */
export const skillFileOf = (base: string, name: string) =>
  path.join(skillsDir(base), name, "SKILL.md");

/**
 * 前の版の dg が入れたままの Skill（古い Skill）の中身。今の dg の Skill の中身（content）から作り、
 * 本文が今と違い、印はその本文のハッシュと合っている（手を加えていない）
 */
export function olderVersionOf(content: string): string {
  const changed = content.replace("This Skill holds no steps.", "This Skill has no steps.");
  if (changed === content) throw new Error("Skill の本文に、書き換える文がない");
  const hash = createHash("sha256").update(changed.replace(SKILL_MARKER, "")).digest("hex");
  return changed.replace(SKILL_MARKER, `<!-- dg skill sha256:${hash} -->\n`);
}

/** base の下に Skill（name）を中身 content で置く */
export async function putSkill(base: string, name: string, content: string): Promise<void> {
  const file = skillFileOf(base, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}
