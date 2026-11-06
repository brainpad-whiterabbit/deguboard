import { describe, expect, it } from "vitest";
import { candidateTitle } from "./ask-candidate.js";

describe("候補の title（UI-15）", () => {
  it("Skill の 1 文があれば「Skill: 文」、Skill だけなら名前、Skill を使わなければ渡された文", () => {
    expect(candidateTitle({ skill: "/dgdone", skill_summary: "照合します。" }, "なし")).toBe(
      "/dgdone: 照合します。",
    );
    expect(candidateTitle({ skill: "/dgdone", skill_summary: null }, "なし")).toBe("/dgdone");
    expect(candidateTitle({ skill: null, skill_summary: null }, "Skill を使わない")).toBe(
      "Skill を使わない",
    );
  });
});
