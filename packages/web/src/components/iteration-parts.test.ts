import { afterEach, describe, expect, it } from "vitest";
import { activeDay, shortPeriod } from "./iteration-parts.js";

describe("active の Iteration が何日目か", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("開始の日を 1 日目に、手元の暦の日付で数え、時刻は見ない", () => {
    process.env.TZ = "Asia/Tokyo";
    // UTC の 11/14 16:00 は東京では 11/15 の 1 時
    const it = { status: "active", started_at: "2026-11-14T16:00:00Z" } as const;
    expect(activeDay(it, new Date("2026-11-15T14:59:00Z"))).toBe(1);
    expect(activeDay(it, new Date("2026-11-15T15:00:00Z"))).toBe(2);
    expect(activeDay(it, new Date("2026-11-28T03:00:00Z"))).toBe(14);
  });

  it("夏時間の切り替えをまたいでも 1 日ずつ数える", () => {
    process.env.TZ = "America/New_York";
    // 2026-11-01 に夏時間が終わる
    const it = { status: "active", started_at: "2026-10-31T16:00:00Z" } as const;
    expect(activeDay(it, new Date("2026-11-02T16:00:00Z"))).toBe(3);
  });

  it("planned・closed、started_at のない・読めない Iteration は出さず、開始が未来なら 1 日目", () => {
    const now = new Date("2026-11-13T03:00:00Z");
    expect(activeDay({ status: "planned" }, now)).toBeUndefined();
    expect(
      activeDay({ status: "closed", started_at: "2026-11-01T03:00:00Z" }, now),
    ).toBeUndefined();
    expect(activeDay({ status: "active" }, now)).toBeUndefined();
    expect(activeDay({ status: "active", started_at: "x" }, now)).toBeUndefined();
    expect(activeDay({ status: "active", started_at: "2026-11-20T03:00:00Z" }, now)).toBe(1);
  });
});

describe("Iteration の見出しの実績の期間", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("closed は started_at〜closed_at を手元の暦の月/日に縮めて – でつなぐ", () => {
    process.env.TZ = "Asia/Tokyo";
    // UTC の 11/14 16:00 は東京では 11/15
    expect(
      shortPeriod(
        {
          status: "closed",
          started_at: "2026-11-14T16:00:00Z",
          closed_at: "2026-11-28T03:00:00Z",
        },
        new Date("2026-12-01T03:00:00Z"),
      ),
    ).toBe("11/15–11/28");
  });

  it("active は開始だけ、planned は期間を出さない", () => {
    const now = new Date("2026-11-13T03:00:00Z");
    expect(shortPeriod({ status: "active", started_at: "2026-11-05T03:00:00Z" }, now)).toBe(
      "11/05–",
    );
    expect(shortPeriod({ status: "planned" })).toBeUndefined();
  });

  it("started_at のない Iteration は開始を「不明」と出す", () => {
    expect(shortPeriod({ status: "active" })).toBe("不明–");
    const now = new Date("2026-12-01T03:00:00Z");
    expect(shortPeriod({ status: "closed", closed_at: "2026-11-28T03:00:00Z" }, now)).toBe(
      "不明–11/28",
    );
  });

  it("月日は履歴の日付と同じ書き方（ゼロ埋め、今年でなければ年を付ける）で、読めない日時はそのまま出す", () => {
    const now = new Date("2026-01-03T03:00:00Z");
    expect(
      shortPeriod(
        { status: "closed", started_at: "2025-12-30T03:00:00Z", closed_at: "2026-01-02T03:00:00Z" },
        now,
      ),
    ).toBe("2025/12/30–01/02");
    expect(shortPeriod({ status: "active", started_at: "x" }, now)).toBe("x–");
  });
});
