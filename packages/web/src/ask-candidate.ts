// 頼むことの候補の表示（UI-15）。Skill の札と候補のボタンの title に出す文を組む。文は core の SKILL_SUMMARY が正本で、ここでは組むだけ（ADR-027）

import type { AskCandidate } from "./types.js";

/** 候補の title。Skill の 1 文があれば「/dgcheck: 文」、なければ Skill の名前、Skill を使わない候補は `noSkill`（画面の言語で渡す） */
export function candidateTitle(
  c: Pick<AskCandidate, "skill" | "skill_summary">,
  noSkill: string,
): string {
  return c.skill_summary ? `${c.skill}: ${c.skill_summary}` : (c.skill ?? noSkill);
}
