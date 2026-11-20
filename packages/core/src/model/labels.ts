// ラベルの語彙（データのブランチの labels.yaml。requirements.md 5.1、ADR-037）。
// 最上位のキーがラベルの名前なので、名前は軸をまたいで 1 つだけになる（同じキーを 2 回書いた YAML は読めない）。
// キーごとにマージドライバが 3-way で解くので、別々のラベルを同時に足しても競合しない（git/merge.ts）。
// ここには形の検査と、語彙とチケットから一覧を作る判定、語彙を書く操作（dg label add・update・remove）の判定を、
// ファイルを読まない関数で置く。読むのは storage/labels-file.ts、書くのは Store の writeLabel

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import type { LabelAxis } from "./config.js";
import { labelAxesState, type LabelAxesState } from "./label-axes.js";

/**
 * ラベルの名前の規則。書く操作（dg label add）と読みの検査（parseVocabulary）が同じ規則を使う。
 * - 小文字にそろえた名前だけ（大文字と小文字だけが違う名前を 2 つ持たない）。日本語などの文字は使える
 * - 空白とカンマを含まない（`--label a,b` はカンマで分けて読む）。先頭の `-` も拒む（CLI がオプションとして読む）
 * - `_` を含まない。updated_at・closed_at のような名前は、マージドライバがフィールドの名前で選ぶ規則
 *   （git/merge.ts の NEWER_WINS・SAME_STATUS_TIMES）に当たり、ラベルごとの 3-way と違う解き方になるため。
 *   その規則の名前はどれも `_` を含むので、名前を並べずに `_` を拒んで外す。`_` なしで通る checkpoints（UNION_RECORDS）は、
 *   両側が配列のときだけ効く規則で、語彙の項目はマッピングなので当たらない
 */
export const labelNameSchema = z
  .string()
  .regex(
    /^[^\s,_-][^\s,_]*$/,
    "A label name has no whitespace, comma, or underscore, and does not start with a hyphen",
  )
  .refine((name) => name === name.toLowerCase(), { message: "A label name is lowercase" });

/**
 * 手順が付けるラベルの接頭辞（dg guide audit の audit-<S>、retro の retro-<S>、release の release-<S>。
 * Iteration ごとに増える印で、軸に属さない）。語彙には足さず（judgeLabelAdd）、語彙にない名前としても指摘しない（model/label-lint.ts）
 */
export const PROCEDURE_LABEL_PREFIXES = ["audit-", "retro-", "release-"] as const;

/** 手順が付けるラベルか。対象のない見直しは接頭辞のない audit を付ける（dg guide audit）ので、それも含める */
export function isProcedureLabel(name: string): boolean {
  return name === "audit" || PROCEDURE_LABEL_PREFIXES.some((p) => name.startsWith(p));
}

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
 * labels.yaml の中身（YAML を読んだ値）を項目ごとに、名前（labelNameSchema）と中身の形で検査する。読めない項目は errors に入れ、読めた項目だけを返す
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
    const key = labelNameSchema.safeParse(name);
    const parsed = labelEntrySchema.safeParse(value);
    if (!key.success) errors.push({ name, detail: `name: ${z.prettifyError(key.error)}` });
    else if (!parsed.success) errors.push({ name, detail: z.prettifyError(parsed.error) });
    else if (parsed.data.merged_into === name)
      errors.push({ name, detail: "merged_into points to the label itself" });
    else entries.push([name, parsed.data]);
  }
  return { entries, errors };
}

/** 語彙を書く操作を拒む理由（コマンドが OperationError にする） */
export interface LabelRejection {
  ok: false;
  code: "VALIDATION_FAILED" | "NOT_FOUND" | "ALREADY_EXISTS" | "REJECTED";
  message: string;
  detail?: string;
}

/** 語彙を書く操作の判定の結果。通れば、書く名前と項目 */
export type LabelWriteJudgement = { ok: true; name: string; entry: LabelEntry } | LabelRejection;

const rejection = (
  code: LabelRejection["code"],
  message: string,
  detail?: string,
): LabelRejection => ({ ok: false, code, message, ...(detail === undefined ? {} : { detail }) });

/** 統合の記録か（語彙としては使わない） */
const isMerged = (entry: LabelEntry): boolean => entry.merged_into !== undefined;

/** 語彙にない名前と統合の記録を、書き換える操作（update・remove）から外す */
function vocabularyEntry(
  vocabulary: Vocabulary,
  name: string,
): { ok: true; entry: LabelEntry } | LabelRejection {
  const entry = vocabulary.get(name);
  if (!entry)
    return rejection("NOT_FOUND", `No label ${name}`, "dg label list shows the vocabulary");
  if (isMerged(entry))
    return rejection(
      "REJECTED",
      `${name} is a record of a merge into ${entry.merged_into}, not a label of the vocabulary`,
    );
  return { ok: true, entry };
}

