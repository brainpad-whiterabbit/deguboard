// 作業中のチケットの Iteration は active、という規則の決定の組み合わせ（経路 claim・move・戻し × Iteration の状態
// active・planned でほかに active あり／なし・closed・Iteration なし）と、作業中のチケットを Iteration に入れてよいか
// （Status × 入れ先の状態）を、git・ファイルなしで確かめる。
// 事実を集めて開始と拒否を行う経路は commands-claim-setup.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import { STATUSES, type Status } from "../model/common.js";
import {
  decideWorkAssignment,
  decideWorkIteration,
  workRouteOfMove,
  type WorkAssignmentFacts,
  type WorkIterationFacts,
  type WorkRoute,
} from "./work-iteration-judge.js";

const ROUTES: readonly WorkRoute[] = ["claim", "move", "return"];

const decide = (over: Partial<WorkIterationFacts>) =>
  decideWorkIteration({
    route: "claim",
    ticket: "t7",
    iteration: undefined,
    otherActive: undefined,
    ...over,
  });

const messageOf = (over: Partial<WorkIterationFacts>): string => {
  const decision = decide(over);
  if (decision.kind !== "reject") throw new Error(`拒否でない：${decision.kind}`);
  return decision.message;
};

describe("decideWorkIteration", () => {
  it.each(ROUTES)("%s：Iteration が active なら進める", (route) => {
    expect(decide({ route, iteration: { id: "s2", status: "active" } })).toEqual({ kind: "go" });
  });

  it.each(ROUTES)(
    "%s：Iteration のないチケットは対象外で進める（ほかに active があっても）",
    (route) => {
      expect(decide({ route })).toEqual({ kind: "go" });
      expect(decide({ route, otherActive: "s1" })).toEqual({ kind: "go" });
    },
  );

  it.each(["claim", "move"] as const)(
    "%s：planned でほかに active がなければ、その Iteration を開始する",
    (route) => {
      expect(decide({ route, iteration: { id: "s2", status: "planned" } })).toEqual({
        kind: "start",
        iteration: "s2",
      });
    },
  );

  it("return：planned でほかに active がなくても開始せず拒否し、開始するかチケットを移すよう案内する", () => {
    const message = messageOf({ route: "return", iteration: { id: "s2", status: "planned" } });
    expect(message).toContain("t7 is in s2 (planned), so it cannot go back to work");
    expect(message).toContain("start s2 (dg iteration start s2)");
    expect(message).toContain("dg iteration add <iteration> t7");
  });

  it.each(["claim", "move"] as const)(
    "%s：planned でほかに active があれば拒否し、チケットを active に移す・今の active を閉じるを案内する",
    (route) => {
      const message = messageOf({
        route,
        iteration: { id: "s2", status: "planned" },
        otherActive: "s1",
      });
      expect(message).toBe(
        "t7 is in s2 (planned, and s1 is active), so work on it cannot start (a ticket in progress or in review must be in the active Iteration, and --override does not pass this). Ask a person which to do: move t7 into s1 (dg iteration add s1 t7), or close s1 (dg iteration close s1), and then try again",
      );
    },
  );

  it("return：planned でほかに active があれば拒否し、active を閉じた後に開始も要ると案内する", () => {
    const message = messageOf({
      route: "return",
      iteration: { id: "s2", status: "planned" },
      otherActive: "s1",
    });
    expect(message).toContain(
      "t7 is in s2 (planned, and s1 is active), so it cannot go back to work",
    );
    expect(message).toContain("move t7 into s1 (dg iteration add s1 t7)");
    expect(message).toContain(
      "close s1 (dg iteration close s1) and start s2 (dg iteration start s2)",
    );
  });

  it.each(ROUTES)(
    "%s：closed でほかに active があれば拒否し、active に移すか、閉じて再開するよう案内する",
    (route) => {
      const message = messageOf({
        route,
        iteration: { id: "s2", status: "closed" },
        otherActive: "s3",
      });
      expect(message).toContain("t7 is in s2 (closed, and s3 is active)");
      expect(message).toContain("move t7 into s3 (dg iteration add s3 t7)");
      expect(message).toContain(
        "close s3 (dg iteration close s3) and reopen s2 (dg iteration reopen s2)",
      );
    },
  );

  it.each(ROUTES)(
    "%s：closed でほかに active がなければ拒否し、進める Iteration に移すか再開するよう案内する",
    (route) => {
      const message = messageOf({ route, iteration: { id: "s2", status: "closed" } });
      expect(message).toContain("t7 is in s2 (closed), so");
      expect(message).toContain("dg iteration add <iteration> t7");
      expect(message).toContain("reopen s2 (dg iteration reopen s2)");
    },
  );

  it("拒否の文は経路で言い分け、どれも --override で越えられないと書く", () => {
    const facts = { iteration: { id: "s2", status: "closed" } as const };
    expect(messageOf({ ...facts, route: "claim" })).toContain("work on it cannot start");
    expect(messageOf({ ...facts, route: "move" })).toContain("work on it cannot start");
    expect(messageOf({ ...facts, route: "return" })).toContain("it cannot go back to work");
    for (const route of ROUTES)
      expect(messageOf({ ...facts, route })).toContain("--override does not pass this");
  });
});

