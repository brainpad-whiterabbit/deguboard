// 拡張の起動のたびに、入れてある dg の Skill を同梱の dg のものにそろえる（AG-2・UI-11）。
// 作業フォルダごとの置き場所のまとめ・同梱のものと違うかの判定・書く処理は core の refreshInstalledSkills（dg skill install と同じ判定と書く処理）で、
// ここは結果から通知の文を作るだけにする。VS Code の API には触れない（core を呼んで通知を出すのは extension.ts）

import type { RefreshedSkills } from "@deguboard/core";
import { t } from "./l10n.js";

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
