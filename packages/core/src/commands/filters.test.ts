import { describe, expect, it } from "vitest";
import type { LabelEntry } from "../model/labels.js";
import { matchesQuery, resolveLabelFilter } from "./filters.js";

const t = { id: "t12" as const, title: "Web の検索", labels: ["UI", "search-ui"] };

describe("検索語の当て方（matchesQuery）", () => {
  it("番号・タイトル・ラベルの部分一致で、前後の空白と大文字小文字によらない", () => {
    expect(matchesQuery(t, "T1")).toBe(true);
    expect(matchesQuery(t, " web ")).toBe(true);
    expect(matchesQuery(t, "ui")).toBe(true);
    expect(matchesQuery(t, "t3")).toBe(false);
    expect(matchesQuery(t, "")).toBe(true);
  });

  it("labels を false にするとラベルには当てない", () => {
    expect(matchesQuery(t, "search-ui", false)).toBe(false);
    expect(matchesQuery(t, "検索", false)).toBe(true);
  });
});

// そろえ方と読み替えの組み合わせは model/labels.test.ts（normalizeLabelNames）。ここは絞り込みの値がその関数を通ることだけを見る
describe("絞り込みのラベルの読み替え（resolveLabelFilter）", () => {
  const at = "2026-11-01T00:00:00Z";
  const vocabulary = new Map<string, LabelEntry>([
    ["ui", { axis: "area", description: "The board", created_at: at }],
    [
      "web",
      { axis: "area", description: "Old name", created_at: at, merged_into: "ui", merged_at: at },
    ],
  ]);

  it("名前を小文字にそろえ、大文字で書いた統合済みの名前も統合先で絞って警告にする。そろえただけなら警告はない", () => {
    expect(resolveLabelFilter({ label: ["UI", "Bug"] }, vocabulary)).toEqual({
      filter: { label: ["ui", "bug"] },
      warnings: [],
    });
    expect(resolveLabelFilter({ label: ["WEB"], query: "x" }, vocabulary)).toEqual({
      filter: { label: ["ui"], query: "x" },
      warnings: [
        "The label web was merged into ui, so ui is used for the filter instead. Use ui from now on",
      ],
    });
  });

  it("ラベルのない絞り込みはそのまま返す", () => {
    const filter = { query: "x" };
    expect(resolveLabelFilter(filter, vocabulary)).toEqual({ filter, warnings: [] });
  });
});
