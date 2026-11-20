// バックログとカンバンの行のラベル（UI-2・UI-3）。タイトルの下の段に札で並べ、押すとそのラベルで絞る（もう一度押すと外す）。
// 出すかどうかと絞り込みは画面（pages/backlog.tsx・pages/board.tsx）が RowLabelsContext で渡し、渡さない一覧（履歴など）には出さない。
// 色と印は語彙（label.list）から決める（components/label-vocab.ts の labelLook。styles.css の .label-color-*・.label-unknown・.label-procedure）

import { createContext, useContext } from "react";
import { tr } from "../l10n.js";
import {
  labelLook,
  labelLookClass,
  labelOptionGroups,
  labelOptionText,
  rowLabelOrder,
  type LabelLook,
  type LabelOption,
  type LabelVocabulary,
} from "./label-vocab.js";

/**
 * ラベルの絞り込みの選択の候補（option。バックログとカンバンの漏斗の欄）。語彙のある名前は軸ごとの組（optgroup）に分け、名前の横に語彙の説明を出す。
 * 語彙にない名前は最後の組にまとめ、語彙のないボードでは組に分けず名前だけを並べる
 */
export function LabelFilterOptions({
  names,
  vocabulary,
}: {
  names: readonly string[];
  vocabulary: LabelVocabulary;
}) {
  const groups = labelOptionGroups(names, vocabulary);
  const option = (o: LabelOption) => (
    <option key={o.name} value={o.name} title={o.description}>
      {labelOptionText(o)}
    </option>
  );
  if (groups.every((g) => g.axis === null))
    return <>{groups.flatMap((g) => g.options.map(option))}</>;
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.axis ?? ""} label={g.axis ?? tr("語彙にない")}>
          {g.options.map(option)}
        </optgroup>
      ))}
    </>
  );
}

/** 行に並べるラベルの数。超える分は「+N」にまとめる */
export const ROW_LABEL_LIMIT = 3;

/** 行に出すラベル（先頭から limit 個まで）と、「+N」にまとめる残り */
export function splitRowLabels(
  labels: readonly string[],
  limit = ROW_LABEL_LIMIT,
): { shown: string[]; rest: string[] } {
  return { shown: labels.slice(0, limit), rest: labels.slice(limit) };
}

/**
 * 行のラベルの出し方。selected は絞っているラベル（なければ空）、onSelect は札を押したときに呼ぶ（絞る・外すは呼び手が決める）。
 * vocabulary は色と印を決める語彙、hideProcedure は手順のラベルを隠すか（「表示」のメニュー）
 */
export interface RowLabelsSetting {
  selected: string;
  onSelect: (label: string) => void;
  vocabulary: LabelVocabulary;
  hideProcedure: boolean;
}

/** 行のラベルを出す画面が渡す。null（既定）なら行にラベルを出さない（表示メニューで切ったとき・履歴などの一覧） */
export const RowLabelsContext = createContext<RowLabelsSetting | null>(null);

export function useRowLabels(): RowLabelsSetting | null {
  return useContext(RowLabelsContext);
}

/** 札のツールチップに足す、語彙の軸と説明（語彙にない名前はその旨） */
function lookNote(look: LabelLook): string | undefined {
  if (look.kind === "axis") return `${look.label.axis}: ${look.label.description}`;
  if (look.kind === "unknown") return tr("語彙にない");
  if (look.kind === "procedure")
    return look.label ? `${look.label.axis}: ${look.label.description}` : tr("手順のラベル");
  return undefined;
}

/**
 * 行のタイトルの下の段のラベルの札。手順のラベルは後ろへ回し（隠す設定なら除き）、先頭から 3 つまで出し、残りは「+N」にまとめる（触れると全部の名前をツールチップに出す）。
 * 語彙にない名前は札に「?」の印を付ける（読み上げの名前には入れず、ツールチップで知らせる）。
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
  const ordered = rowLabelOrder(labels, setting.hideProcedure);
  if (ordered.length === 0) return null;
  const { shown, rest } = splitRowLabels(ordered);
  return (
    <span className={`row-labels${className}`}>
      {shown.map((label) => {
        const on = setting.selected === label;
        const look = labelLook(label, setting.vocabulary);
        const action = on
          ? tr("ラベル {0} の絞り込みを外す", label)
          : tr("ラベル {0} で絞る", label);
        const note = lookNote(look);
        return (
          <button
            key={label}
            type="button"
            tabIndex={-1}
            className={`row-label ${labelLookClass(look)}`}
            aria-pressed={on}
            title={note ? `${action}\n${note}` : action}
            onClick={() => setting.onSelect(label)}
          >
            {label}
            {look.kind === "unknown" ? (
              <span className="label-unknown-mark" aria-hidden="true">
                ?
              </span>
            ) : null}
          </button>
        );
      })}
      {rest.length > 0 ? (
        // title はマウスで触れたときだけ出るので、隠れた名前を支援技術にも読めるように aria-label にも持たせる。
        // 素の span の aria-label は読まれないので role="img" を付ける
        <span
          className="row-label more"
          role="img"
          title={ordered.join(", ")}
          aria-label={tr("ほかのラベル {0}", rest.join(", "))}
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}
