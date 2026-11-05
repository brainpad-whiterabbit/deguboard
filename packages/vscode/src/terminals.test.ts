import { describe, expect, it } from "vitest";
import { describeTerminals, terminalPayload } from "./terminals.js";

describe("describeTerminals", () => {
  it("開いているターミナルを id と表示名にし、同じ名前は 2 つ目から番号を足して見分ける", () => {
    expect(
      describeTerminals([
        { id: 1, name: "zsh" },
        { id: 2, name: "claude" },
        { id: 5, name: "zsh" },
        { id: 6, name: "zsh" },
      ]),
    ).toEqual([
      { id: 1, label: "zsh" },
      { id: 2, label: "claude" },
      { id: 5, label: "zsh (2)" },
      { id: 6, label: "zsh (3)" },
    ]);
  });

  it("名前が空のターミナルは「ターミナル」と出し、ターミナルがなければ空", () => {
    expect(describeTerminals([{ id: 1, name: "  " }])).toEqual([{ id: 1, label: "ターミナル" }]);
    expect(describeTerminals([])).toEqual([]);
  });
});

describe("terminalPayload", () => {
  it("1 行はそのまま送り、末尾に改行を足さない（Enter を押さない）", () => {
    expect(terminalPayload("/dgwork t380")).toBe("/dgwork t380");
  });

  it("複数行は bracketed paste で包み、中の改行を Enter（実行）にしない。改行は \\n にそろえる", () => {
    expect(terminalPayload("/dgplan t1\r\n指示 1\n指示 2")).toBe(
      "\u001b[200~/dgplan t1\n指示 1\n指示 2\u001b[201~",
    );
  });

  it("制御文字を取り除き、貼り付けの終わりを偽って後ろを入力として実行させない", () => {
    expect(terminalPayload("a\u001b[201~rm -rf ~\nb")).toBe(
      "\u001b[200~a[201~rm -rf ~\nb\u001b[201~",
    );
    expect(terminalPayload("a\u0003b\u0007")).toBe("ab");
  });

  it("タブは残す", () => {
    expect(terminalPayload("a\tb")).toBe("a\tb");
  });
});
