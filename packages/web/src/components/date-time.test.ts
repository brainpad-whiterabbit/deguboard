import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  calendarDayDiff,
  formatMonthDay,
  formatPeriod,
  formatShortDay,
  formatShortTime,
} from "./date-time.js";

describe("月日（formatMonthDay）と暦の日数の差（calendarDayDiff）", () => {
  // テストの時差は UTC に固定されている
  const now = new Date("2026-11-13T12:00:00Z");

  it("月日はゼロ埋めし、今年でなければ年を付ける", () => {
    expect(formatMonthDay(new Date("2026-01-05T00:00:00Z"), now)).toBe("01/05");
    expect(formatMonthDay(new Date("2026-11-13T23:59:00Z"), now)).toBe("11/13");
    expect(formatMonthDay(new Date("2025-12-31T00:00:00Z"), now)).toBe("2025/12/31");
  });

  it("日数の差は手元の暦の日付で数え、時刻は見ない（同じ日は 0、前なら負）", () => {
    const at = (iso: string) => new Date(iso);
    expect(calendarDayDiff(at("2026-11-13T00:00:00Z"), at("2026-11-13T23:59:00Z"))).toBe(0);
    expect(calendarDayDiff(at("2026-11-12T23:59:00Z"), at("2026-11-13T00:00:00Z"))).toBe(1);
    expect(calendarDayDiff(at("2025-12-31T12:00:00Z"), at("2026-01-02T12:00:00Z"))).toBe(2);
    expect(calendarDayDiff(at("2026-11-13T12:00:00Z"), at("2026-11-10T12:00:00Z"))).toBe(-3);
  });

  it("夏時間の切り替え（1 日が 23・25 時間）をまたいでも 1 日ずつ数える", () => {
    const original = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 2026-03-08 に夏時間が始まり、2026-11-01 に終わる。どちらも手元の正午どうし
      expect(
        calendarDayDiff(new Date("2026-03-07T17:00:00Z"), new Date("2026-03-09T16:00:00Z")),
      ).toBe(2);
      expect(
        calendarDayDiff(new Date("2026-10-31T16:00:00Z"), new Date("2026-11-02T17:00:00Z")),
      ).toBe(2);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

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

describe("閉じた Iteration の期間（formatPeriod）", () => {
  // テストの時差は UTC に固定されている
  const now = new Date("2026-11-13T15:00:00Z");

  it("同じ日に閉じたら、日付・開始と閉じた時刻・時間で出す", () => {
    expect(formatPeriod("2026-11-13T09:28:00Z", "2026-11-13T13:24:00Z", now)).toBe(
      "11/13 09:28–13:24 · 4 時間",
    );
  });

  it("1 時間に満たなければ分で出す", () => {
    expect(formatPeriod("2026-11-13T09:28:00Z", "2026-11-13T10:10:00Z", now)).toBe(
      "11/13 09:28–10:10 · 42 分",
    );
  });

  it("次の日に閉じたら、両方の日付と時刻で出す", () => {
    expect(formatPeriod("2026-11-12T22:10:00Z", "2026-11-13T08:00:00Z", now)).toBe(
      "11/12 22:10–11/13 08:00 · 10 時間",
    );
  });

  it("2 日以上あとに閉じたら、日付と日数（開始の日を 1 日目に数える）で出す", () => {
    expect(formatPeriod("2026-11-10T23:00:00Z", "2026-11-13T01:00:00Z", now)).toBe(
      "11/10–11/13 · 4 日",
    );
  });

  it("開始の記録がなければ、今と同じく開始を不明と出す", () => {
    expect(formatPeriod(undefined, "2026-11-13T13:24:00Z", now)).toBe(
      "開始は不明 ・ 11/13 13:24 に閉じた",
    );
    expect(formatPeriod(null, null, now)).toBe("開始は不明 ・ 閉じた日は不明");
    expect(formatPeriod("2026-11-13T09:28:00Z", undefined, now)).toBe(
      "11/13 09:28 〜 閉じた日は不明",
    );
  });

  it("今年でない日付には年を付ける", () => {
    expect(formatPeriod("2025-12-31T22:00:00Z", "2026-01-01T02:00:00Z", now)).toBe(
      "2025/12/31 22:00–01/01 02:00 · 4 時間",
    );
  });

  it("読めない値はそのまま出す", () => {
    expect(formatPeriod("not-a-date", "2026-11-13T13:24:00Z", now)).toBe("not-a-date–11/13 13:24");
  });

  it("手元の時差で日付と時刻を数える（UTC では同じ日でも Asia/Tokyo では日をまたぐ）", () => {
    const original = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      // 手元 11/13 08:00–11/14 02:00（UTC では 11/12 23:00–11/13 17:00）
      expect(formatPeriod("2026-11-12T23:00:00Z", "2026-11-13T17:00:00Z", now)).toBe(
        "11/13 08:00–11/14 02:00 · 18 時間",
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
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
