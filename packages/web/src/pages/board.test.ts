import { describe, expect, it } from "vitest";
// 進みの数え方の写しを照らすためだけに core の実行時のコードを取り込む（画面のコードは型だけを取る。ADR-007）
import { progressOf } from "@deguboard/core";
import { STATUSES, type Epic, type Iteration, type Ticket } from "../types.js";
import { ticket } from "../test-helpers.js";
import { shortPeriod } from "../components/iteration-parts.js";
import { hideClosedFinished, rowActivity, ticketProgress } from "./board.js";

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

  it("進みの数え方は core の progressOf（EP-3）の写しで、同じ結果になる", () => {
    const cases: Pick<Ticket, "status">[][] = [
      [],
      [{ status: "abandoned" }],
      [{ status: "done" }, { status: "done" }, { status: "review" }],
      STATUSES.flatMap((status, i) => Array.from({ length: i + 1 }, () => ({ status }))),
    ];
    for (const tickets of cases) expect(ticketProgress(tickets)).toEqual(progressOf(tickets));
  });
});

describe("左パネルのカンバンの行の頭の印", () => {
  const running = new Set(["t1", "t3"]);

  it("実行中の Run があれば Status によらず running、なければ in_progress だけ idle で、ほかは出さない", () => {
    expect(rowActivity({ id: "t1", status: "in_progress" }, running)).toBe("running");
    expect(rowActivity({ id: "t3", status: "review" }, running)).toBe("running");
    expect(rowActivity({ id: "t2", status: "in_progress" }, running)).toBe("idle");
    expect(rowActivity({ id: "t4", status: "todo" }, running)).toBeUndefined();
    expect(rowActivity({ id: "t5", status: "done" }, new Set())).toBeUndefined();
  });

  it("実行中の Run を読み終えるまで（null）は、in_progress でも出さない", () => {
    expect(rowActivity({ id: "t2", status: "in_progress" }, null)).toBeUndefined();
  });
});
