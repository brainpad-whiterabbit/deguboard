import { describe, expect, it } from "vitest";
import type { Epic, Iteration, TicketRow } from "../types.js";
import { plan } from "../test-helpers.js";
import {
  hideClosedFinished,
  kanbanPlanMarks,
  shortPeriod,
  ticketProgress,
  waitLabel,
} from "./board.js";

/** deps_done を省けば、依存先がないときだけ真にする */
function ticket(partial: Partial<TicketRow> & { id: string }): TicketRow {
  return {
    deps_done: (partial.depends_on ?? []).length === 0,
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

  it("開いた Plan に入っているチケットだけに、Plan の番号・承認待ちか・残っている待ちの相手を持たせる", () => {
    const marks = kanbanPlanMarks(
      [
        plan({
          id: "p1",
          tickets: ["t1", "t2", "t3", "t4"],
          after: { t3: ["t1"], t4: ["t2", "t3"] },
        }),
        plan({ id: "p2", tickets: ["t5"], status: "closed" }),
        plan({ id: "p3", tickets: ["t6"], status: "pending" }),
      ],
      tickets,
    );
    expect(Object.fromEntries(marks)).toEqual({
      t1: { plan: "p1", pending: false, waitingOn: [] },
      t2: { plan: "p1", pending: false, waitingOn: [] },
      t3: { plan: "p1", pending: false, waitingOn: [] },
      t4: { plan: "p1", pending: false, waitingOn: ["t2", "t3"] },
      // 承認待ちの Plan のチケットは pending
      t6: { plan: "p3", pending: true, waitingOn: [] },
    });
  });

  it("Plan の after に加えて、終わっていない depends_on（Plan の外のもの・after に書かれていないもの）も待ちの相手に入れる", () => {
    const withDeps = [
      ticket({ id: "t1", status: "done" }),
      ticket({ id: "t2", status: "in_progress" }),
      // Plan の外：t8 は終わっていない、t9 は abandoned
      ticket({ id: "t8", status: "review" }),
      ticket({ id: "t9", status: "abandoned" }),
      // depends_on だけで Plan の外の t8 を待つ（after はない）
      ticket({ id: "t3", depends_on: ["t1", "t8", "t9"] }),
      // after で t2 を待ち、depends_on でも t2 と Plan の中の t5 を待つ（重ねて数えない）
      ticket({ id: "t4", depends_on: ["t2", "t5"] }),
      ticket({ id: "t5" }),
      // 画面が読んでいないチケット（別の Project のもの）への depends_on は、deps_done で決める
      ticket({ id: "t6", depends_on: ["t99"], deps_done: false }),
      ticket({ id: "t7", depends_on: ["t98"], deps_done: true }),
    ];
    const marks = kanbanPlanMarks(
      [plan({ id: "p1", tickets: ["t2", "t3", "t4", "t5", "t6", "t7"], after: { t4: ["t2"] } })],
      withDeps,
    );
    expect(Object.fromEntries(marks)).toEqual({
      t2: { plan: "p1", pending: false, waitingOn: [] },
      t3: { plan: "p1", pending: false, waitingOn: ["t8"] },
      t4: { plan: "p1", pending: false, waitingOn: ["t2", "t5"] },
      t5: { plan: "p1", pending: false, waitingOn: [] },
      t6: { plan: "p1", pending: false, waitingOn: ["t99"] },
      t7: { plan: "p1", pending: false, waitingOn: [] },
    });
  });

  it("待ちの相手は 1 件なら番号、2 件以上なら先頭と残りの件数で書く", () => {
    expect(waitLabel(["t137"])).toBe("t137 待ち");
    expect(waitLabel(["t2", "t3", "t9"])).toBe("t2+2 待ち");
    expect(waitLabel([])).toBe("");
  });
});
