// Epic の札（番号だけの Chip）。題と進み（done/全体）は、ツールチップと読み上げの名前（ID と題）で読む。
// バックログ（絞り込み）とカンバン（t706）で同じ札を使う。押したときの動きと押した状態は呼び出し側が決める。
// 札に触れている間（マウスを載せる・Tab で止まる）は、その Epic の行を光らせ、ほかの行を薄くする（UI-10。useEpicHighlight）

import { createContext, useContext, useState } from "react";
import { tr } from "../l10n.js";
import { Chip, ChipRow } from "./chips.js";
import { matchesEpic, NO_EPIC, type EpicRow, type Progress, type Ticket } from "../types.js";

/** 光らせている Epic（NO_EPIC は Epic のない行）。光らせていなければ undefined。画面が行の一覧を包んで渡す（useEpicHighlight） */
export const EpicHighlight = createContext<string | undefined>(undefined);

/**
 * 画面が持つ、札に触れている Epic。selected（Epic で絞っている値）があれば光らせない（絞った一覧はみなその Epic なので）。
 * highlight を EpicHighlight で行の一覧に渡し、onHighlight を EpicChipRow に渡す
 */
export function useEpicHighlight(selected: string): {
  highlight: string | undefined;
  onHighlight: (epic: string | undefined) => void;
} {
  const [touched, setTouched] = useState<string | undefined>(undefined);
  return { highlight: selected ? undefined : touched, onHighlight: setTouched };
}

/** 行の class（先頭に空白）。光らせている Epic の行は epic-hit、ほかは epic-dim、光らせていなければ空（styles.css） */
export function useEpicHighlightClass(ticket: Pick<Ticket, "epic">): string {
  const highlight = useContext(EpicHighlight);
  if (highlight === undefined) return "";
  return matchesEpic(ticket, highlight) ? " epic-hit" : " epic-dim";
}

/**
 * Epic の欄（札の行）：「Epic」の見出しと、番号の札の行（2 行を超える分は「ほか N」）と、末尾の「なし」（件数つき）。
 * バックログの Epic の欄とカンバンの見出しで同じ部品。押すとその Epic で絞り、もう一度押すと外れる（onSelect が決める）。
 * 題と進みは札のツールチップで読む。札に触れている間は onHighlight にその Epic を渡す（「ほか N」に畳んだ札は触れられないのでそのまま）
 */
export function EpicChipRow({
  epics,
  noEpic,
  selected,
  onSelect,
  onHighlight,
}: {
  epics: readonly Pick<EpicRow, "id" | "title" | "progress">[];
  /** 「なし」の件数（Epic に入っていないチケットの数） */
  noEpic: number;
  /** 選んでいる Epic の ID（NO_EPIC は Epic に入っていないもの。絞っていなければ空） */
  selected: string;
  onSelect: (epic: string) => void;
  /** 札に触れたらその Epic、離れたら undefined で呼ぶ（useEpicHighlight） */
  onHighlight?: ((epic: string | undefined) => void) | undefined;
}) {
  const hover = (epic: string) =>
    onHighlight ? (on: boolean) => onHighlight(on ? epic : undefined) : undefined;
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
            onHover={hover(e.id)}
          />
        ))}
        <Chip
          key={NO_EPIC}
          className="epic-chip loose"
          pressed={selected === NO_EPIC}
          title={selected === NO_EPIC ? tr("絞り込みを外す") : tr("Epic のないチケットで絞る")}
          onClick={() => onSelect(NO_EPIC)}
          onHover={hover(NO_EPIC)}
        >
          {tr("なし")} <span className="chip-count">{noEpic}</span>
        </Chip>
      </ChipRow>
    </div>
  );
}

function EpicChip({
  id,
  title,
  progress,
  pressed,
  onClick,
  onHover,
}: {
  id: string;
  title: string;
  /** 進み（done/全体）。ツールチップに出す */
  progress: Progress;
  pressed: boolean;
  onClick: () => void;
  onHover: ((on: boolean) => void) | undefined;
}) {
  const detail = tr("{0} {1}・完了 {2}/{3}", id, title, progress.done, progress.total);
  return (
    <Chip
      className="epic-chip"
      pressed={pressed}
      title={pressed ? tr("{0}。押すと絞り込みを外す", detail) : detail}
      label={tr("{0} {1}", id, title)}
      onClick={onClick}
      onHover={onHover}
    >
      <code>{id}</code>
    </Chip>
  );
}
