// 主体 ID の形の写しを照らすためだけに core の実行時のコード（actorIdOf）を取り込む（画面のコードは型だけを取る。ADR-033）
import { actorIdOf } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import { assigneeMarkOf } from "./assignee-mark.js";

describe("担当の印（assigneeMarkOf）", () => {
  it("担当がなければ印を出さない", () => {
    expect(assigneeMarkOf(undefined, "claude-code")).toBeNull();
  });

  it("担当が人なら頭文字（大文字）の丸だけで、Run の agent によらない", () => {
    expect(assigneeMarkOf("eiki.kitajima", "codex")).toEqual({
      initial: "E",
      agent: false,
      title: "eiki.kitajima",
    });
  });

  it("担当が agent なら持ち主の頭文字とアイコンで、Run の agent はホバーの文に出す。Run がなければ「Run なし」", () => {
    expect(assigneeMarkOf("eiki.kitajima/agent", "claude-code")).toEqual({
      initial: "E",
      agent: true,
      title: "eiki.kitajima/agent · claude-code",
    });
    expect(assigneeMarkOf("hana/agent", "codex")).toMatchObject({ initial: "H", agent: true });
    expect(assigneeMarkOf("eiki/agent", null)).toEqual({
      initial: "E",
      agent: true,
      title: "eiki/agent · Run なし",
    });
  });

  it("主体 ID の形は core の actorIdOf の写しで、core が作る agent の ID を agent、人の ID を人と見分ける", () => {
    expect(assigneeMarkOf(actorIdOf("hana", "agent"), "codex")).toMatchObject({
      initial: "H",
      agent: true,
    });
    expect(assigneeMarkOf(actorIdOf("hana", "human"), "codex")).toMatchObject({
      initial: "H",
      agent: false,
    });
  });
});
