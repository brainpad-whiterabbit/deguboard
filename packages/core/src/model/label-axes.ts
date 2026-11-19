// ラベルの軸の候補と、kind の推薦の語彙（requirements.md 5.10、ADR-037）。名前と説明を英語で持つ。
// 候補は config の既定ではない（labels.axes は書くまでオフ）：軸をまだ決めていないボードに勧めるときの出発点で、
// 人が選んだものだけを dg label axis set がチームの config.yaml に書く。形は書く軸と同じ（labelAxisSchema）なので、
// 選ばれたらそのまま記録できる。読むのは dg label axis list --candidates と設定画面（config.show の fields）

import type { LabelAxis } from "./config.js";

/** 推薦のラベル（軸の語彙に最初から入れるものではなく、その軸のラベルを最初に付けるときの出発点） */
export interface RecommendedLabel {
  name: string;
  description: string;
}

/**
 * 軸の候補。group が default のものは、どのプロジェクトにも当てはまり起票の時点で決められるので、勧めるときにいつも出す。
 * recommended のものは当てはまるプロジェクトが限られるので、リポジトリに根拠があるときだけ足して勧める
 */
export interface LabelAxisCandidate extends LabelAxis {
  group: "default" | "recommended";
  /** この軸の推薦のラベル。プロジェクトによる違いが小さい軸（kind）だけが持つ */
  recommended_labels?: RecommendedLabel[];
}

/** 軸の候補（出す順に並べる） */
export const LABEL_AXIS_CANDIDATES: readonly LabelAxisCandidate[] = [
  {
    name: "area",
    description: "Which part of the product the ticket touches",
    group: "default",
  },
  {
    name: "kind",
    description: "What kind of change the ticket makes",
    group: "default",
    recommended_labels: [
      { name: "feature", description: "Adds a capability or improves one that exists" },
      { name: "bug", description: "Fixes behavior that differs from what was promised" },
      {
        name: "refactor",
        description: "Restructures code, tests, or tooling without changing behavior",
      },
    ],
  },
  {
    name: "impact",
    description: "What reaches the users of the product",
    group: "recommended",
  },
  {
    name: "platform",
    description: "Which environment the ticket is about",
    group: "recommended",
  },
  {
    name: "audience",
    description: "Who the change is for",
    group: "recommended",
  },
];

/** 軸の状態。undecided は書いていない（まだ決めていない）、off は `[]`（使わないと決めた）、on は 1 つ以上の軸がある */
export type LabelAxesState = "undecided" | "off" | "on";

/** config の labels.axes（書いていなければ undefined）から軸の状態を決める */
export function labelAxesState(axes: readonly LabelAxis[] | undefined): LabelAxesState {
  if (axes === undefined) return "undecided";
  return axes.length === 0 ? "off" : "on";
}
