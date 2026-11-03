import { describe, expect, it } from "vitest";
import { formatShortTime } from "./ticket.js";

describe("チケット詳細の日時（formatShortTime）", () => {
  const now = new Date("2026-11-03T12:00:00Z");

  it("今年の日時は年を省いて月日と時刻を出す", () => {
    expect(formatShortTime("2026-01-01T09:05:00Z", now)).toBe("01-01 09:05");
  });

  it("去年より前の日時は年も出す", () => {
    expect(formatShortTime("2025-12-31T23:59:00Z", now)).toBe("2025-12-31 23:59");
  });

  it("読めない値はそのまま出す", () => {
    expect(formatShortTime("not-a-date", now)).toBe("not-a-date");
  });
});
