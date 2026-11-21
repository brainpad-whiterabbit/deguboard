// ラベルの語彙を画面でどう見せるか（UI-2・UI-3）。語彙と軸は core の label.list（store が読む）を写すだけで、ここは読んだ一覧から
// 札の見た目・絞り込みの候補の並び・属性の欄の選択肢を決める。React にも CommandClient にも依らない関数だけを置く。
// - 語彙のある名前は軸の色（軸の並びの番号で 6 色を回す）。語彙にない名前は色を付けず印を付ける
// - 語彙が 1 つもないボード（軸を決めていない・labels.yaml がない）は、前と同じく名前から色を決め、印は付けない（すべてに印が付くだけになるため）
// - 手順が付けるラベル（isProcedureLabel）は、語彙にあってもなくても目立たない見た目にし、行の札の後ろへ回す。
//   判定は core の model/labels.ts の写し（画面は core の型だけを取る。ADR-033）。ずれは label-vocab.test.ts が core と照らして見る
// - 絞り込みの名前は小文字にそろえ、統合済みの名前は統合先へ読み替える（resolveLabelFilter。統合先をたどる mergedLabelTarget も core の写し）。
//   チケットの側の大文字のラベルは同じ名前と読む（hasLabel）

import type { LabelListView } from "../types.js";

/** ラベルの色の数（styles.css の --dg-label-0〜5 と .label-color-0〜5） */
export const LABEL_COLOR_COUNT = 6;

/**
 * 手順が付けるラベルの頭（見直しの audit-<S>、振り返りの retro-<S>、リリースの release-<S>）。
 * 人が分類に使うラベルではないので、行では目立たせず「表示」のメニューで隠せる
 */
export const PROCEDURE_LABEL_PREFIXES = ["audit-", "retro-", "release-"] as const;

/** 手順が付けるラベルか。対象のない見直しは接頭辞のない audit を付ける（dg guide audit）ので、それも含める */
export function isProcedureLabel(name: string): boolean {
  return name === "audit" || PROCEDURE_LABEL_PREFIXES.some((p) => name.startsWith(p));
}

/** 語彙の 1 件の画面の見方 */
export interface VocabularyLabel {
  name: string;
  axis: string;
  /** 軸の並び（label.list の axes の順）の番号。色は LABEL_COLOR_COUNT で割った余り */
  axisIndex: number;
  description: string;
}

/** 画面の語彙。axes は label.list の軸の順で、語彙のない軸は入れない */
export interface LabelVocabulary {
  axes: ReadonlyArray<{
    name: string;
    description: string | null;
    labels: readonly VocabularyLabel[];
  }>;
  byName: ReadonlyMap<string, VocabularyLabel>;
  /** 統合の記録（統合済みの名前 → 統合先。label.list の merged）。絞り込みの読み替えに使う */
  mergedInto: ReadonlyMap<string, string>;
}

export const EMPTY_VOCABULARY: LabelVocabulary = {
  axes: [],
  byName: new Map(),
  mergedInto: new Map(),
};

/** label.list の出力（統合の記録も読む --merged 付き）から画面の語彙を作る。読めていなければ（null）語彙なし */
export function vocabularyOf(view: LabelListView | null | undefined): LabelVocabulary {
  if (!view) return EMPTY_VOCABULARY;
  const byName = new Map<string, VocabularyLabel>();
  const axes: Array<LabelVocabulary["axes"][number]> = [];
  view.axes.forEach((axis, axisIndex) => {
    const labels = axis.labels.map((l) => ({
      name: l.name,
      axis: axis.name,
      axisIndex,
      description: l.description,
    }));
    for (const l of labels) byName.set(l.name, l);
    if (labels.length > 0) axes.push({ name: axis.name, description: axis.description, labels });
  });
  const mergedInto = new Map((view.merged ?? []).map((m) => [m.name, m.merged_into]));
  return { axes, byName, mergedInto };
}

/**
 * 統合の記録の名前なら、統合先の名前。記録でない名前は undefined。
 * core の model/labels.ts の mergedLabelTarget の写し（画面は core の型だけを取る）。ずれは label-vocab.test.ts が core と照らして見る
 */
export function mergedLabelTarget(
  name: string,
  mergedInto: (name: string) => string | undefined,
): string | undefined {
  let to = mergedInto(name);
  const seen = new Set([name]);
  while (to !== undefined && !seen.has(to)) {
    seen.add(to);
    const next = mergedInto(to);
    if (next === undefined) break;
    to = next;
  }
  return to === name ? undefined : to;
}

/**
 * ラベルの絞り込みの値。name は絞る名前（小文字にそろえたもの）で、統合済みの名前を選んだ（URL・行の札）ときは統合先にし、
 * mergedFrom に元の名前（小文字にそろえたもの）を残す
 */
export interface LabelFilterValue {
  name: string;
  mergedFrom: string | undefined;
}

