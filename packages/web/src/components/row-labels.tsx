// バックログとカンバンの行のラベル（UI-2・UI-3）。タイトルの下の段に札で並べ、押すとそのラベルで絞る（もう一度押すと外す）。
// 出すかどうかと絞り込みは画面（pages/backlog.tsx・pages/board.tsx）が RowLabelsContext で渡し、渡さない一覧（履歴など）には出さない。
// 色は名前から決め、データにも config にも持たない（labelColorIndex。styles.css の .label-color-*）

import { createContext, useContext } from "react";
import { tr } from "../l10n.js";

/** 行に並べるラベルの数。超える分は「+N」にまとめる */
export const ROW_LABEL_LIMIT = 3;

/** ラベルの色の数（styles.css の --dg-label-0〜5 と .label-color-0〜5） */
export const LABEL_COLOR_COUNT = 6;

/**
 * ラベルの名前から色の番号（0〜LABEL_COLOR_COUNT-1）を決める。同じ名前はどの画面・どの人でも同じ色になる。
 * 名前の UTF-16 の符号単位を 32 ビットの FNV-1a で混ぜ、色の数で割った余り。
 * 31 倍して足す形は 31 が 6 で割って 1 余るので、余りが文字の和だけで決まり、似た名前が同じ色に寄る
 */
export function labelColorIndex(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % LABEL_COLOR_COUNT;
}

/** 行に出すラベル（先頭から limit 個まで）と、「+N」にまとめる残り */
export function splitRowLabels(
  labels: readonly string[],
  limit = ROW_LABEL_LIMIT,
): { shown: string[]; rest: string[] } {
  return { shown: labels.slice(0, limit), rest: labels.slice(limit) };
}

/** 行のラベルの出し方。selected は絞っているラベル（なければ空）、onSelect は札を押したときに呼ぶ（絞る・外すは呼び手が決める） */
export interface RowLabelsSetting {
  selected: string;
  onSelect: (label: string) => void;
}

/** 行のラベルを出す画面が渡す。null（既定）なら行にラベルを出さない（表示メニューで切ったとき・履歴などの一覧） */
export const RowLabelsContext = createContext<RowLabelsSetting | null>(null);

export function useRowLabels(): RowLabelsSetting | null {
  return useContext(RowLabelsContext);
}

/**
 * 行のタイトルの下の段のラベルの札。先頭から 3 つまで出し、残りは「+N」にまとめる（触れると全部の名前をツールチップに出す）。
 * 行のリンクの外に置くので、Tab では止めない（tabIndex -1）。押しても行の選択と詳細は変えない（ask-menu.tsx の NOT_SELECT_CLICK が .row-labels を外す）。
 * className は欄に足す class（先頭に空白を付けて渡す。Epic の札に触れている間の光らせ方）
 */
export function RowLabels({
  labels,
  setting,
  className = "",
}: {
  labels: readonly string[];
  setting: RowLabelsSetting;
  className?: string | undefined;
}) {
  if (labels.length === 0) return null;
  const { shown, rest } = splitRowLabels(labels);
  return (
    <span className={`row-labels${className}`}>
      {shown.map((label) => {
        const on = setting.selected === label;
        return (
          <button
            key={label}
            type="button"
            tabIndex={-1}
            className={`row-label label-color-${labelColorIndex(label)}`}
            aria-pressed={on}
            title={on ? tr("ラベル {0} の絞り込みを外す", label) : tr("ラベル {0} で絞る", label)}
            onClick={() => setting.onSelect(label)}
          >
            {label}
          </button>
        );
      })}
      {rest.length > 0 ? (
        // title はマウスで触れたときだけ出るので、隠れた名前を支援技術にも読めるように aria-label にも持たせる。
        // 素の span の aria-label は読まれないので role="img" を付ける
        <span
          className="row-label more"
          role="img"
          title={labels.join(", ")}
          aria-label={tr("ほかのラベル {0}", rest.join(", "))}
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}
