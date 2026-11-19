// 人向けの出力の形を確かめる（printHuman）

import { describe, expect, it } from "vitest";
import { resolveWorkflow, workflowSections } from "@deguboard/core";
import { printHuman, type Streams } from "./output.js";

function capture(): Streams & { text(): string } {
  const out: string[] = [];
  return {
    out: (t) => out.push(t),
    err: () => {},
    text: () => out.join("\n"),
  };
}

describe("printHuman の dg workflow show", () => {
  it("sections を鍵ごとの値・既定値・modified の表に開き、[object Object] を出さない", () => {
    const wf = resolveWorkflow({
      wip: { review: 3 },
      flow: { design: { decide: "always_ask", after: "plan", guide: "docs/design.md" } },
    });
    const streams = capture();
    printHuman(streams, "workflow.show", {
      data: { path: "workflow.yaml", exists: true, sections: workflowSections(wf) },
      warnings: [],
    });
    const lines = streams.text().split("\n");
    const at = lines.indexOf("sections:");
    expect(at).toBeGreaterThanOrEqual(0);
    const row = (key: string) =>
      lines
        .slice(at + 1)
        .find((l) => l.trim().startsWith(`${key} `))
        ?.trim()
        .split(/\s{2,}/);

    expect(streams.text()).not.toContain("[object Object]");
    expect(lines[at + 1]?.trim().split(/\s{2,}/)).toEqual([
      "key",
      "value",
      "default",
      "modified",
      "custom",
    ]);
    // 既定のままの行
    expect(row("states.todo.label")).toEqual(["states.todo.label", "Todo", "Todo", "false"]);
    // 配列の値は並べ、空の配列は [] と出す
    expect(row("boundaries.todo.in_progress.requires")).toEqual([
      "boundaries.todo.in_progress.requires",
      "deps_done",
      "deps_done",
      "false",
    ]);
    expect(row("boundaries.in_progress.review.requires")).toEqual([
      "boundaries.in_progress.review.requires",
      "[]",
      "[]",
      "false",
    ]);
    // 上限を外した wip は none、既定と違うので modified
    expect(row("wip.in_progress")).toEqual(["wip.in_progress", "none", "5", "true"]);
    // 独自の段階は既定がなく、after と guide を custom に出す
    expect(row("flow.design")).toEqual([
      "flow.design",
      "always_ask",
      "true",
      "after: plan, guide: docs/design.md",
    ]);
  });
});
