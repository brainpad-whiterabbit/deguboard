// ラベルの語彙（データのブランチの labels.yaml。requirements.md 5.1、ADR-037）。
// 最上位のキーがラベルの名前なので、名前は軸をまたいで 1 つだけになる（同じキーを 2 回書いた YAML は読めない）。
// キーごとにマージドライバが 3-way で解くので、別々のラベルを同時に足しても競合しない（git/merge.ts）。
// ここには形の検査と、語彙とチケットから一覧を作る判定を、ファイルを読まない関数で置く。読むのは storage/labels-file.ts

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import type { LabelAxis } from "./config.js";
import { labelAxesState, type LabelAxesState } from "./label-axes.js";

/** 語彙の 1 項目。merged_into・merged_at を持つものは統合の記録で、語彙としては使わない（付けられる名前に数えない） */
export const labelEntrySchema = z
  .looseObject({
    axis: slugSchema.describe("Name of the axis the label belongs to"),
    description: z.string().min(1).describe("What the label covers, in one line"),
    created_at: isoDateTime,
    merged_into: z.string().min(1).optional().describe("The label this one was merged into"),
    merged_at: isoDateTime.optional(),
  })
  .refine((e) => (e.merged_into === undefined) === (e.merged_at === undefined), {
    message: "merged_into and merged_at go together",
  });
export type LabelEntry = z.output<typeof labelEntrySchema>;

/** 読めた語彙（名前 → 項目。統合の記録も含む） */
export type Vocabulary = ReadonlyMap<string, LabelEntry>;

/** 読めなかった 1 項目。name がないのはファイルの全体（最上位がマッピングでない） */
export interface VocabularyError {
  name?: string;
  detail: string;
}

/**
 * labels.yaml の中身（YAML を読んだ値）を項目ごとに、名前（slug）と中身の形で検査する。読めない項目は errors に入れ、読めた項目だけを返す
 * （1 項目の誤りでほかの語彙を失わない。DT-1）。ファイルがない・空（null）は語彙なし
 */
export function parseVocabulary(raw: unknown): {
  entries: Array<[string, LabelEntry]>;
  errors: VocabularyError[];
} {
  if (raw === undefined || raw === null) return { entries: [], errors: [] };
  if (typeof raw !== "object" || Array.isArray(raw))
    return {
      entries: [],
      errors: [{ detail: "The top level must be a mapping from label names to entries" }],
    };
  const entries: Array<[string, LabelEntry]> = [];
  const errors: VocabularyError[] = [];
  for (const [name, value] of Object.entries(raw)) {
    // 名前は slug に限る。updated_at・closed_at のような名前（_ を含む）は、マージドライバがフィールドの名前で選ぶ規則
    // （git/merge.ts の NEWER_WINS・SAME_STATUS_TIMES）に当たり、ラベルごとの 3-way と違う解き方になるため。
    // slug でも通る checkpoints（UNION_RECORDS）は、両側が配列のときだけ効く規則で、項目はマッピングなので当たらない
    const key = slugSchema.safeParse(name);
    const parsed = labelEntrySchema.safeParse(value);
    if (!key.success) errors.push({ name, detail: `name: ${z.prettifyError(key.error)}` });
    else if (!parsed.success) errors.push({ name, detail: z.prettifyError(parsed.error) });
    else if (parsed.data.merged_into === name)
      errors.push({ name, detail: "merged_into points to the label itself" });
    else entries.push([name, parsed.data]);
  }
  return { entries, errors };
}

/** 語彙の 1 件と、その使われ方 */
export interface LabelUsage {
  name: string;
  description: string;
  created_at: string;
  /** この名前が付いたチケットの数（done・abandoned も数える。墓標は数えない） */
  count: number;
  /** この名前が付いたチケットのうち、最も新しく起票されたものの created_at。付いたチケットがなければ null */
  last_used_at: string | null;
}

/** 1 つの軸とその語彙 */
export interface LabelAxisView {
  name: string;
  /** 軸の説明。labels.axes にない軸（語彙だけが指している）は null */
  description: string | null;
  labels: LabelUsage[];
}

/** 統合の記録の 1 件 */
export interface MergedLabel {
  name: string;
  axis: string;
  description: string;
  merged_into: string;
  merged_at: string;
}

/** 語彙にない名前の 1 件 */
export interface UndefinedLabel {
  name: string;
  count: number;
}

export interface LabelListView {
  state: LabelAxesState;
  axes: LabelAxisView[];
  /** 統合の記録（--merged を付けたときだけ） */
  merged?: MergedLabel[];
  /** チケットに付いているが語彙にない名前（--undefined を付けたときだけ） */
  undefined?: UndefinedLabel[];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * 軸・語彙・チケットから label.list の出力を決める（git もファイルも読まない）。
 * - 軸は labels.axes の順に並べ、語彙のない軸も出す。labels.axes にない軸を指す語彙は、その後ろに軸の名前の順で出す（description が null）
 * - 語彙は名前の順。統合の記録は語彙に入れず、チケットに付いていれば語彙にない名前として数える
 * - 最後に使われた日は、付いたチケットの起票の時刻の最も新しいもの（ラベルを付けた時刻は記録にないので、起票の時刻で代える）
 */
export function labelListView(
  axes: readonly LabelAxis[] | undefined,
  vocabulary: Vocabulary,
  tickets: Iterable<{ labels: readonly string[]; created_at: string }>,
  options: { merged?: boolean | undefined; undefined?: boolean | undefined } = {},
): LabelListView {
  const used = new Map<string, { count: number; last: string }>();
  for (const t of tickets) {
    for (const name of new Set(t.labels)) {
      const u = used.get(name);
      if (!u) used.set(name, { count: 1, last: t.created_at });
      else {
        u.count++;
        if (Date.parse(t.created_at) > Date.parse(u.last)) u.last = t.created_at;
      }
    }
  }
  const views = new Map<string, LabelAxisView>(
    (axes ?? []).map((a) => [a.name, { name: a.name, description: a.description, labels: [] }]),
  );
  const strays: LabelAxisView[] = [];
  const merged: MergedLabel[] = [];
  for (const [name, e] of vocabulary) {
    if (e.merged_into !== undefined && e.merged_at !== undefined) {
      merged.push({
        name,
        axis: e.axis,
        description: e.description,
        merged_into: e.merged_into,
        merged_at: e.merged_at,
      });
      continue;
    }
    let view = views.get(e.axis);
    if (!view) {
      view = { name: e.axis, description: null, labels: [] };
      views.set(e.axis, view);
      strays.push(view);
    }
    const u = used.get(name);
    view.labels.push({
      name,
      description: e.description,
      created_at: e.created_at,
      count: u?.count ?? 0,
      last_used_at: u?.last ?? null,
    });
  }
  strays.sort(byName);
  const listed = [...views.values()].filter((v) => v.description !== null);
  for (const v of [...listed, ...strays]) v.labels.sort(byName);
  const isVocabulary = (name: string) => {
    const e = vocabulary.get(name);
    return e !== undefined && e.merged_into === undefined;
  };
  return {
    state: labelAxesState(axes),
    axes: [...listed, ...strays],
    ...(options.merged ? { merged: merged.sort(byName) } : {}),
    ...(options.undefined
      ? {
          undefined: [...used]
            .filter(([name]) => !isVocabulary(name))
            .map(([name, u]) => ({ name, count: u.count }))
            .sort(byName),
        }
      : {}),
  };
}
