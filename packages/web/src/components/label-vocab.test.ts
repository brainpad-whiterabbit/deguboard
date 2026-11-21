// 写しを照らすためだけに core の実行時のコード（isProcedureLabel・mergedLabelTarget・hasAnyLabel・normalizeLabelNames）を取り込む
// （画面のコードは型だけを取る。ADR-033）
import {
  hasAnyLabel as coreHasAnyLabel,
  isProcedureLabel as coreIsProcedureLabel,
  mergedLabelTarget as coreMergedLabelTarget,
  normalizeLabelNames,
  type LabelEntry,
} from "@deguboard/core";
import { describe, expect, it } from "vitest";
import type { LabelListView } from "../types.js";
import {
  EMPTY_VOCABULARY,
  LABEL_COLOR_COUNT,
  hasLabel,
  isProcedureLabel,
  labelColorIndex,
  labelLook,
  labelOptionGroups,
  mergedLabelTarget,
  resolveLabelFilter,
  rowLabelOrder,
  toggleLabel,
  vocabularyOf,
} from "./label-vocab.js";

const usage = (name: string, description: string) => ({
  name,
  description,
  created_at: "2026-01-01T00:00:00Z",
  count: 0,
  last_used_at: null,
});

/** 軸を 7 つ並べた label.list（色が 6 色を回ることを見る）。empty は語彙のない軸 */
const VIEW: LabelListView = {
  state: "on",
  axes: [
    { name: "area", description: "Part", labels: [usage("ui", "画面"), usage("cli", "CLI")] },
    { name: "empty", description: "語彙のない軸", labels: [] },
    { name: "kind", description: "Kind", labels: [usage("bug", "不具合")] },
    { name: "a3", description: "", labels: [usage("x3", "")] },
    { name: "a4", description: "", labels: [usage("x4", "")] },
    { name: "a5", description: "", labels: [usage("x5", "")] },
    { name: "a6", description: "", labels: [usage("x6", "")] },
    { name: "stray", description: null, labels: [usage("audit-s1", "見直しの直し")] },
  ],
};

describe("ラベルの色（語彙のないボードは名前から決める）", () => {
  it("同じ名前はいつも同じ色で、色は 6 色のどれか", () => {
    for (const name of ["web", "docs", "gate", "ui", "日本語のラベル", "", "a".repeat(200)]) {
      const index = labelColorIndex(name);
      expect(index).toBe(labelColorIndex(name));
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(LABEL_COLOR_COUNT);
    }
  });

  it("決め方（FNV-1a を 6 で割った余り）を変えない。変えると、人の見慣れたラベルの色が入れ替わる", () => {
    // 空の名前は FNV-1a の初期値 0x811c9dc5 の余り
    expect(labelColorIndex("")).toBe(0x811c9dc5 % 6);
    expect(["a", "ab", "web", "docs", "gate", "ui", "release"].map(labelColorIndex)).toEqual([
      4, 0, 1, 0, 2, 5, 4,
    ]);
  });

  it("似た名前を 1 色に寄せず、6 色をどれも使う", () => {
    const names = Array.from({ length: 24 }, (_, i) => `label-${i}`);
    expect(new Set(names.map(labelColorIndex)).size).toBe(LABEL_COLOR_COUNT);
  });
});

describe("label.list から画面の語彙を作る", () => {
  it("読めていなければ語彙なし", () => {
    expect(vocabularyOf(null)).toBe(EMPTY_VOCABULARY);
    expect(vocabularyOf(undefined)).toBe(EMPTY_VOCABULARY);
  });

  it("軸の番号は label.list の軸の順（語彙のない軸も数える）で、語彙のない軸は選ぶ一覧に入れない", () => {
    const v = vocabularyOf(VIEW);
    expect(v.axes.map((a) => a.name)).toEqual(["area", "kind", "a3", "a4", "a5", "a6", "stray"]);
    expect(v.byName.get("bug")).toEqual({
      name: "bug",
      axis: "kind",
      axisIndex: 2,
      description: "不具合",
    });
  });
});

