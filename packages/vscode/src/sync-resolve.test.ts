import { describe, expect, it } from "vitest";
import { hasResolvableFields, resolveChoices, resolvedSummary } from "./sync-resolve.js";

describe("同期の競合の通知（SY-4）", () => {
  it("ボタンは remote と local の 2 つで、押した側を返す", () => {
    expect(resolveChoices()).toEqual([
      { side: "remote", label: "Take remote" },
      { side: "local", label: "Take local" },
    ]);
  });

  it("ぶつかったフィールドが 1 件でもあればボタンを出す", () => {
    expect(hasResolvableFields({ conflict_fields: [{ file: "a.md", field: "title" }] })).toBe(true);
  });

  it("フィールドがない競合（config.yaml だけ）と、data がないときはボタンを出さない", () => {
    expect(hasResolvableFields({ conflict_fields: [] })).toBe(false);
    expect(hasResolvableFields({ conflicts: ["config.yaml"] })).toBe(false);
    expect(hasResolvableFields(undefined)).toBe(false);
    expect(hasResolvableFields(null)).toBe(false);
  });

  it("--resolve の結果は、ファイル・フィールド・採った値と捨てた値を一文にする", () => {
    const summary = resolvedSummary("remote", {
      resolved: [
        { file: "tickets/t1.md", field: "title", taken: "新", discarded: "旧" },
        { file: "tickets/t1.md", field: "本文", taken: ["a"], discarded: ["b"] },
      ],
    });
    expect(summary).toBe(
      'Resolved by taking remote: tickets/t1.md title: took "新", discarded "旧"; tickets/t1.md 本文: took ["a"], discarded ["b"]',
    );
  });

  it("長い値は字数の上限で切って示す", () => {
    const long = "あ".repeat(200);
    const summary = resolvedSummary("local", {
      resolved: [{ file: "f.md", field: "本文", taken: long, discarded: "x" }],
    });
    expect(summary).toContain("…");
    expect(summary!.length).toBeLessThan(200);
  });

  it("採った値がなければ（解くものがなければ）文を出さない", () => {
    expect(resolvedSummary("remote", { resolved: [] })).toBeUndefined();
    expect(resolvedSummary("remote", {})).toBeUndefined();
  });
});
