import { readFileSync } from "node:fs";
import { bundleTranslator, setTranslator } from "./l10n.js";
import { describe, expect, it } from "vitest";
import { describeTerminals, terminalInput } from "./terminals.js";

// 文言は日本語の訳で確かめる（表示言語が日本語のときに今までと同じ文言が出ること）。英語は l10n.test.ts で確かめる
setTranslator(
  bundleTranslator(
    JSON.parse(
      readFileSync(new URL("../l10n/bundle.l10n.ja.json", import.meta.url), "utf8"),
    ) as Record<string, string>,
  ),
);

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

  it("アクティブなターミナルには active を付ける", () => {
    expect(
      describeTerminals([
        { id: 1, name: "a" },
        { id: 2, name: "b", active: true },
      ]),
    ).toEqual([
      { id: 1, label: "a" },
      { id: 2, label: "b", active: true },
    ]);
  });

  it("名前が空のターミナルは「ターミナル」と出し、ターミナルがなければ空", () => {
    expect(describeTerminals([{ id: 1, name: "  " }])).toEqual([{ id: 1, label: "ターミナル" }]);
    expect(describeTerminals([])).toEqual([]);
  });
});

describe("terminalInput", () => {
  it("1 行は sendText で送る文字列にし、末尾に改行を足さない（Enter を押さない）", () => {
    expect(terminalInput("/dgwork t380")).toEqual({ kind: "line", text: "/dgwork t380" });
  });

  it("複数行は貼り付けに任せ、ESC[200~ で自前では包まない。改行は \\n にそろえる", () => {
    expect(terminalInput("/dgplan t1\r\n指示 1\n指示 2")).toEqual({
      kind: "paste",
      text: "/dgplan t1\n指示 1\n指示 2",
    });
  });

  it("制御文字を取り除き、貼り付けの終わりを偽って後ろを入力として実行させない", () => {
    expect(terminalInput("a\u001b[201~rm -rf ~\nb")).toEqual({
      kind: "paste",
      text: "a[201~rm -rf ~\nb",
    });
    expect(terminalInput("a\u0003b\u0007")).toEqual({ kind: "line", text: "ab" });
  });

  it("1 行のタブは空白にする", () => {
    expect(terminalInput("a\tb")).toEqual({ kind: "line", text: "a b" });
  });
});
