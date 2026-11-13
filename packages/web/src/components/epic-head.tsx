// 選んでいる Epic の見出し（UI-10）。Epic で絞っている間だけ、カンバンは Iteration の見出しの下、バックログは Epic の札の下に出す。
// 「Epic e12 題 done/全体 ×」の 1 行で、× で絞り込みを外す（Epic の絞り込みの札を兼ねる）。
// Epic の札は小さく吹き出しを中に置けないので、Iteration の見出しと同じく、この行をエージェントに頼む場所にする（吹き出しと Shift+F10。UI-15）。
// 頼む対象は Epic の詳細のタイトルと同じ（その Epic だけ。場所は付けない）なので、候補も同じになる。
// 「なし」で絞ったときは「Epic なし N 件」と出し、見えている Epic のないチケットの全件を対象にする（行を複数選んで頼むときと同じ組になる）

import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";
import { EPIC_LABELS, NO_EPIC, type EpicRow } from "../types.js";
import { useAskSpot, type AskSection } from "./ask-menu.js";
import { DetailLink } from "./parts.js";

export function EpicFilterHead({
  selected,
  epic,
  tickets,
  section,
  onClear,
}: {
  /** 絞っている Epic の ID（NO_EPIC は Epic に入っていないもの） */
  selected: string;
  /** 絞っている Epic（閉じていてもよい）。「なし」と、一覧にない ID なら undefined */
  epic: Pick<EpicRow, "id" | "title" | "status" | "progress"> | undefined;
  /** 絞って見えているチケット。「なし」の件数と頼む対象に使う */
  tickets: readonly { id: string }[];
  /** 場所の種類（カンバンかバックログの見出し） */
  section: AskSection;
  onClear: () => void;
}) {
  const none = selected === NO_EPIC;
  const name = none ? tr("なし") : selected;
  // 一覧にない Epic と、0 件の「なし」は頼む対象がないので、× だけの見出しにする
  const spot = useAskSpot(
    epic
      ? {
          targets: [epic.id],
          label: tr("Epic の見出し {0}", epic.id),
          section,
          // 右クリックで Epic の「詳細を開く」「ID をコピー」を出す
          menu: epic.id,
        }
      : none && tickets.length > 0
        ? {
            targets: tickets.map((t) => t.id),
            label: tr("Epic の見出し {0}", name),
            section,
          }
        : null,
  );
  return (
    <div className="epic-head" {...(spot.overlay ? { ...spot.props, tabIndex: 0 } : {})}>
      <span className="epic-head-label">Epic</span>
      <span className="name" title={epic ? `${epic.id} ${epic.title}` : undefined}>
        {epic ? (
          <DetailLink route={{ page: "epics", id: epic.id }}>
            <code>{epic.id}</code> {epic.title}
          </DetailLink>
        ) : (
          name
        )}
      </span>
      {epic ? (
        <span className="count" title={tr("完了 {0}/{1}", epic.progress.done, epic.progress.total)}>
          {epic.progress.done}/{epic.progress.total}
        </span>
      ) : none ? (
        <span className="count">{trNode("{0} 件", tickets.length)}</span>
      ) : null}
      {epic?.status === "closed" ? <span className="state">{tr(EPIC_LABELS.closed)}</span> : null}
      <button
        type="button"
        className="epic-head-clear"
        aria-label={tr("Epic {0} の絞り込みを外す", name)}
        title={tr("絞り込みを外す")}
        onClick={onClear}
      >
        ×
      </button>
      {spot.overlay}
    </div>
  );
}
