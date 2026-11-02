import { describe, expect, it } from "vitest";
import { agentIconKind, assigneeMarkOf } from "./assignee-mark.js";

describe("担当の印（assigneeMarkOf）", () => {
  it("担当がなければ印を出さない", () => {
    expect(assigneeMarkOf(undefined, "claude-code")).toBeNull();
  });

  it("担当が人なら頭文字（大文字）の丸だけで、Run の agent によらない", () => {
    expect(assigneeMarkOf("eiki.kitajima", "codex")).toEqual({
      initial: "E",
      agent: null,
      title: "eiki.kitajima",
    });
  });

  it("担当が agent なら持ち主の頭文字と Run の agent の種類。Run がなければ汎用で「Run なし」", () => {
    expect(assigneeMarkOf("eiki.kitajima/agent", "claude-code")).toEqual({
      initial: "E",
      agent: "claude",
      title: "eiki.kitajima/agent · claude-code",
    });
    expect(assigneeMarkOf("hana/agent", "codex")).toMatchObject({ initial: "H", agent: "codex" });
    expect(assigneeMarkOf("eiki/agent", null)).toEqual({
      initial: "E",
      agent: "generic",
      title: "eiki/agent · Run なし",
    });
  });

  it("claude-code・codex のほかの agent はすべて汎用", () => {
    expect(["claude-code", "codex", "e2e-agent", "", null, undefined].map(agentIconKind)).toEqual([
      "claude",
      "codex",
      "generic",
      "generic",
      "generic",
      "generic",
    ]);
  });
});
