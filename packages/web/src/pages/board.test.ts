import { describe, expect, it } from "vitest";
import type { Epic, Iteration, Ticket } from "../types.js";
import { plan } from "../test-helpers.js";
import {
  hideClosedFinished,
  kanbanPlanMarks,
  shortPeriod,
  ticketProgress,
  waitLabel,
} from "./board.js";

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

describe("左パネルのカンバンの見出し", () => {
  it("期間は月/日に縮めて – でつなぎ、片方だけなら ? を置く", () => {
    expect(shortPeriod("2026-11-15", "2026-11-28")).toBe("11/15–11/28");
    expect(shortPeriod("2026-11-05", undefined)).toBe("11/5–?");
    expect(shortPeriod(undefined, undefined)).toBeUndefined();
  });

  it("進みは done の件数と abandoned を除く件数、Status ごとの件数を数える", () => {
    const p = ticketProgress([
      { status: "done" },
      { status: "todo" },
      { status: "in_progress" },
      { status: "abandoned" },
    ]);
    expect(p.done).toBe(1);
    expect(p.total).toBe(3);
    expect(p.by_status).toMatchObject({ todo: 1, in_progress: 1, review: 0, done: 1 });
  });
});

describe("左パネルのカンバンの行の Plan の番号と待ち", () => {
  const tickets = [
    ticket({ id: "t1", status: "done" }),
    ticket({ id: "t2", status: "in_progress" }),
    ticket({ id: "t3" }),
    ticket({ id: "t4" }),
    ticket({ id: "t5" }),
    ticket({ id: "t6" }),
  ];

  it("開いた Plan に入っているチケットだけに、Plan の番号と残っている待ちの相手を持たせる", () => {
    const marks = kanbanPlanMarks(
      [
        plan({
          id: "p1",
          tickets: ["t1", "t2", "t3", "t4"],
          after: { t3: ["t1"], t4: ["t2", "t3"] },
        }),
        plan({ id: "p2", tickets: ["t5"], status: "closed" }),
      ],
      tickets,
    );
    expect(Object.fromEntries(marks)).toEqual({
      t1: { plan: "p1", waitingOn: [] },
      t2: { plan: "p1", waitingOn: [] },
      t3: { plan: "p1", waitingOn: [] },
      t4: { plan: "p1", waitingOn: ["t2", "t3"] },
    });
  });

  it("待ちの相手は 1 件なら番号、2 件以上なら先頭と残りの件数で書く", () => {
    expect(waitLabel(["t137"])).toBe("t137 待ち");
    expect(waitLabel(["t2", "t3", "t9"])).toBe("t2+2 待ち");
  });
});
