import { describe, expect, it } from "vitest";
// 進みの数え方の写しを照らすためだけに core の実行時のコードを取り込む（画面のコードは型だけを取る。ADR-007）
import { progressOf } from "@deguboard/core";
import { STATUSES, type Epic, type Iteration, type Ticket } from "../types.js";
import { iteration, ticket } from "../test-helpers.js";
import {
  boardIterationSelection,
  boardSelection,
  hideClosedFinished,
  rowActivity,
  ticketProgress,
  ticketsInSelection,
} from "./board.js";

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

  it("Epic が closed でも終わっていないチケットは残し、Epic が open か Epic なしで閉じた Iteration に入っていない終わったチケットも残す（閉じた Epic・Iteration の done・abandoned は除く）", () => {
    expect(ids()).toEqual(["t3", "t4", "t5", "t6", "t7", "t8", "t11"]);
  });

  it("絞り込みで closed の Epic を選んだときは、その Epic の終わったチケットも残す", () => {
    expect(ids("e1")).toEqual(expect.arrayContaining(["t1", "t2", "t10"]));
    expect(ids("e1")).not.toContain("t9");
  });
});

describe("左パネルのカンバンの見出し", () => {
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

describe("カンバンの iteration の値が指す範囲（boardIterationSelection）", () => {
  const all = [
    iteration({ id: "s0", name: "前", status: "closed" }),
    iteration({ id: "s1", name: "今", status: "active" }),
    iteration({ id: "s2", name: "次", status: "planned" }),
  ];
  const idOf = (id: string | undefined) => {
    const selection = boardIterationSelection(all, id);
    return selection && (selection.kind === "all" ? "*" : selection.iteration.id);
  };

  it("「すべて」（*）と、active・planned の Iteration の ID は範囲を指す", () => {
    expect(idOf("*")).toBe("*");
    expect(idOf("s1")).toBe("s1");
    expect(idOf("s2")).toBe("s2");
  });

  it("閉じた Iteration・存在しない Iteration・前の版の「なし」（-）・値なしは範囲を指さない", () => {
    expect(idOf("s0")).toBeUndefined();
    expect(idOf("s99")).toBeUndefined();
    expect(idOf("-")).toBeUndefined();
    expect(idOf(undefined)).toBeUndefined();
  });
});

describe("カンバンの範囲（Iteration の選択）", () => {
  const s1 = iteration({ id: "s1", name: "今", status: "active" });
  const s2 = iteration({ id: "s2", name: "次", status: "planned" });
  const s3 = iteration({ id: "s3", name: "次の次", status: "planned" });
  const idOf = (
    open: Parameters<typeof boardSelection>[0],
    query?: string,
    remembered?: string,
  ) => {
    const selection = boardSelection(open, query, remembered);
    return selection.kind === "all" ? "*" : selection.iteration.id;
  };

  it("札を選んでいなければ active を選び、active がなければ番号の小さい planned を選ぶ", () => {
    expect(idOf([s1, s2, s3])).toBe("s1");
    expect(idOf([s2, s3])).toBe("s2");
  });

  it("ハッシュの iteration が開いた Iteration か「すべて」（*）ならそれを選ぶ", () => {
    expect(idOf([s1, s2], "s2")).toBe("s2");
    expect(idOf([s1, s2], "*")).toBe("*");
  });

  it("ハッシュの iteration が閉じた Iteration・存在しない Iteration・前の版の「なし」（-）を指したら既定に戻る", () => {
    // 閉じた Iteration は open に入らない
    expect(idOf([s1, s2], "s0")).toBe("s1");
    expect(idOf([s1, s2], "s99")).toBe("s1");
    expect(idOf([s1, s2], "-")).toBe("s1");
    expect(idOf([s2, s3], "-")).toBe("s2");
  });

  it("ハッシュで選んでいなければ最後に選んだもの（使えるときだけ）を選ぶ", () => {
    expect(idOf([s1, s2], undefined, "s2")).toBe("s2");
    expect(idOf([s1, s2], undefined, "*")).toBe("*");
    expect(idOf([s1, s2], undefined, "s0")).toBe("s1");
    expect(idOf([s1, s2], "s2", "*")).toBe("s2");
  });

  it("開いた Iteration がなければ「すべて」", () => {
    expect(idOf([])).toBe("*");
    expect(idOf([], "s1")).toBe("*");
  });

  it("「すべて」は開いた Iteration のチケットだけで、Iteration に入っていないチケットと閉じた Iteration のチケットは含めない", () => {
    const tickets = [
      ticket({ id: "t1", iteration: "s1" }),
      ticket({ id: "t2", iteration: "s2" }),
      ticket({ id: "t3", iteration: "s0" }),
      ticket({ id: "t4" }),
    ];
    const ids = (selection: Parameters<typeof ticketsInSelection>[2]) =>
      ticketsInSelection(tickets, [s1, s2], selection).map((t) => t.id);
    expect(ids({ kind: "all" })).toEqual(["t1", "t2"]);
    expect(ids({ kind: "iteration", iteration: s2 })).toEqual(["t2"]);
    expect(ticketsInSelection(tickets, [], { kind: "all" })).toEqual([]);
  });
});
