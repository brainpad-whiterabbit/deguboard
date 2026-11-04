import { afterEach, describe, expect, it } from "vitest";
import { localDate, periodNote, shortPeriod } from "./iteration-parts.js";

describe("Iteration の見出しの期間", () => {
  it("期間は月/日に縮めて – でつなぎ、片方だけなら ? を置く", () => {
    expect(shortPeriod("2026-11-15", "2026-11-28")).toBe("11/15–11/28");
    expect(shortPeriod("2026-11-05", undefined)).toBe("11/5–?");
    expect(shortPeriod(undefined, undefined)).toBeUndefined();
  });
});

describe("Iteration の残り・超過の日数", () => {
  const active = (end?: string) =>
    end ? { status: "active" as const, end } : { status: "active" as const };

  it("active なら終了日までの残り日数を数え、当日は「今日まで」", () => {
    expect(periodNote(active("2026-11-30"), "2026-11-17")?.text).toBe("残り 13 日");
    expect(periodNote(active("2026-11-30"), "2026-11-29")?.text).toBe("残り 1 日");
    expect(periodNote(active("2026-11-30"), "2026-11-30")?.text).toBe("今日まで");
  });

  it("終了日を過ぎていれば超過日数を数える。月をまたいでも暦日で数える", () => {
    expect(periodNote(active("2026-11-30"), "2026-12-01")?.text).toBe("1 日超過");
    expect(periodNote(active("2026-10-31"), "2026-11-04")?.text).toBe("4 日超過");
  });

  it("active でない・終了日がないときは添えない", () => {
    expect(periodNote({ status: "planned", end: "2026-11-30" }, "2026-11-17")).toBeUndefined();
    expect(periodNote({ status: "closed", end: "2026-11-30" }, "2026-12-05")).toBeUndefined();
    expect(periodNote(active(undefined), "2026-11-17")).toBeUndefined();
  });

  describe("今日の暦日", () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it("月日を 0 埋めして YYYY-MM-DD にする", () => {
      expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    });

    it("手元の暦と UTC の日付が食い違う時刻では、手元の暦の日付を返す", () => {
      // UTC では 6/15 15:30 だが、東京（+9）では 6/16 0:30、ホノルル（-10）では 6/15 5:30
      const instant = new Date("2024-06-15T15:30:00Z");
      process.env.TZ = "Asia/Tokyo";
      expect(localDate(instant)).toBe("2024-06-16");
      process.env.TZ = "Pacific/Honolulu";
      expect(localDate(instant)).toBe("2024-06-15");
      // UTC の 6/16 3:00 は、ホノルルでは 6/15 17:00
      expect(localDate(new Date("2024-06-16T03:00:00Z"))).toBe("2024-06-15");
    });
  });
});
