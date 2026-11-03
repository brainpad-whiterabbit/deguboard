// 検索の当て方の写しを照らすためだけに core の実行時のコード（matchesQuery）を取り込む（画面のコードは型だけを取る。ADR-007）
import { matchesQuery } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import { ticketMatchesQuery } from "./types.js";

const t = { id: "t12" as const, title: "Web の検索", labels: ["UI", "search-ui"] };

describe("検索の当て方（ticketMatchesQuery）", () => {
  it("番号・タイトル・ラベルの部分一致で、前後の空白と大文字小文字によらない", () => {
    expect(ticketMatchesQuery(t, "T1")).toBe(true);
    expect(ticketMatchesQuery(t, " web ")).toBe(true);
    expect(ticketMatchesQuery(t, "ui")).toBe(true);
    expect(ticketMatchesQuery(t, "t3")).toBe(false);
    expect(ticketMatchesQuery(t, "")).toBe(true);
  });

  it("labels を false にするとラベルには当てない", () => {
    expect(ticketMatchesQuery(t, "search-ui", false)).toBe(false);
    expect(ticketMatchesQuery(t, "検索", false)).toBe(true);
  });

  it("core の matchesQuery（ticket list の query）の写しで、同じ結果になる", () => {
    const queries = ["", "  ", "t1", "T12", "t123", "WEB", "検索", "ui", "Search", "なし", " t12 "];
    for (const q of queries)
      for (const labels of [true, false])
        expect([q, labels, ticketMatchesQuery(t, q, labels)]).toEqual([
          q,
          labels,
          matchesQuery(t, q, labels),
        ]);
  });
});