/**
 * 語彙に足す名前と項目を決める（dg label add。git もファイルも読まない）。名前は小文字にそろえてから確かめる。
 * 拒むのは、名前の規則（labelNameSchema）に合わない名前・手順のラベルの名前（isProcedureLabel）・説明のない語彙・labels.axes にない軸・
 * 統合済みの名前・もうある名前（名前は軸をまたいで 1 つなので、ほかの軸にある名前も足せない）
 */
export function judgeLabelAdd(
  input: { name: string; axis: string; description: string },
  axes: readonly LabelAxis[] | undefined,
  vocabulary: Vocabulary,
  now: string,
): LabelWriteJudgement {
  const name = input.name.toLowerCase();
  const key = labelNameSchema.safeParse(name);
  if (!key.success)
    return rejection(
      "VALIDATION_FAILED",
      `${JSON.stringify(input.name)} cannot be a label name`,
      z.prettifyError(key.error),
    );
  if (isProcedureLabel(name))
    return rejection(
      "VALIDATION_FAILED",
      `${name} is a name that the steps of an Iteration attach to the tickets they file`,
      `The name audit and names that start with ${PROCEDURE_LABEL_PREFIXES.join(", ")} are attached by the steps and belong to no axis, so they are not vocabulary`,
    );
  const description = input.description.trim();
  if (description === "")
    return rejection("VALIDATION_FAILED", "A label needs a description (--description)");
  if (!(axes ?? []).some((a) => a.name === input.axis))
    return rejection(
      "VALIDATION_FAILED",
      `No label axis ${input.axis}`,
      `Axes: ${(axes ?? []).map((a) => a.name).join(", ") || "(none)"}. A label belongs to one axis of labels.axes: add the axis first with dg label axis set`,
    );
  const existing = vocabulary.get(name);
  if (existing && isMerged(existing))
    return rejection(
      "REJECTED",
      `${name} was merged into ${existing.merged_into}, so it cannot be added again`,
      `Use ${existing.merged_into} instead`,
    );
  if (existing)
    return rejection(
      "ALREADY_EXISTS",
      existing.axis === input.axis
        ? `The label ${name} already exists`
        : `The label ${name} already exists on the axis ${existing.axis}`,
      existing.axis === input.axis
        ? "dg label update changes its description"
        : "A name belongs to one axis only. Choose another name, or use the label that exists",
    );
  return { ok: true, name, entry: { axis: input.axis, description, created_at: now } };
}

/** 語彙の説明を替える（dg label update）。語彙にない名前・統合の記録・空の説明を拒み、ほかの項目は残す */
export function judgeLabelUpdate(
  input: { name: string; description: string },
  vocabulary: Vocabulary,
): LabelWriteJudgement {
  const name = input.name.toLowerCase();
  const found = vocabularyEntry(vocabulary, name);
  if (!found.ok) return found;
  const description = input.description.trim();
  if (description === "")
    return rejection("VALIDATION_FAILED", "A label needs a description (--description)");
  return { ok: true, name, entry: { ...found.entry, description } };
}

/** 拒む文に並べるチケットの数の上限 */
const LISTED_TICKETS = 10;

/**
 * 語彙から消す（dg label remove）。語彙にない名前・統合の記録と、チケットが使っている語彙を拒む
 * （done・abandoned のチケットも数える。label.list の count と同じ数え方）
 */
export function judgeLabelRemove(
  input: { name: string },
  vocabulary: Vocabulary,
  tickets: Iterable<{ id: string; labels: readonly string[] }>,
): LabelWriteJudgement {
  const name = input.name.toLowerCase();
  const found = vocabularyEntry(vocabulary, name);
  if (!found.ok) return found;
  const users = [...tickets].filter((t) => t.labels.includes(name)).map((t) => t.id);
  if (users.length > 0)
    return rejection(
      "REJECTED",
      `${users.length} ${users.length === 1 ? "ticket carries" : "tickets carry"} the label ${name}, so it cannot be removed`,
      `${users.slice(0, LISTED_TICKETS).join(", ")}${users.length > LISTED_TICKETS ? ", ..." : ""}. Take the label off them first (dg ticket update <id> --label), or see them with dg ticket list --label ${name}`,
    );
  return { ok: true, name, entry: found.entry };
}

/** 軸に残っている語彙の名前（名前の順。統合の記録は数えない）。dg label axis remove が、語彙の残る軸を拒むのに使う */
export function labelsOfAxis(vocabulary: Vocabulary, axis: string): string[] {
  return [...vocabulary]
    .filter(([, e]) => e.axis === axis && !isMerged(e))
    .map(([name]) => name)
    .sort();
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
