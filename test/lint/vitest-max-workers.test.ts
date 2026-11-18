// vitest のワーカー数の上限（vitest.workers.ts）が、DEGUBOARD_TEST_MAX_WORKERS の値をどう読むかを確かめる（t800）。
// 既定のワーカー数・受ける値・その理由の正本は vitest.workers.ts の冒頭のコメントで、ここでは言い直さない

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WORKERS,
  RELATED_MAX_WORKERS,
  isRelatedRun,
  resolveMaxWorkers,
} from "../../vitest.workers.js";

const root = path.resolve(import.meta.dirname, "../..");

describe("test:related のワーカー数（t1076）", () => {
  it("環境変数がなければ、全体のテストより少ない上限にする", () => {
    expect(RELATED_MAX_WORKERS).toBe("25%");
    expect(Number.parseInt(RELATED_MAX_WORKERS)).toBeLessThan(Number.parseInt(DEFAULT_MAX_WORKERS));
    expect(resolveMaxWorkers(undefined, true)).toBe("25%");
    expect(resolveMaxWorkers("", true)).toBe("25%");
  });

  it("環境変数を渡せば、test:related でもその値で上書きする", () => {
    expect(resolveMaxWorkers("6", true)).toBe(6);
    expect(resolveMaxWorkers("75%", true)).toBe("75%");
    expect(() => resolveMaxWorkers("0", true)).toThrow(/DEGUBOARD_TEST_MAX_WORKERS must be/);
  });

  it("vitest run の --changed があれば test:related とみなす", () => {
    expect(isRelatedRun(["node", "vitest", "run", "--changed", "origin/main"])).toBe(true);
    expect(isRelatedRun(["node", "vitest", "run", "--changed=origin/main"])).toBe(true);
    expect(isRelatedRun(["node", "vitest", "run", "--changed"])).toBe(true);
    expect(isRelatedRun(["node", "vitest", "run"])).toBe(false);
    expect(isRelatedRun(["node", "vitest", "run", "--changedSince"])).toBe(false);
  });

  it("package.json の test:related は --changed を渡し、lock（test-locked.sh）の外で回る", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["test:related"] ?? "";
    expect(isRelatedRun(script.split(/\s+/))).toBe(true);
    expect(script).not.toContain("test-locked");
  });
});

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
