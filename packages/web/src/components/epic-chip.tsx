// Epic の札（番号だけの Chip）。題と進み（done/全体）は、ツールチップと読み上げの名前（ID と題）で読む。
// バックログ（絞り込み）とカンバン（t706）で同じ札を使う。押したときの動きと押した状態は呼び出し側が決める

import { tr } from "../l10n.js";
import { Chip, ChipRow } from "./chips.js";
import { NO_EPIC, type EpicRow, type Progress } from "../types.js";

/**
 * Epic の欄（札の行）：「Epic」の見出しと、番号の札の行（2 行を超える分は「ほか N」）と、末尾の「なし」（件数つき）。
 * バックログの Epic の欄とカンバンの見出しで同じ部品。押すとその Epic で絞り、もう一度押すと外れる（onSelect が決める）。
 * 題と進みは札のツールチップで読む
 */
export function EpicChipRow({
  epics,
  noEpic,
  selected,
  onSelect,
}: {
  epics: readonly Pick<EpicRow, "id" | "title" | "progress">[];
  /** 「なし」の件数（Epic に入っていないチケットの数） */
  noEpic: number;
  /** 選んでいる Epic の ID（NO_EPIC は Epic に入っていないもの。絞っていなければ空） */
  selected: string;
  onSelect: (epic: string) => void;
}) {
  return (
    <div className="epic-chips">
      <span className="chip-label">Epic</span>
      <ChipRow
        label={tr("Epic で絞る")}
        contentKey={
          epics.map((e) => `${e.id}:${e.title}:${e.progress.done}/${e.progress.total}`).join("|") +
          `|${noEpic}`
        }
        moreLabel={(n) => tr("Epic をあと {0} 本出す", n)}
        lessLabel={tr("Epic を畳む")}
      >
        {epics.map((e) => (
          <EpicChip
            key={e.id}
            id={e.id}
            title={e.title}
            progress={e.progress}
            pressed={selected === e.id}
            onClick={() => onSelect(e.id)}
          />
        ))}
        <Chip
          key={NO_EPIC}
          className="epic-chip loose"
          pressed={selected === NO_EPIC}
          title={selected === NO_EPIC ? tr("絞り込みを外す") : tr("Epic のないチケットで絞る")}
          onClick={() => onSelect(NO_EPIC)}
        >
          {tr("なし")} <span className="chip-count">{noEpic}</span>
        </Chip>
      </ChipRow>
    </div>
  );
}

export function EpicChip({
  id,
  title,
  progress,
  pressed,
  onClick,
  className,
}: {
  id: string;
  title: string;
  /** 進み（done/全体）。あればツールチップに出す */
  progress?: Progress;
  pressed: boolean;
  onClick: () => void;
  className?: string;
}) {
  const detail = progress
    ? tr("{0} {1}・完了 {2}/{3}", id, title, progress.done, progress.total)
    : tr("{0} {1}", id, title);
  return (
    <Chip
      className={className ? `epic-chip ${className}` : "epic-chip"}
      pressed={pressed}
      title={pressed ? tr("{0}。押すと絞り込みを外す", detail) : detail}
      label={tr("{0} {1}", id, title)}
      onClick={onClick}
    >
      <code>{id}</code>
    </Chip>
  );
}
