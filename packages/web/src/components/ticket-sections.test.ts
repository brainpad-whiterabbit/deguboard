import { describe, expect, it } from "vitest";
import { groupBySection, sectionOf, sortByStatusThenPriority } from "./ticket-sections.js";
import { ticket } from "../test-helpers.js";

describe("チケットの段分け", () => {
  it("done と abandoned はそれぞれの段、ほかの Status は未完了の段", () => {
    expect(sectionOf("todo")).toBe("open");
    expect(sectionOf("in_progress")).toBe("open");
    expect(sectionOf("review")).toBe("open");
    expect(sectionOf("done")).toBe("done");
    expect(sectionOf("abandoned")).toBe("abandoned");
  });

  it("段の中は Status の順（Workflow の並び）、同じ Status なら優先度と番号の順", () => {
    const sorted = sortByStatusThenPriority([
      ticket({ id: "t3", status: "review" }),
      ticket({ id: "t10", status: "todo", priority: "low" }),
      ticket({ id: "t2", status: "todo", priority: "medium" }),
      ticket({ id: "t9", status: "todo", priority: "high" }),
      ticket({ id: "t1", status: "in_progress" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["t9", "t2", "t10", "t1", "t3"]);
  });

  it("0 件の段は出さず、段の順は未完了・完了・中止", () => {
    const groups = groupBySection([
      ticket({ id: "t1", status: "abandoned" }),
      ticket({ id: "t2", status: "todo" }),
    ]);
    expect(groups.map((g) => [g.section.key, g.items.map((t) => t.id)])).toEqual([
      ["open", ["t2"]],
      ["abandoned", ["t1"]],
    ]);
    expect(groupBySection([])).toEqual([]);
  });
});
