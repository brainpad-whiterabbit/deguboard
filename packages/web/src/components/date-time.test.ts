import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("履歴の日付（formatShortDay）の時差と夏時間", () => {
  // vitest.config.ts は TZ を UTC に固定している。ここだけ切り替え、ほかのテストに漏れないよう必ず戻す
  const original = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Asia/Tokyo";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("Asia/Tokyo（UTC+9）：UTC では前の日でも手元の日付で今日・昨日を数える", () => {
    // 手元 2026-11-05 08:00（UTC では 11-04 23:00）
    const now = new Date("2026-11-04T23:00:00Z");
    expect(formatShortDay("2026-11-04T15:00:00Z", now)).toBe("今日"); // 手元 11-05 00:00
    expect(formatShortDay("2026-11-04T14:59:00Z", now)).toBe("昨日"); // 手元 11-04 23:59（UTC でも 11-04 だが今日ではない）
    expect(formatShortDay("2026-11-03T15:00:00Z", now)).toBe("昨日"); // 手元 11-04 00:00
    expect(formatShortDay("2026-11-03T14:59:00Z", now)).toBe("11/03"); // 手元 11-03 23:59
  });

  it("America/New_York（UTC-5/-4）：UTC では翌日でも手元の日付で数える", () => {
    process.env.TZ = "America/New_York";
    // 手元 2026-11-04 20:00（UTC では 11-05 01:00）
    const now = new Date("2026-11-05T01:00:00Z");
    expect(formatShortDay("2026-11-05T00:30:00Z", now)).toBe("今日"); // 手元 11-04 19:30
    expect(formatShortDay("2026-11-04T04:59:00Z", now)).toBe("昨日"); // 手元 11-03 23:59
    expect(formatShortDay("2026-11-04T05:00:00Z", now)).toBe("今日"); // 手元 11-04 00:00
    expect(formatShortDay("2026-11-03T04:59:00Z", now)).toBe("11/02");
  });

  it("夏時間の始まり（2026-03-08、1 日が 23 時間）の前後で、昨日・今日がずれない", () => {
    process.env.TZ = "America/New_York";
    // 手元 03-08 12:00（EDT）。前日 03-07 0:00（EST）は 23 時間前より少し前
    const now = new Date("2026-03-08T16:00:00Z");
    expect(formatShortDay("2026-03-08T05:00:00Z", now)).toBe("今日"); // 手元 03-08 00:00 EST
    expect(formatShortDay("2026-03-08T04:59:00Z", now)).toBe("昨日"); // 手元 03-07 23:59
    expect(formatShortDay("2026-03-07T05:00:00Z", now)).toBe("昨日"); // 手元 03-07 00:00
    expect(formatShortDay("2026-03-07T04:59:00Z", now)).toBe("03/06");
    // 翌日 03-09 0:00 EDT（UTC 04:00）から見た昨日は 03-08（23 時間しかない日）
    const next = new Date("2026-03-09T04:00:00Z");
    expect(formatShortDay("2026-03-08T05:00:00Z", next)).toBe("昨日");
    expect(formatShortDay("2026-03-07T20:00:00Z", next)).toBe("03/07");
  });

  it("夏時間の終わり（2026-11-01、1 日が 25 時間）の前後で、昨日・今日がずれない", () => {
    process.env.TZ = "America/New_York";
    // 手元 11-01 12:00（EST）。11-01 0:00 は EDT（UTC 04:00）
    const now = new Date("2026-11-01T17:00:00Z");
    expect(formatShortDay("2026-11-01T04:00:00Z", now)).toBe("今日");
    expect(formatShortDay("2026-11-01T03:59:00Z", now)).toBe("昨日"); // 手元 10-31 23:59
    expect(formatShortDay("2026-10-31T04:00:00Z", now)).toBe("昨日");
    expect(formatShortDay("2026-10-31T03:59:00Z", now)).toBe("10/30");
    // 翌日 11-02 0:00 EST（UTC 05:00）から見た昨日は 11-01（25 時間ある日）。一番遅い時刻も昨日
    const next = new Date("2026-11-02T05:00:00Z");
    expect(formatShortDay("2026-11-01T04:00:00Z", next)).toBe("昨日");
    expect(formatShortDay("2026-11-02T04:59:00Z", next)).toBe("昨日"); // 手元 11-01 23:59 EST
    expect(formatShortDay("2026-10-31T20:00:00Z", next)).toBe("10/31");
  });
});