describe("札の見た目", () => {
  const v = vocabularyOf(VIEW);

  it("語彙のある名前は軸の色（軸の番号を 6 で割った余り）", () => {
    expect(labelLook("ui", v)).toMatchObject({ kind: "axis", color: 0 });
    expect(labelLook("cli", v)).toMatchObject({ kind: "axis", color: 0 });
    expect(labelLook("bug", v)).toMatchObject({ kind: "axis", color: 2 });
    // 7 番目の軸（番号 6）は最初の色に戻る
    expect(labelLook("x6", v)).toMatchObject({ kind: "axis", color: 0 });
  });

  it("語彙にない名前は unknown。語彙のないボードは名前から色を決め、印は付けない", () => {
    expect(labelLook("misc", v)).toEqual({ kind: "unknown" });
    expect(labelLook("misc", EMPTY_VOCABULARY)).toEqual({
      kind: "plain",
      color: labelColorIndex("misc"),
    });
  });

  it("手順のラベルは語彙にあってもなくても procedure（語彙にあれば説明を持つ）", () => {
    expect(labelLook("retro-s2", v)).toEqual({ kind: "procedure", label: undefined });
    expect(labelLook("audit-s1", v)).toMatchObject({
      kind: "procedure",
      label: { description: "見直しの直し" },
    });
    expect(labelLook("release-s1", EMPTY_VOCABULARY)).toEqual({
      kind: "procedure",
      label: undefined,
    });
  });

  it("手順のラベルは頭が audit-・retro-・release- のものと、対象のない見直しの audit", () => {
    expect(["audit", "audit-s3", "retro-s1", "release-s9"].every(isProcedureLabel)).toBe(true);
    expect(["auditor", "pre-release-s1", "retros", "retro", "release"].some(isProcedureLabel)).toBe(
      false,
    );
  });

  it("core の isProcedureLabel の写しで、同じ結果になる", () => {
    const names = ["audit", "audit-s3", "auditor", "retro", "retro-s1", "retros", "release"];
    const more = ["release-s9", "pre-release-s1", "ui", "bug", "Audit", ""];
    for (const name of [...names, ...more])
      expect([name, isProcedureLabel(name)]).toEqual([name, coreIsProcedureLabel(name)]);
  });
});

