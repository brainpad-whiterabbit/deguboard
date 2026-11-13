// vitest のワーカー数の上限（vitest.workers.ts）が、DEGUBOARD_TEST_MAX_WORKERS の値をどう読むかを確かめる（t800）。
// 既定は CPU 数の半分で、数と百分率だけを受ける。vitest に渡す前に、受けない値と 0 を受ける形を示すエラーで止める

import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_WORKERS, resolveMaxWorkers } from "../../vitest.workers.js";

describe("resolveMaxWorkers", () => {
  it("環境変数がないときと空のときは CPU 数の半分を既定にする", () => {
    expect(DEFAULT_MAX_WORKERS).toBe("50%");
    expect(resolveMaxWorkers(undefined)).toBe("50%");
    expect(resolveMaxWorkers("")).toBe("50%");
    expect(resolveMaxWorkers("  ")).toBe("50%");
  });

  it("数を設定したときはその数を上限にする", () => {
    expect(resolveMaxWorkers("2")).toBe(2);
    expect(resolveMaxWorkers("16")).toBe(16);
    expect(resolveMaxWorkers(" 4 ")).toBe(4);
  });

  it("百分率を設定したときはそのまま vitest に渡す", () => {
    expect(resolveMaxWorkers("75%")).toBe("75%");
    expect(resolveMaxWorkers("1%")).toBe("1%");
    expect(resolveMaxWorkers("100%")).toBe("100%");
  });

  it.each(["0", "0%", "00", "abc", "-1", "1.5", "4 workers", "75 %", "%", "101%", "half"])(
    "数でも百分率でもない値と 0（%s）は、受ける形を示すエラーで止める",
    (raw) => {
      expect(() => resolveMaxWorkers(raw)).toThrow(
        /DEGUBOARD_TEST_MAX_WORKERS must be a positive integer \(e\.g\. "4"\) or a percentage from 1% to 100% \(e\.g\. "75%"\)/,
      );
      expect(() => resolveMaxWorkers(raw)).toThrow(JSON.stringify(raw));
    },
  );
});
