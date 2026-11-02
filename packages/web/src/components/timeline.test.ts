import { afterEach, describe, expect, it } from "vitest";
import { formatTime } from "./timeline.js";

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
