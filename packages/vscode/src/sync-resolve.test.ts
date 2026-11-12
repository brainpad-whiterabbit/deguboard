import { describe, expect, it } from "vitest";
import {
  hasResolvableFields,
  pickedSide,
  resolveChoices,
  resolvedSummary,
  syncNotice,
} from "./sync-resolve.js";

describe("同期の競合の通知（SY-4）", () => {
  it("ボタンは remote と local の 2 つで、押した側を返す", () => {
    expect(resolveChoices()).toEqual([
      { side: "remote", label: "Take remote" },
      { side: "local", label: "Take local" },
    ]);
  });

  it("押されたボタンの文字列から側を返し、押されなかったものや知らないものは undefined", () => {
    const choices = resolveChoices();
    expect(pickedSide(choices, "Take local")).toBe("local");
    expect(pickedSide(choices, "Take remote")).toBe("remote");
    expect(pickedSide(choices, undefined)).toBeUndefined();
    expect(pickedSide(choices, "Dismiss")).toBeUndefined();
  });

  it("競合で止まりフィールドがぶつかっていれば、ボタン付きの警告にする", () => {
    const data = { conflict_fields: [{ file: "a.md", field: "title" }] };
    const notice = syncNotice(["Conflicts with remote changes: a.md."], data, undefined);
    expect(notice.warning).toEqual({
      message: "deguboard: Conflicts with remote changes: a.md.",
      choices: resolveChoices(),
    });
    expect(notice.info).toBeUndefined();
  });

  it("フィールドがぶつからない競合は、ボタンなしの警告にする", () => {
    const notice = syncNotice(
      ["Conflicts in config.yaml."],
      { conflicts: ["config.yaml"] },
      undefined,
    );
    expect(notice.warning).toEqual({
      message: "deguboard: Conflicts in config.yaml.",
      choices: [],
    });
  });

  it("--resolve の結果の警告にはボタンを付けず、採った値と捨てた値を info にする", () => {
    const data = {
      conflict_fields: [{ file: "a.md", field: "title" }],
      resolved: [{ file: "a.md", field: "title", taken: "新", discarded: "旧" }],
    };
    const notice = syncNotice(["Conflicts in config.yaml."], data, "local");
    expect(notice.warning?.choices).toEqual([]);
    expect(notice.info).toBe(
      'deguboard: Resolved by taking local: a.md title: took "新", discarded "旧"',
    );
  });

  it("警告もなく解いたものもなければ、通知は何もない", () => {
    expect(syncNotice([], { resolved: [] }, undefined)).toEqual({});
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
      'Resolved by taking remote: tickets/t1.md title: took "新", discarded "旧"; tickets/t1.md body lines: took ["a"], discarded ["b"]',
    );
  });

  it("英語の通知に日本語のフィールド名（本文）を出さない", () => {
    const summary = resolvedSummary("remote", {
      resolved: [{ file: "tickets/t1.md", field: "本文", taken: "a", discarded: "b" }],
    });
    expect(summary).not.toContain("本文");
    expect(summary).toContain("body lines");
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
