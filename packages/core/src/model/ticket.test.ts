import { describe, expect, it } from "vitest";
import { acceptanceSection, ticketBodyTemplate } from "./ticket.js";

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
});
