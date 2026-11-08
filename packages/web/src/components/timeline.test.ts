import { afterEach, describe, expect, it } from "vitest";
import { formatClock, formatDay, formatTime, groupByDay } from "./timeline.js";

describe("formatTime", () => {
  // テストの時差は vitest.config.ts で UTC に固定しているので、手元の時差で整形することはここだけ時差を変えて確かめる
  const saved = process.env.TZ;
  afterEach(() => {
    process.env.TZ = saved;
  });

  it("UTC の日時を手元の時差（Asia/Tokyo）で年月日と時分にする", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(formatTime("2026-01-01T00:00:00Z")).toBe("2026-01-01 09:00");
  });
});

describe("経過の日付の区切り", () => {
  const saved = process.env.TZ;
  afterEach(() => {
    process.env.TZ = saved;
  });

  it("日付と時刻を分けて手元の時差で出す", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(formatDay("2026-11-01T15:30:00Z")).toBe("2026-11-02");
    expect(formatClock("2026-11-01T15:30:00Z")).toBe("00:30");
  });

  it("読めない時刻はそのまま出す", () => {
    expect(formatDay("不明")).toBe("不明");
    expect(formatClock("不明")).toBe("不明");
  });

  it("日付が変わるところで区切り、同じ日付の出来事は順を変えずに 1 つにまとめる", () => {
    const events = [
      { at: "2026-11-01T00:00:00Z", n: 1 },
      { at: "2026-11-01T23:59:00Z", n: 2 },
      { at: "2026-11-02T00:00:00Z", n: 3 },
      { at: "2026-11-04T08:00:00Z", n: 4 },
    ];
    expect(groupByDay(events).map((g) => [g.day, g.events.map((e) => e.n)])).toEqual([
      ["2026-11-01", [1, 2]],
      ["2026-11-02", [3]],
      ["2026-11-04", [4]],
    ]);
    // 出来事がなければ区切りもない
    expect(groupByDay([])).toEqual([]);
  });

  it("手元の時差で日付が変われば、UTC で同じ日でも区切る", () => {
    process.env.TZ = "Asia/Tokyo";
    const events = [{ at: "2026-11-01T14:00:00Z" }, { at: "2026-11-01T16:00:00Z" }];
    expect(groupByDay(events).map((g) => g.day)).toEqual(["2026-11-01", "2026-11-02"]);
  });
});
