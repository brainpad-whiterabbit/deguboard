// 拡張の起動のたびに、入れてある dg の Skill を同梱の dg のものにそろえる（AG-2・UI-11）。
// 同梱のものと違うかの判定と書く処理は core の refreshInstalledSkills（dg skill install と同じ skillStateOf と writeSkillFiles）で、ここは
// 作業フォルダごとに呼んで置き場所でまとめ、通知の文を作るだけにする。VS Code の API には触れない（通知を出すのは extension.ts）

import {
  refreshInstalledSkills,
  resolveRepoPaths,
  type AgentEnv,
  type RefreshedSkills,
} from "@deguboard/core";
import { t } from "./l10n.js";

/**
 * 作業フォルダごとに、そのリポジトリと個人の置き場所の dg の Skill を更新する。リポジトリの外のフォルダは個人の置き場所だけを見る。
 * 個人の置き場所はどのフォルダからも同じなので、置き場所（dir）ごとに 1 つにまとめる
 */
export async function refreshSkillsOf(
  folders: readonly string[],
  env: AgentEnv,
): Promise<RefreshedSkills[]> {
  const merged = new Map<string, RefreshedSkills>();
  // フォルダがなくても個人の置き場所は見る
  const tops: Array<string | undefined> = [];
  for (const folder of folders)
    tops.push(
      await resolveRepoPaths(folder).then(
        (p) => p.topLevel,
        () => undefined,
      ),
    );
  if (tops.length === 0) tops.push(undefined);
  for (const topLevel of tops) {
    for (const found of await refreshInstalledSkills({ topLevel, env })) {
      const seen = merged.get(found.dir);
      if (!seen) merged.set(found.dir, { ...found });
      else {
        seen.updated = [...new Set([...seen.updated, ...found.updated])];
        seen.edited = [...new Set([...seen.edited, ...found.edited])];
      }
    }
  }
  return [...merged.values()];
}

/**
 * 通知の文。更新したもの（info）と、手を加えたので残した違うもの（warning）を分ける。中身の違いしか分からないので「古い」とは書かない
 * （PATH の dg が拡張より新しいこともある）。変えるものも知らせるものもなければ空 */
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
                "Updated the dg Skills in {0} to the ones bundled with this extension: {1}",
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
                "These dg Skills in {0} differ from the ones bundled with this extension, but they were edited by hand, so they were not changed: {1}. To overwrite them, run {2}",
                r.dir,
                r.edited.join(", "),
                install,
              ),
            },
          ]),
    ];
  });
}
