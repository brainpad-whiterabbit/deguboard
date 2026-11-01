import { describe, expect, it } from "vitest";
import type { Epic, Iteration, Ticket } from "../types.js";
import { hideClosedFinished } from "./board.js";

function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    project: "default",
    title: partial.id,
    status: "todo",
    priority: "medium",
    labels: [],
    depends_on: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

const iterations: Pick<Iteration, "id" | "status">[] = [
  { id: "s1", status: "closed" },
  { id: "s2", status: "active" },
];
const epics: Pick<Epic, "id" | "status">[] = [
  { id: "e1", status: "closed" },
  { id: "e2", status: "open" },
];

describe("カンバンで閉じた Iteration か Epic の終わったチケットを出さない", () => {
  const tickets = [
    ticket({ id: "t1", status: "done", epic: "e1" }),
    ticket({ id: "t2", status: "abandoned", epic: "e1" }),
    ticket({ id: "t3", status: "todo", epic: "e1" }),
    ticket({ id: "t4", status: "in_progress", epic: "e1" }),
    ticket({ id: "t5", status: "review", epic: "e1" }),
    ticket({ id: "t6", status: "done", epic: "e2" }),
    ticket({ id: "t7", status: "done" }),
    ticket({ id: "t8", status: "abandoned" }),
    ticket({ id: "t9", status: "done", iteration: "s1" }),
    ticket({ id: "t10", status: "done", iteration: "s2", epic: "e1" }),
    ticket({ id: "t11", status: "done", iteration: "s2" }),
  ];
  const ids = (epic?: string) =>
    hideClosedFinished(tickets, iterations, epics, epic).map((t) => t.id);

  it("Epic か Iteration が closed の done・abandoned を除く", () => {
    expect(ids()).not.toContain("t1");
    expect(ids()).not.toContain("t2");
    expect(ids()).not.toContain("t9");
    expect(ids()).not.toContain("t10");
  });

  it("Epic が closed でも終わっていないチケットは残す", () => {
    expect(ids()).toEqual(expect.arrayContaining(["t3", "t4", "t5"]));
  });

  it("Epic が open か Epic なしで、閉じた Iteration に入っていない終わったチケットは残す", () => {
    expect(ids()).toEqual(["t3", "t4", "t5", "t6", "t7", "t8", "t11"]);
  });

  it("絞り込みで closed の Epic を選んだときは、その Epic の終わったチケットも残す", () => {
    expect(ids("e1")).toEqual(expect.arrayContaining(["t1", "t2", "t10"]));
    expect(ids("e1")).not.toContain("t9");
  });
});
