import { describe, expect, it } from "vitest";
import { matchesQuery } from "./filters.js";

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
