import { describe, expect, it } from "vitest";
import {
  acceptanceSection,
  parseAcceptance,
  replaceAcceptance,
  setAcceptance,
  ticketBodyTemplate,
} from "./ticket.js";

describe("チケットの本文", () => {
  it("雛形は概要と受け入れ条件の節を持ち、項目がなければ空の - [ ] を 1 行置く", () => {
    expect(ticketBodyTemplate("入力の検査")).toBe(
      "## 概要\n\n入力の検査\n\n## 受け入れ条件\n\n- [ ] \n",
    );
    expect(ticketBodyTemplate()).toBe("## 概要\n\n\n\n## 受け入れ条件\n\n- [ ] \n");
  });

  it("受け入れ条件の項目を 1 行ずつチェックリストにし、前後の空白を落とす", () => {
    expect(ticketBodyTemplate("s", [" a, b ", "c"])).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] a, b\n- [ ] c\n",
    );
  });

  it("受け入れ条件の節を、見出しの次から次の見出しの手前まで切り出す", () => {
    expect(acceptanceSection("## 概要\n\n- [ ] x\n")).toBeUndefined();
    expect(acceptanceSection("## 受け入れ条件")).toBe("");
    // 概要にチェックリストがあっても、受け入れ条件の節は空のまま
    expect(acceptanceSection("## 概要\n\n- [ ] x\n\n## 受け入れ条件\n\n- [ ] \n")).toBe(
      "\n\n- [ ] \n",
    );
    expect(acceptanceSection("## 受け入れ条件\n\n- [ ] a\n\n## 備考\n\n- [ ] b\n")).toBe(
      "\n\n- [ ] a\n\n",
    );
  });

  it("受け入れ条件の節だけを置き換え、同じ文の済みの印は保ち、他の節は変えない", () => {
    const body = "## 概要\n\ns\n\n## 受け入れ条件\n\n- [x] 済み\n- [ ] 消える\n\n## 備考\n\nメモ\n";
    expect(replaceAcceptance(body, ["新しい", " 済み "])).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] 新しい\n- [x] 済み\n\n## 備考\n\nメモ\n",
    );
    // 節が末尾のとき
    expect(replaceAcceptance(ticketBodyTemplate("s"), ["a"])).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] a\n",
    );
  });

  it("受け入れ条件の節がなければ末尾に足す", () => {
    expect(replaceAcceptance("## 概要\n\ns\n", ["a"])).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] a\n",
    );
    expect(replaceAcceptance("本文だけ", ["a"])).toBe("本文だけ\n\n## 受け入れ条件\n\n- [ ] a\n");
    expect(replaceAcceptance("", ["a"])).toBe("## 受け入れ条件\n\n- [ ] a\n");
  });

  const checklist =
    "## 概要\n\n- [ ] 概要の項目\n\n## 受け入れ条件\n\n- [ ] \n- [x] a\n- [X] b  \n- [ ] c\n\n## 備考\n\n- [ ] d\n";

  it("受け入れ条件の項目を 1 始まりの番号・文・印で読み、空の項目行と他の節は数えず、節がなければ undefined", () => {
    expect(parseAcceptance(checklist)).toEqual([
      { index: 1, text: "a", checked: true },
      { index: 2, text: "b", checked: true },
      { index: 3, text: "c", checked: false },
    ]);
    expect(parseAcceptance("## 概要\n\n- [ ] x\n")).toBeUndefined();
    // 雛形のまま（空の項目行だけ）は節はあるが項目がない
    expect(parseAcceptance(ticketBodyTemplate("s"))).toEqual([]);
  });

  it("番号の項目の印だけを書き換え、他の行・空の項目行・他の節は変えない", () => {
    expect(setAcceptance(checklist, [3, 1], true)).toBe(
      "## 概要\n\n- [ ] 概要の項目\n\n## 受け入れ条件\n\n- [ ] \n- [x] a\n- [X] b  \n- [x] c\n\n## 備考\n\n- [ ] d\n",
    );
    expect(setAcceptance(checklist, [2], false)).toBe(
      "## 概要\n\n- [ ] 概要の項目\n\n## 受け入れ条件\n\n- [ ] \n- [x] a\n- [ ] b  \n- [ ] c\n\n## 備考\n\n- [ ] d\n",
    );
    // 範囲外の番号と節のない本文は変えない
    expect(setAcceptance(checklist, [99], true)).toBe(checklist);
    expect(setAcceptance("本文だけ", [1], true)).toBe("本文だけ");
  });
});
