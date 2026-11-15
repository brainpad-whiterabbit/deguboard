import { describe, expect, it } from "vitest";
import {
  compareIds,
  findIdsInText,
  formatId,
  idFromFileName,
  idKindOf,
  idNumber,
  nextNumber,
  parseId,
} from "./id.js";

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

  it("頭の文字から種類を決め、知らない頭や番号だけは undefined", () => {
    expect(["t12", "s3", "e2", " p7"].map(idKindOf)).toEqual([
      "ticket",
      "iteration",
      "epic",
      "plan",
    ]);
    expect(idKindOf("12")).toBeUndefined();
    expect(idKindOf("x1")).toBeUndefined();
    expect(idKindOf("")).toBeUndefined();
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

const ids = (text: string) => findIdsInText(text).map((f) => f.id);

describe("文章の中の ID（findIdsInText）", () => {
  it("t12・s3・e2・p7 の 4 種類を拾い、位置を返す", () => {
    expect(ids("t12 s3 e2 p7")).toEqual(["t12", "s3", "e2", "p7"]);
    const [f] = findIdsInText("fix (t12)");
    expect(f).toEqual({ id: "t12", start: 5, end: 8 });
  });
  it("文末の句読点・括弧・引用符・# や @ の後ろの ID は拾う", () => {
    expect(ids("t12. t13, (t14) 'e2' #t5 @s3 「p7」")).toEqual([
      "t12",
      "t13",
      "t14",
      "e2",
      "t5",
      "s3",
      "p7",
    ]);
  });
  it("全角の括弧・バッククォート・日本語に隣り合う ID は拾う", () => {
    expect(ids("（t374）")).toEqual(["t374"]);
    expect(ids("t12を直す")).toEqual(["t12"]);
    expect(ids("これはt12です")).toEqual(["t12"]);
    expect(ids("`t12`")).toEqual(["t12"]);
  });
  it("既知の誤検出：変数名・s3://・?id= の形は、形が合えば拾う（存在しなければ索引で外れる）", () => {
    expect(ids("const e1 = t1; s3://bucket ?id=t12")).toEqual(["e1", "t1", "s3", "t12"]);
  });
  it("abc12 のような語の中の部分一致は拾わない", () => {
    expect(ids("abc12 test12 Set3 pt12 t12abc 12t3")).toEqual([]);
  });
  it("URL・パス・ブランチ名・ファイル名の一部は拾わない", () => {
    expect(ids("https://example.com/t12")).toEqual([]);
    expect(ids("feat/t12-foo")).toEqual([]);
    expect(ids("t12.md t12-foo t12/x")).toEqual([]);
    expect(ids("a.t12 v1-s3")).toEqual([]);
  });
  it("ゼロ始まりや番号のない形は拾わない", () => {
    expect(ids("t0 t012 t s e")).toEqual([]);
  });
  it("同じ ID が複数あればすべて拾う", () => {
    expect(findIdsInText("t1 and t1").map((f) => f.start)).toEqual([0, 7]);
  });
});
