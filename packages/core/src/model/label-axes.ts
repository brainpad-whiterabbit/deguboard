// ラベルの軸の候補と、kind の推薦の語彙（requirements.md 5.10、ADR-037）。名前と説明を英語で持つ。
// 候補は config の既定ではない（labels.axes は書くまでオフ）：軸をまだ決めていないボードに勧めるときの出発点で、
// 人が選んだものだけを dg label axis set がチームの config.yaml に書く。形は書く軸と同じ（labelAxisSchema）なので、
// 選ばれたらそのまま記録できる。読むのは dg label axis list --candidates と設定画面（config.show の label_axis_candidates）。
// 軸を消してよいかの判定（judgeLabelAxisRemove）もここに置く。labels.ts がこのファイルを読むので、labels.ts からは型だけを読む

import type { LabelAxis } from "./config.js";
import type { LabelRejection, Vocabulary } from "./labels.js";

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

/** 軸に残っている語彙の名前（名前の順。統合の記録は数えない）。dg label axis remove が、語彙の残る軸を拒むのに使う */
export function labelsOfAxis(vocabulary: Vocabulary, axis: string): string[] {
  return [...vocabulary]
    .filter(([, e]) => e.axis === axis && e.merged_into === undefined)
    .map(([name]) => name)
    .sort();
}

/** 軸を消す操作の判定の結果。通れば、書く軸の一覧 */
export type LabelAxisRemoveJudgement = { ok: true; axes: LabelAxis[] } | LabelRejection;

/** dg label axis remove の入力 */
export interface LabelAxisRemoveInput {
  name?: string | undefined;
  all?: boolean | undefined;
}

/**
 * 名前と all の片方だけが渡されたかを確かめる（軸を読まない）。コマンドは書き込みのロックに入る前にこれで弾き、
 * judgeLabelAxisRemove も最初に同じ判定をする
 */
export function judgeLabelAxisRemoveInput(input: LabelAxisRemoveInput): LabelRejection | undefined {
  if ((input.name === undefined) === (input.all === true)) return undefined;
  return {
    ok: false,
    code: "VALIDATION_FAILED",
    message: "Give either the name of an axis or --all",
    detail:
      "dg label axis remove <name> removes one axis, and dg label axis remove --all removes every axis",
  };
}

/**
 * 消した後の軸の一覧を決める（dg label axis remove。git もファイルも読まない）。axes は書いていなければ undefined。
 * 拒むのは、名前と all の片方だけでない入力・axes にない名前（書いていないボードも）・語彙の残る軸（all はどれか 1 つでも）。
 * 語彙の残る軸を消さないのは、軸のない語彙を残さないため。語彙を先に消してもらう。
 * all は書いていないボードにも `[]` を返し、使わないと決めたことを残す
 */
export function judgeLabelAxisRemove(
  input: LabelAxisRemoveInput,
  axes: readonly LabelAxis[] | undefined,
  vocabulary: Vocabulary,
): LabelAxisRemoveJudgement {
  const invalid = judgeLabelAxisRemoveInput(input);
  if (invalid) return invalid;
  const { name } = input;
  const written = axes ?? [];
  if (name !== undefined && !written.some((a) => a.name === name))
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `No label axis ${name}`,
      detail: `Axes: ${written.map((a) => a.name).join(", ") || "(none)"}`,
    };
  const left = written
    .filter((a) => name === undefined || a.name === name)
    .map((a) => ({ axis: a.name, labels: labelsOfAxis(vocabulary, a.name) }))
    .filter((a) => a.labels.length > 0);
  if (left.length > 0) {
    const one = left.length === 1;
    return {
      ok: false,
      code: "REJECTED",
      message: `The label ${one ? "axis" : "axes"} ${left.map((a) => a.axis).join(", ")} still ${one ? "has" : "have"} labels, so ${one ? "it" : "they"} cannot be removed`,
      detail: `${left.map((a) => `${a.axis}: ${a.labels.join(", ")}`).join("; ")}. Remove the labels first with dg label remove`,
    };
  }
  return { ok: true, axes: name === undefined ? [] : written.filter((a) => a.name !== name) };
}
