// 拡張の起動のたびに、入れてある dg の Skill のうち、この拡張より古い版の dg が書いたものを同梱の dg のものに更新する（AG-2・UI-11）。
// 作業フォルダごとの置き場所のまとめ・同梱のものより古いかの判定・書く処理は core の refreshInstalledSkills（dg skill install と同じ書く処理）で、
// ここは結果から通知の文を作るだけにする。VS Code の API には触れない（core を呼んで通知を出すのは extension.ts）

import type { RefreshedSkills } from "@deguboard/core";
import { t } from "./l10n.js";

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
