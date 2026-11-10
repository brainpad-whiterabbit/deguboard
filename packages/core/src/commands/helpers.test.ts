import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { idShapeOf, isOverdue, iterationReadiness, localDate } from "./helpers.js";

describe("idShapeOf（ID の形だけを確かめる）", () => {
  it("未指定なら undefined を返す", () => {
    expect(idShapeOf(undefined, "iteration")).toBeUndefined();
  });

  it("番号だけでも接頭辞付きでも同じ ID に整える", () => {
    expect(idShapeOf("3", "iteration")).toBe("s3");
    expect(idShapeOf("s3", "iteration")).toBe("s3");
  });

  it("別の種類の ID は UsageError で拒む", () => {
    expect(() => idShapeOf("t3", "iteration")).toThrow(UsageError);
    expect(() => idShapeOf("t3", "iteration")).toThrow("t3 is not a iteration ID");
  });
});

describe("localDate（手元の暦日）", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("月日を 0 埋めして YYYY-MM-DD にする", () => {
    expect(localDate(new Date(2024, 0, 5, 9, 0, 0))).toBe("2024-01-05");
    expect(localDate(new Date(2024, 11, 31, 23, 59, 59))).toBe("2024-12-31");
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
    process.env.TZ = "UTC";
    expect(localDate(new Date("2024-06-16T03:00:00Z"))).toBe("2024-06-16");
  });
});

describe("isOverdue（終了日が今日より前か）", () => {
  it("終了日の当日は超過でない", () => {
    expect(isOverdue("2024-06-15", "2024-06-15")).toBe(false);
  });

  it("終了日が前日なら超過", () => {
    expect(isOverdue("2024-06-14", "2024-06-15")).toBe(true);
  });

  it("終了日が先なら超過でない", () => {
    expect(isOverdue("2024-06-16", "2024-06-15")).toBe(false);
  });

  it("終了日がなければ超過でない", () => {
    expect(isOverdue(undefined, "2024-06-15")).toBe(false);
  });

  it("終了日が ISO 日時でも日付の部分だけで比べる", () => {
    expect(isOverdue("2024-06-14T23:59:59Z", "2024-06-15")).toBe(true);
    expect(isOverdue("2024-06-15T00:00:01Z", "2024-06-15")).toBe(false);
  });
});

describe("iterationReadiness（完了と期限切れの判定）", () => {
  const today = "2024-06-15";
  const past = { status: "active", end: "2024-06-14" };

  it("チケットが 0 件なら完了でも期限切れでもない", () => {
    expect(iterationReadiness(past, [], today)).toEqual({
      complete: false,
      overdue: false,
      unfinished: 0,
    });
  });

  it("全件が abandoned なら完了で、未完了は 0（期限切れでない）", () => {
    expect(iterationReadiness(past, ["abandoned", "abandoned"], today)).toEqual({
      complete: true,
      overdue: false,
      unfinished: 0,
    });
  });

  it("planned は終了日を過ぎていても期限切れでない", () => {
    expect(iterationReadiness({ status: "planned", end: "2024-06-14" }, ["todo"], today)).toEqual({
      complete: false,
      overdue: false,
      unfinished: 1,
    });
  });

  it("active で終了日を過ぎて未完了があれば期限切れ", () => {
    expect(iterationReadiness(past, ["done", "in_progress"], today)).toEqual({
      complete: false,
      overdue: true,
      unfinished: 1,
    });
  });

  it("Status が undefined のもの（読めないチケット）は未完了に数える", () => {
    expect(iterationReadiness(past, ["done", undefined], today)).toEqual({
      complete: false,
      overdue: true,
      unfinished: 1,
    });
  });
});
