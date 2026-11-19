import { describe, expect, it } from "vitest";
import { COPY_FORMATS, copiedMessage, copySample, copyText, inShownOrder } from "./copy-ids.js";

const items = [
  { id: "t12", title: "画面の行" },
  { id: "t3", title: "API" },
  { id: "t40", title: "文書" },
];

describe("選んだ行のコピーの文字（UI-15）", () => {
  it("ID の形は半角の空白で区切り、末尾に区切りを付けない", () => {
    expect(copyText("ids", items)).toBe("t12 t3 t40");
    expect(copyText("ids", [items[0]!])).toBe("t12");
  });

  it("ID とタイトルの形は 1 行に 1 件", () => {
    expect(copyText("titled", items)).toBe("t12 画面の行\nt3 API\nt40 文書");
  });

  it("Markdown のリストの形は「- ID タイトル」を 1 行に 1 件", () => {
    expect(copyText("markdown", items)).toBe("- t12 画面の行\n- t3 API\n- t40 文書");
  });

  it("タイトルが分からない件は ID だけを出す", () => {
    const loose = [{ id: "t9" }, { id: "t10", title: "" }];
    expect(copyText("titled", loose)).toBe("t9\nt10");
    expect(copyText("markdown", loose)).toBe("- t9\n- t10");
  });

  it("見本は先頭の 1 件の行で、選んだものがなければ空", () => {
    expect(copySample("ids", items)).toBe("t12");
    expect(copySample("titled", items)).toBe("t12 画面の行");
    expect(copySample("markdown", items)).toBe("- t12 画面の行");
    expect(copySample("ids", [])).toBe("");
  });

  it("メニューは ID・ID とタイトル・Markdown のリストの順で、形ごとにコピーした後の文言がある", () => {
    expect(COPY_FORMATS.map((f) => f.format)).toEqual(["ids", "titled", "markdown"]);
    expect(new Set(COPY_FORMATS.map((f) => copiedMessage(f.format))).size).toBe(3);
  });
});

describe("コピーの並び（見えている順）", () => {
  it("選んだ順によらず、見えている行の並びに揃える", () => {
    expect(inShownOrder(["t5", "t2", "t4"], ["t2", "t3", "t4", "t5"])).toEqual(["t2", "t4", "t5"]);
  });

  it("見えていない ID は元の順のまま後ろに置き、重なりは 1 つにする", () => {
    expect(inShownOrder(["t9", "t4", "t8", "t2", "t4"], ["t2", "t4"])).toEqual([
      "t2",
      "t4",
      "t9",
      "t8",
    ]);
  });
});
