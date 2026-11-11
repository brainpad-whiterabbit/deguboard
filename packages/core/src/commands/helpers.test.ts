import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { idShapeOf, iterationComplete } from "./helpers.js";

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

describe("iterationComplete（Iteration と Plan の完了の判定）", () => {
  it("チケットが 0 件なら完了でない", () => {
    expect(iterationComplete([])).toBe(false);
  });

  it("全件が done か abandoned なら完了", () => {
    expect(iterationComplete(["abandoned", "abandoned"])).toBe(true);
    expect(iterationComplete(["done", "abandoned"])).toBe(true);
  });

  it("未完了が 1 件でもあれば完了でない", () => {
    expect(iterationComplete(["done", "in_progress"])).toBe(false);
  });

  it("Status が undefined のもの（読めないチケット）は未完了に数える", () => {
    expect(iterationComplete(["done", undefined])).toBe(false);
  });
});
