import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "../model/run.js";
import {
  findingText,
  splitFindings,
  UNFIXED_LIGHT_BEGIN,
  UNFIXED_LIGHT_END,
  withUnfixedLight,
} from "./findings.js";

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  severity: "light",
  category: "言い回し",
  file: null,
  line: null,
  reason: "理由",
  fix: null,
  ...over,
});

describe("見直しの指摘から手直しに渡すものを選ぶ（t600）", () => {
  it("重い指摘と受け入れ条件の文言の軽い指摘を直す側に、残りの軽い指摘を直さない側に分ける", () => {
    const heavy = finding({ severity: "heavy", category: "不具合" });
    const heavyByCategory = finding({ category: "規約の違反" });
    const acceptance = finding({ category: "受け入れ条件の漏れ" });
    const other = finding({ category: "参考節との食い違い" });
    const { fix, unfixedLight } = splitFindings(
      [heavy, heavyByCategory, acceptance, other],
      ["規約の違反"],
    );
    expect(fix).toEqual([heavy, heavyByCategory, acceptance]);
    expect(unfixedLight).toEqual([other]);
  });

  it("指摘の 1 件は場所・種類・理由・直し方を 1 行にする", () => {
    expect(
      findingText(
        finding({
          severity: "heavy",
          category: "不具合",
          file: "a.ts",
          line: 3,
          reason: "x\ny",
          fix: "z",
        }),
        "ja",
      ),
    ).toBe("[重い] a.ts:3 (不具合)：x y。直し方：z");
    expect(findingText(finding({ category: "好み", reason: "r" }), "en")).toBe("[light] 好み: r");
  });
});

describe("PR の本文に書き足す節（t600）", () => {
  it("もとの本文を残して節を書き足し、もう一度書くと節を入れ替える（二重にしない）", () => {
    const body = "## 概要\n\n元の本文\n";
    const once = withUnfixedLight(body, ["[軽い] a.ts：一"]);
    expect(once.startsWith("## 概要\n\n元の本文\n\n")).toBe(true);
    expect(once).toContain(
      `${UNFIXED_LIGHT_BEGIN}\n## 直さなかった軽い指摘\n\n- [軽い] a.ts：一\n${UNFIXED_LIGHT_END}`,
    );
    const twice = withUnfixedLight(once, ["[軽い] b.ts：二"]);
    expect(twice.split(UNFIXED_LIGHT_BEGIN)).toHaveLength(2);
    expect(twice).toContain("- [軽い] b.ts：二");
    expect(twice).not.toContain("a.ts");
    expect(twice.startsWith("## 概要\n\n元の本文\n\n")).toBe(true);
  });

  it("指摘がなければ本文を変えず、前の回の節だけを外す", () => {
    const body = "## 概要\n\n元の本文\n";
    expect(withUnfixedLight(body, [])).toBe(body);
    const noted = withUnfixedLight(body, ["[軽い] a.ts：一"]);
    expect(withUnfixedLight(noted, [])).toBe("## 概要\n\n元の本文\n");
  });
});
