import { describe, expect, it } from "vitest";
import { compareIds, formatId, idFromFileName, idNumber, nextNumber, parseId } from "./id.js";

describe("ID", () => {
  it("t12 でも 12 でも同じチケットを指す", () => {
    expect(parseId("t12", "ticket")).toBe("t12");
    expect(parseId("12", "ticket")).toBe("t12");
    expect(parseId(" 12 ", "ticket")).toBe("t12");
  });

  it("ゼロ埋めと他の接頭辞は受け付けない", () => {
    expect(parseId("t012", "ticket")).toBeUndefined();
    expect(parseId("e12", "ticket")).toBeUndefined();
    expect(parseId("0", "ticket")).toBeUndefined();
    expect(parseId("t", "ticket")).toBeUndefined();
  });

  it("番号順に並べる（辞書順では t100 が t2 より前になる）", () => {
    expect(["t100", "t2", "t12"].sort(compareIds)).toEqual(["t2", "t12", "t100"]);
    expect(idNumber("t100")).toBe(100);
  });

  it("採番は最大 + 1 で、空なら 1", () => {
    expect(nextNumber([])).toBe(1);
    expect(nextNumber([3, 9, 2])).toBe(10);
    expect(formatId("ticket", 10)).toBe("t10");
    expect(() => formatId("ticket", 0)).toThrow(RangeError);
  });

  it("ファイル名から ID を取り出す", () => {
    expect(idFromFileName("t12.md", "ticket")).toBe("t12");
    expect(idFromFileName("s3.yaml", "iteration")).toBe("s3");
    expect(idFromFileName("README.md", "ticket")).toBeUndefined();
  });
});
