// 拡張の起動のたびに、入れてある dg の Skill のうち、この拡張より古い版の dg が書いたものを同梱の dg のものに更新する（AG-2・UI-11）。
// 作業フォルダごとの置き場所のまとめ・同梱のものより古いかの判定・書く処理は core の refreshInstalledSkills（dg skill install と同じ書く処理）で、
// ここは結果から通知の文を作るだけにする。VS Code の API には触れない（core を呼んで通知を出すのは extension.ts）。
// 更新の後で、dg の Skill を入れてある置き場所に足りない同梱の Skill を案内する（core の findMissingSkills）。
// Don't show again で選んだ Skill の名前は拡張の globalState に覚え、以後その名前は案内しない（覚え方はここ、読み書きは extension.ts）

import type { MissingSkills, RefreshedSkills } from "@deguboard/core";
import { t } from "./l10n.js";

/** 案内しないと選んだ Skill の名前を覚える globalState の鍵 */
export const DISMISSED_SKILLS_KEY = "deguboard.dismissedMissingSkills";

/** 足りない Skill の案内の 1 件。置き場所ごとに 1 件で、Install は names だけを書く */
export interface MissingSkillNotice {
  dir: string;
  names: string[];
  text: string;
}

/** globalState に覚えた名前。壊れた値（配列でないなど）は覚えていないものとして扱う */
export function dismissedSkillsOf(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((n): n is string => typeof n === "string") : [];
}

/**
 * 足りない Skill の案内。案内しないと選んだ名前（dismissed）を除き、残りのない置き場所は出さない。
 * 置き場所ごとに 1 件にし、置き場所と Skill の名前を並べる
 */
export function missingSkillNotices(
  found: readonly MissingSkills[],
  dismissed: readonly string[],
): MissingSkillNotice[] {
  return found.flatMap((f) => {
    const names = f.missing.filter((n) => !dismissed.includes(n));
    if (names.length === 0) return [];
    return [
      {
        dir: f.dir,
        names,
        text: t(
          "These dg Skills bundled with this extension are not installed in {0}, where other dg Skills are: {1}",
          f.dir,
          names.join(", "),
        ),
      },
    ];
  });
}

/** Don't show again を選んだ後に覚える名前（前に覚えた名前に、案内した名前を足す） */
export function dismissedAfter(stored: unknown, names: readonly string[]): string[] {
  return [...new Set([...dismissedSkillsOf(stored), ...names])];
}

/**
 * 通知の文。更新したもの（info）と、手を加えたので残した古いもの（warning）を分ける。core が返すのは、印の版がこの拡張より古い
 * （か印に版のない）Skill だけなので「older」と書く。変えるものも知らせるものもなければ空 */
export function skillRefreshNotices(
  refreshed: readonly RefreshedSkills[],
): Array<{ level: "info" | "warning"; text: string }> {
  return refreshed.flatMap((r) => {
    const install = `dg skill install${r.scope === "personal" ? " --personal" : ""} --force`;
    return [
      ...(r.updated.length === 0
        ? []
        : [
            {
              level: "info" as const,
              text: t(
                "Updated the dg Skills in {0} that were older than this extension to the ones bundled with it: {1}",
                r.dir,
                r.updated.join(", "),
              ),
            },
          ]),
      ...(r.edited.length === 0
        ? []
        : [
            {
              level: "warning" as const,
              text: t(
                "These dg Skills in {0} are older than the ones bundled with this extension, but they were edited by hand, so they were not changed: {1}. To overwrite them, run {2}",
                r.dir,
                r.edited.join(", "),
                install,
              ),
            },
          ]),
    ];
  });
}