describe("絞り込みの統合済みの名前の読み替え", () => {
  const at = "2026-01-02T00:00:00Z";
  const merged = (name: string, into: string) => ({
    name,
    axis: "area",
    description: "Old name",
    merged_into: into,
    merged_at: at,
  });
  const v = vocabularyOf({ ...VIEW, merged: [merged("web", "ui"), merged("frontend", "ui")] });

  it("統合の記録の名前は統合先で絞り、元の名前を残す。語彙の名前・語彙にない名前・空はそのまま", () => {
    expect(resolveLabelFilter("web", v)).toEqual({ name: "ui", mergedFrom: "web" });
    for (const name of ["ui", "misc", ""])
      expect(resolveLabelFilter(name, v)).toEqual({ name, mergedFrom: undefined });
    // 統合の記録を読まなかった語彙（--merged なしの label.list・語彙なし）は読み替えない
    expect(resolveLabelFilter("web", vocabularyOf(VIEW))).toEqual({
      name: "web",
      mergedFrom: undefined,
    });
    expect(resolveLabelFilter("web", EMPTY_VOCABULARY).mergedFrom).toBeUndefined();
  });

  it("名前を小文字にそろえてから読み替える。大文字で書いた語彙の名前は語彙の名前で、大文字で書いた統合済みの名前は統合先で絞る", () => {
    expect(resolveLabelFilter("UI", v)).toEqual({ name: "ui", mergedFrom: undefined });
    expect(resolveLabelFilter("Web", v)).toEqual({ name: "ui", mergedFrom: "web" });
    // 語彙にない名前も、語彙のないボードでもそろえる
    expect(resolveLabelFilter("Misc", v)).toEqual({ name: "misc", mergedFrom: undefined });
    expect(resolveLabelFilter("UI", EMPTY_VOCABULARY)).toEqual({
      name: "ui",
      mergedFrom: undefined,
    });
    // ticket list --label と同じ規則（core の normalizeLabelNames）
    const vocabulary = new Map(
      [...v.mergedInto].map(([name, to]): [string, LabelEntry] => [
        name,
        { axis: "area", description: "Old name", created_at: at, merged_into: to, merged_at: at },
      ]),
    );
    for (const name of ["UI", "Web", "FRONTEND", "Misc", "ui"])
      expect([name, resolveLabelFilter(name, v).name]).toEqual([
        name,
        normalizeLabelNames([name], vocabulary).labels[0],
      ]);
  });

  it("絞る名前は、大文字小文字の違うチケットのラベルにも当たる（hasLabel）。core の hasAnyLabel の写しで、同じ結果になる", () => {
    // 小文字にそろえる前に付いた大文字のラベルが残るチケットに、小文字の名前で当たる
    expect(hasLabel(["UI", "bug"], "ui")).toBe(true);
    expect(hasLabel(["search-ui"], "ui")).toBe(false);
    const cases: Array<[string[], string]> = [
      [["UI", "bug"], "ui"],
      [["ui"], "UI"],
      [["Ui"], "uI"],
      [["search-ui"], "ui"],
      [["ui"], "docs"],
      [[], "ui"],
      [["画面"], "画面"],
    ];
    for (const [labels, name] of cases)
      expect([labels, name, hasLabel(labels, name)]).toEqual([
        labels,
        name,
        coreHasAnyLabel(labels, [name]),
      ]);
  });

  it("core の mergedLabelTarget の写しで、連鎖と循環も同じ結果になる", () => {
    const chain = new Map([
      ["a", "b"],
      ["b", "c"],
      ["x", "y"],
      ["y", "x"],
      ["p", "q"],
      ["q", "r"],
      ["r", "q"],
      ["self", "self"],
    ]);
    const into = (name: string) => chain.get(name);
    for (const name of ["a", "b", "c", "x", "y", "p", "q", "r", "self", "none"])
      expect([name, mergedLabelTarget(name, into)]).toEqual([
        name,
        coreMergedLabelTarget(name, into),
      ]);
  });
});

describe("行に並べる順", () => {
  it("手順のラベルを後ろへ回し、ほかの順は保つ。隠すなら除く", () => {
    const labels = ["audit-s3", "ui", "release-s3", "bug"];
    expect(rowLabelOrder(labels, false)).toEqual(["ui", "bug", "audit-s3", "release-s3"]);
    expect(rowLabelOrder(labels, true)).toEqual(["ui", "bug"]);
  });
});

describe("絞り込みの候補の組", () => {
  const v = vocabularyOf(VIEW);

  it("軸の順の組に分け、候補にない語彙と空の組は出さない。語彙にない名前は最後の組", () => {
    expect(labelOptionGroups(["bug", "misc", "ui", "zz"], v)).toEqual([
      { axis: "area", options: [{ name: "ui", description: "画面" }] },
      { axis: "kind", options: [{ name: "bug", description: "不具合" }] },
      {
        axis: null,
        options: [
          { name: "misc", description: undefined },
          { name: "zz", description: undefined },
        ],
      },
    ]);
  });

  it("語彙のないボードは 1 つの組", () => {
    expect(labelOptionGroups(["a", "b"], EMPTY_VOCABULARY)).toEqual([
      {
        axis: null,
        options: [
          { name: "a", description: undefined },
          { name: "b", description: undefined },
        ],
      },
    ]);
    expect(labelOptionGroups([], EMPTY_VOCABULARY)).toEqual([]);
  });
});

describe("属性の欄で語彙のラベルを足し外しする", () => {
  it("なければ後ろに足し、あれば外す", () => {
    expect(toggleLabel(["web"], "ui")).toEqual(["web", "ui"]);
    expect(toggleLabel(["web", "ui"], "web")).toEqual(["ui"]);
    expect(toggleLabel([], "ui")).toEqual(["ui"]);
  });
});
