import { describe, expect, it } from "vitest";
import { formatShortDay, formatShortTime } from "./date-time.js";

describe("日時（formatShortTime）", () => {
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

describe("履歴の日付（formatShortDay）", () => {
  // 手元の日付で数える。テストの時差は UTC に固定されている
  const now = new Date("2026-11-04T12:00:00Z");

  it("同じ日は今日、前の日は昨日", () => {
    expect(formatShortDay("2026-11-04T00:00:00Z", now)).toBe("今日");
    expect(formatShortDay("2026-11-04T11:59:00Z", now)).toBe("今日");
    expect(formatShortDay("2026-11-03T23:59:00Z", now)).toBe("昨日");
    expect(formatShortDay("2026-11-03T00:00:00Z", now)).toBe("昨日");
  });

  it("一昨日からその年の初めまでは月/日", () => {
    expect(formatShortDay("2026-11-02T23:59:00Z", now)).toBe("11/02");
    expect(formatShortDay("2026-01-01T00:00:00Z", now)).toBe("01/01");
  });

  it("去年より前は年/月/日", () => {
    expect(formatShortDay("2025-12-31T23:59:00Z", now)).toBe("2025/12/31");
    expect(formatShortDay("2024-02-29T00:00:00Z", now)).toBe("2024/02/29");
  });

  it("年の初めは昨日が去年になる", () => {
    const jan1 = new Date("2026-01-01T09:00:00Z");
    expect(formatShortDay("2025-12-31T12:00:00Z", jan1)).toBe("昨日");
    expect(formatShortDay("2025-12-30T12:00:00Z", jan1)).toBe("2025/12/30");
  });

  it("読めない値はそのまま出す", () => {
    expect(formatShortDay("not-a-date", now)).toBe("not-a-date");
  });
});
