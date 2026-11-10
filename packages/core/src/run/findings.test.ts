import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "../model/run.js";
import {
  findingText,
  latestRoundSince,
  matchFindings,
  splitFindings,
  UNFIXED_LIGHT_BEGIN,
  UNFIXED_LIGHT_END,
  unfixedLightLines,
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

describe("見直しの回から最新の回と直さなかった軽い指摘を読む（t600）", () => {
  const round = (at: string, findings: ReviewFinding[] | null) => ({ at, findings });

  it("作業ブランチ（since 以降）の最新の回を返し、一覧なしの回が最新なら前の回を使わない", () => {
    const a = round("2026-11-09T01:00:00Z", [finding({ reason: "前の作業" })]);
    const b = round("2026-11-09T03:00:00Z", [finding({ reason: "今回" })]);
    expect(latestRoundSince([a, b], "2026-11-09T02:00:00Z")).toBe(b);
    // since より前の回しかなければ最新はない
    expect(latestRoundSince([a], "2026-11-09T02:00:00Z")).toBeUndefined();
    // 数だけの回が最新なら、その前の一覧は使わない
    expect(latestRoundSince([a, round("2026-11-09T04:00:00Z", null)], undefined)).toBeUndefined();
  });

  it("直さなかった軽い指摘を回の順に集め、同じ文は 1 つにし、作業ブランチより前の回と一覧なしの回は読まない", () => {
    const acceptance = finding({ category: "受け入れ条件の漏れ", reason: "1 つめ" });
    const neighbor = finding({
      category: "参考節との食い違い",
      file: "src/b.ts",
      reason: "広がり",
    });
    const wording = finding({ category: "言い回し", reason: "2 回目だけ" });
    const old = finding({ category: "言い回し", reason: "前の作業" });
    const rounds = [
      round("2026-11-09T01:00:00Z", [old]),
      round("2026-11-09T02:00:00Z", [acceptance, neighbor]),
      round("2026-11-09T03:00:00Z", [neighbor, wording, finding({ severity: "heavy" })]),
      round("2026-11-09T04:00:00Z", null),
    ];
    expect(unfixedLightLines(rounds, "2026-11-09T01:30:00Z", ["規約の違反"])).toEqual([
      "[light] src/b.ts (参考節との食い違い): 広がり",
      "[light] 言い回し: 2 回目だけ",
    ]);
  });
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

  it("英語の guide を読んだ見直し役が書く acceptance criteria の category も、受け入れ条件の文言として直す側に分ける（t489）", () => {
    const english = finding({ category: "missing acceptance criteria" });
    const upper = finding({ category: "Acceptance Criteria gap" });
    const wording = finding({ category: "wording" });
    expect(splitFindings([english, upper, wording], []).fix).toEqual([english, upper]);
    expect(splitFindings([english, upper, wording], []).unfixedLight).toEqual([wording]);
  });

  it("受け入れ条件でない acceptance test の指摘（軽い）は、直さない側に残す（t489）", () => {
    const test = finding({ category: "acceptance test failure" });
    expect(splitFindings([test], []).fix).toEqual([]);
    expect(splitFindings([test], []).unfixedLight).toEqual([test]);
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
      ),
    ).toBe("[heavy] a.ts:3 (不具合): x y Fix: z");
    expect(findingText(finding({ category: "好み", reason: "r" }))).toBe("[light] 好み: r");
  });
});

describe("親が手直しに渡した指摘（t639）", () => {
  it("手直しに渡した軽い指摘は、直したかによらず直さなかった軽い指摘の節から外す。渡していない同じ文の指摘は残す", () => {
    const handed = finding({ category: "参考節との食い違い", file: "src/b.ts", reason: "渡した" });
    const kept = finding({ category: "言い回し", reason: "渡さなかった" });
    const rounds = [
      { at: "2026-11-09T03:00:00Z", findings: [handed, kept], handed: [handed] },
      // 次の回に同じ指摘が出ても、手直しに渡したので外す
      { at: "2026-11-09T04:00:00Z", findings: [handed], handed: undefined },
    ];
    expect(unfixedLightLines(rounds, "2026-11-09T01:00:00Z", ["規約の違反"])).toEqual([
      "[light] 言い回し: 渡さなかった",
    ]);
  });

  it("作業ブランチより前の回で渡した指摘は、今の作業の節からは外さない", () => {
    const old = finding({ reason: "前の作業" });
    const rounds = [{ at: "2026-11-09T01:00:00Z", findings: [old], handed: [old] }];
    expect(unfixedLightLines(rounds, "2026-11-09T02:00:00Z", ["規約の違反"])).toEqual([]);
  });

  it("照合は severity を見ず、一覧にない指摘を unmatched に返す", () => {
    const listed = finding({ severity: "light", category: "言い回し", reason: "一覧" });
    const other = finding({ category: "言い回し", reason: "一覧にない" });
    const { matched, unmatched } = matchFindings(
      [listed],
      [{ ...listed, severity: "heavy" }, other],
    );
    expect(matched).toEqual([listed]);
    expect(unmatched).toEqual([other]);
  });
});

describe("PR の本文に書き足す節（t600）", () => {
  it("もとの本文を残して節を書き足し、もう一度書くと節を入れ替える（二重にしない）", () => {
    const body = "## 概要\n\n元の本文\n";
    const once = withUnfixedLight(body, ["[light] a.ts: 一"]);
    expect(once.startsWith("## 概要\n\n元の本文\n\n")).toBe(true);
    expect(once).toContain(
      `${UNFIXED_LIGHT_BEGIN}\n## Unfixed light findings\n\n- [light] a.ts: 一\n${UNFIXED_LIGHT_END}`,
    );
    const twice = withUnfixedLight(once, ["[light] b.ts: 二"]);
    expect(twice.split(UNFIXED_LIGHT_BEGIN)).toHaveLength(2);
    expect(twice).toContain("- [light] b.ts: 二");
    expect(twice).not.toContain("a.ts");
    expect(twice.startsWith("## 概要\n\n元の本文\n\n")).toBe(true);
  });

  it("指摘がなければ本文を変えず、前の回の節だけを外す", () => {
    const body = "## 概要\n\n元の本文\n";
    expect(withUnfixedLight(body, [])).toBe(body);
    const noted = withUnfixedLight(body, ["[light] a.ts: 一"]);
    expect(withUnfixedLight(noted, [])).toBe("## 概要\n\n元の本文\n");
  });
});
