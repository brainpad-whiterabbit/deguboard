// Epic の札（番号だけの Chip）。題と進み（done/全体）は、ツールチップと読み上げの名前（ID と題）で読む。
// バックログ（絞り込み）とカンバン（t706）で同じ札を使う。押したときの動きと押した状態は呼び出し側が決める

import { tr } from "../l10n.js";
import { Chip } from "./chips.js";
import type { Progress } from "../types.js";

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
