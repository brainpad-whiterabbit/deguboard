// 詳細の属性の欄でラベルを直すときに入力欄の下に出す、語彙から選ぶ部品（UI-4 の属性の欄。語彙は store の labelVocabulary）。
// 軸ごとに語彙のラベルを並べ、名前の横に説明を出す。押すと入力（カンマ区切り）に足すか外す。語彙にない名前は入力欄に書けば付く。
// 保存は入力欄の Enter（InlineEdit）に任せ、ここは入力の値を書き換えるだけにする

import { tr } from "../l10n.js";
import {
  LABEL_COLOR_COUNT,
  labelOptionText,
  toggleLabel,
  type LabelVocabulary,
} from "./label-vocab.js";
import { parseLabels } from "./ticket-props.js";

/**
 * 語彙のラベルの選択。語彙がなければ何も出さない。マウスで押しても入力欄からフォーカスを動かさない（続けて Enter で保存できる）。
 * キーでは Tab で項目へ移って Space・Enter で押せる（欄の外へ出たときだけ取り消すのは InlineEdit）
 */
export function LabelPicker({
  vocabulary,
  raw,
  onChange,
}: {
  vocabulary: LabelVocabulary;
  raw: string;
  onChange: (raw: string) => void;
}) {
  if (vocabulary.axes.length === 0) return null;
  const current = parseLabels(raw);
  return (
    <div className="label-picker" role="group" aria-label={tr("語彙から選ぶ")}>
      {vocabulary.axes.map((axis) => (
        <div key={axis.name} className="label-picker-axis" role="group" aria-label={axis.name}>
          <div className="label-picker-axis-name" title={axis.description ?? undefined}>
            {axis.name}
          </div>
          {axis.labels.map((l) => {
            const on = current.includes(l.name);
            return (
              <button
                key={l.name}
                type="button"
                className="label-picker-item"
                aria-pressed={on}
                // 札と説明の間に区切りがないと読み上げで続いてしまうので、絞り込みの候補と同じ形の名前にする
                aria-label={labelOptionText({ name: l.name, description: l.description })}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(toggleLabel(current, l.name).join(", "))}
              >
                <span className="view-menu-check" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                <span className={`row-label label-color-${l.axisIndex % LABEL_COLOR_COUNT}`}>
                  {l.name}
                </span>
                <span className="label-picker-desc">{l.description}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
