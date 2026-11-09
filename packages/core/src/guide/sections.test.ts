import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { findGuideSection, guideSections } from "./sections.js";

const body = [
  "# 作業（work）",
  "",
  "前置きの文。",
  "",
  "## 対象を決める",
  "",
  "- Plan の ID",
  "",
  "## 実装する（draft の PR まで）",
  "",
  "1. 検査を通す",
  "",
  "```md",
  "## コードブロックの中の見出しは節にしない",
  "```",
  "",
  "### 小節は節の中に含む",
  "",
  "## 次の手順を選ぶ",
  "",
  "- 止める",
].join("\n");

describe("guide の節の切り出し", () => {
  it("## の見出しで節に分け、見出しの「（…）」を除いた名前を持つ", () => {
    const sections = guideSections(body);
    expect(sections.map((s) => s.name)).toEqual(["対象を決める", "実装する", "次の手順を選ぶ"]);
    expect(sections[1]!.heading).toBe("実装する（draft の PR まで）");
  });

  it("節の本文は見出しの行から次の ## か # の見出しの手前までで、コードブロックと小節を含む", () => {
    const [, implement] = guideSections(body);
    expect(implement!.text.startsWith("## 実装する（draft の PR まで）")).toBe(true);
    expect(implement!.text).toContain("## コードブロックの中の見出しは節にしない");
    expect(implement!.text).toContain("### 小節は節の中に含む");
    expect(implement!.text).not.toContain("次の手順を選ぶ");
    expect(
      implement!.text.endsWith(
        "1. 検査を通す\n\n```md\n## コードブロックの中の見出しは節にしない\n```\n\n### 小節は節の中に含む",
      ),
    ).toBe(true);
  });

  it("# の見出しより前の本文と # の見出しの下は、どの節にも入らない", () => {
    const sections = guideSections(body);
    expect(sections.some((s) => s.text.includes("前置きの文"))).toBe(false);
    expect(sections.some((s) => s.text.includes("# 作業（work）"))).toBe(false);
    const withH1 = guideSections("## 一\n\n本文\n\n# 別の題\n\n題の下の文");
    expect(withH1).toHaveLength(1);
    expect(withH1[0]!.text).not.toContain("題の下の文");
  });

  it("見出しの文言でも、補足を除いた名前でも節が引ける", () => {
    expect(findGuideSection("work", body, "実装する（draft の PR まで）").name).toBe("実装する");
    expect(findGuideSection("work", body, "実装する").heading).toBe("実装する（draft の PR まで）");
  });

  it("ない節は使い方の誤りとして、そのトピックの節の名前の一覧を返す", () => {
    let error: unknown;
    try {
      findGuideSection("work", body, "ない節");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("work");
    expect((error as UsageError).message).toContain("対象を決める / 実装する / 次の手順を選ぶ");
  });
});
