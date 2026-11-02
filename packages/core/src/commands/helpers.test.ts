import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { idShapeOf } from "./helpers.js";

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
    expect(() => idShapeOf("t3", "iteration")).toThrow("t3 は iteration の ID ではない");
  });
});