describe("workRouteOfMove", () => {
  it("todo から作業中へは着手、done・abandoned から作業中へは戻し。ほかの移動は規則の外", () => {
    const routes = Object.fromEntries(
      STATUSES.flatMap((from) =>
        STATUSES.filter((to) => to !== from).map((to) => [
          `${from}>${to}`,
          workRouteOfMove(from, to),
        ]),
      ).filter(([, route]) => route !== undefined),
    );
    expect(routes).toEqual({
      "todo>in_progress": "move",
      "todo>review": "move",
      "done>in_progress": "return",
      "done>review": "return",
      "abandoned>in_progress": "return",
      "abandoned>review": "return",
    });
  });

  it("作業中どうしの移動と、作業中から出る移動は確かめない", () => {
    const outside: [Status, Status][] = [
      ["in_progress", "review"],
      ["review", "in_progress"],
      ["todo", "done"],
      ["review", "done"],
      ["done", "todo"],
      ["in_progress", "abandoned"],
    ];
    for (const [from, to] of outside) expect(workRouteOfMove(from, to)).toBeUndefined();
  });
});

describe("decideWorkAssignment", () => {
  const assign = (over: Partial<WorkAssignmentFacts>) =>
    decideWorkAssignment({
      ticket: "t7",
      status: "in_progress",
      target: { id: "s2", status: "planned" },
      otherActive: undefined,
      ...over,
    });

  it("作業中でないチケットは、どの状態の Iteration にも入れてよい", () => {
    for (const status of ["todo", "done", "abandoned"] as const)
      for (const target of [
        { id: "s2", status: "planned" },
        { id: "s2", status: "active" },
      ] as const)
        expect(assign({ status, target, otherActive: "s1" })).toBeUndefined();
  });

  it.each(["in_progress", "review"] as const)(
    "%s：active の Iteration には入れてよい",
    (status) => {
      expect(assign({ status, target: { id: "s2", status: "active" } })).toBeUndefined();
    },
  );

  it.each(["in_progress", "review"] as const)(
    "%s：planned でほかに active がなければ拒否し、開始してから入れるよう案内する（入れる操作は開始しない）",
    (status) => {
      expect(assign({ status })).toBe(
        `t7 is ${status} and s2 is planned, so t7 cannot be added to s2 (a ticket in progress or in review must be in the active Iteration, and --override does not pass this). Ask a person which to do: start s2 first (dg iteration start s2), and then try again`,
      );
    },
  );

  it("planned でほかに active があれば拒否し、active に入れるか、active を閉じて開始するよう案内する", () => {
    const message = assign({ status: "review", otherActive: "s1" });
    expect(message).toContain("t7 is review and s2 is planned, so t7 cannot be added to s2");
    expect(message).toContain("add it to s1, the active Iteration (dg iteration add s1 t7)");
    expect(message).toContain(
      "close s1 (dg iteration close s1) and start s2 (dg iteration start s2)",
    );
  });
});