/**
 * 絞り込みのラベルを小文字にそろえ、そろえた後に統合済みの名前を読み替える（ticket list --label と同じ規則。core の normalizeLabelNames）。
 * 大文字のラベルが残るチケットの札を押しても、URL に大文字で書いても、小文字の名前で絞る。空の値は空のまま
 */
export function resolveLabelFilter(written: string, vocabulary: LabelVocabulary): LabelFilterValue {
  const name = written.toLowerCase();
  const to = name ? mergedLabelTarget(name, (n) => vocabulary.mergedInto.get(n)) : undefined;
  return to === undefined ? { name, mergedFrom: undefined } : { name: to, mergedFrom: name };
}

/**
 * チケットのラベルに絞り込みの名前があるか。大文字と小文字の違いは同じ名前と読む（小文字にそろえる前に付いた大文字のラベルにも当たる）。
 * core の model/labels.ts の hasAnyLabel の写し（画面は名前を 1 つだけ選ぶ）。ずれは label-vocab.test.ts が core と照らして見る
 */
export function hasLabel(labels: readonly string[], name: string): boolean {
  const wanted = name.toLowerCase();
  return labels.some((label) => label.toLowerCase() === wanted);
}

/**
 * ラベルの名前から色の番号（0〜LABEL_COLOR_COUNT-1）を決める。語彙のないボードで使う。同じ名前はどの画面・どの人でも同じ色になる。
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

/** 札の見た目。axis は語彙の軸の色、plain は名前から決めた色（語彙のないボード）、unknown は語彙にない名前、procedure は手順のラベル */
export type LabelLook =
  | { kind: "axis"; color: number; label: VocabularyLabel }
  | { kind: "plain"; color: number }
  | { kind: "unknown" }
  | { kind: "procedure"; label: VocabularyLabel | undefined };

export function labelLook(name: string, vocabulary: LabelVocabulary): LabelLook {
  const label = vocabulary.byName.get(name);
  if (isProcedureLabel(name)) return { kind: "procedure", label };
  if (label) return { kind: "axis", color: label.axisIndex % LABEL_COLOR_COUNT, label };
  if (vocabulary.byName.size === 0) return { kind: "plain", color: labelColorIndex(name) };
  return { kind: "unknown" };
}

/** 札に付ける class（styles.css の .label-color-*・.label-unknown・.label-procedure） */
export function labelLookClass(look: LabelLook): string {
  switch (look.kind) {
    case "axis":
    case "plain":
      return `label-color-${look.color}`;
    case "unknown":
      return "label-unknown";
    case "procedure":
      return "label-procedure";
  }
}

/**
 * 行に並べる順：手順のラベルを後ろへ回し（ほかの順は保つ）、hideProcedure なら手順のラベルを除く。
 * 行に出せる数は限られるので、人が分類に使うラベルを先に見せる
 */
export function rowLabelOrder(labels: readonly string[], hideProcedure: boolean): string[] {
  const own = labels.filter((l) => !isProcedureLabel(l));
  return hideProcedure ? own : [...own, ...labels.filter(isProcedureLabel)];
}

/** 絞り込みの候補の 1 つ */
export interface LabelOption {
  name: string;
  /** 語彙の説明。語彙にない名前は undefined */
  description: string | undefined;
}

/** 絞り込みの候補の組。axis が null の組は語彙にない名前（語彙のないボードでは全部） */
export interface LabelOptionGroup {
  axis: string | null;
  options: LabelOption[];
}

/**
 * 絞り込みの候補（names。名前の順に並んだもの）を、語彙の軸ごとの組に分ける。組は軸の順、語彙にない名前の組は最後。
 * 候補にない語彙は出さない（絞っても 0 件になるため）
 */
export function labelOptionGroups(
  names: readonly string[],
  vocabulary: LabelVocabulary,
): LabelOptionGroup[] {
  const groups = vocabulary.axes.map((a): LabelOptionGroup => ({ axis: a.name, options: [] }));
  const byAxis = new Map(groups.map((g) => [g.axis, g]));
  const rest: LabelOption[] = [];
  for (const name of names) {
    const v = vocabulary.byName.get(name);
    const group = v ? byAxis.get(v.axis) : undefined;
    if (v && group) group.options.push({ name, description: v.description });
    else rest.push({ name, description: undefined });
  }
  const filled = groups.filter((g) => g.options.length > 0);
  return rest.length > 0 ? [...filled, { axis: null, options: rest }] : filled;
}

/** 絞り込みの候補の文字（名前と、語彙にあれば説明） */
export function labelOptionText(option: LabelOption): string {
  return option.description ? `${option.name} — ${option.description}` : option.name;
}

/** 属性の欄のラベル（入力を parseLabels で分けたもの）に、語彙のラベルを足すか外す。今あれば外し、なければ後ろに足す */
export function toggleLabel(names: readonly string[], name: string): string[] {
  return names.includes(name) ? names.filter((n) => n !== name) : [...names, name];
}
