import { afterEach, describe, expect, it } from "vitest";
import { shortPeriod } from "./iteration-parts.js";

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
      shortPeriod({
        status: "closed",
        started_at: "2026-11-14T16:00:00Z",
        closed_at: "2026-11-28T03:00:00Z",
      }),
    ).toBe("11/15–11/28");
  });

  it("active は開始だけ、planned は期間を出さない", () => {
    expect(shortPeriod({ status: "active", started_at: "2026-11-05T03:00:00Z" })).toBe("11/5–");
    expect(shortPeriod({ status: "planned" })).toBeUndefined();
  });

  it("started_at のない Iteration は開始を「不明」と出す", () => {
    expect(shortPeriod({ status: "active" })).toBe("不明–");
    expect(shortPeriod({ status: "closed", closed_at: "2026-11-28T03:00:00Z" })).toBe("不明–11/28");
  });
});
