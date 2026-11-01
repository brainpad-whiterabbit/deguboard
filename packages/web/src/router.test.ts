import { describe, expect, it } from "vitest";
import { hrefOf, parseRoute } from "./router.js";

describe("ハッシュのルーティング", () => {
  it("ハッシュから画面と ID を読み、空ならカンバン", () => {
    expect(parseRoute("")).toEqual({ page: "board", epic: undefined });
    expect(parseRoute("#/board?epic=e1")).toEqual({ page: "board", epic: "e1" });
    expect(parseRoute("#/backlog")).toEqual({ page: "backlog" });
    expect(parseRoute("#/tickets/t12")).toEqual({ page: "ticket", id: "t12" });
    expect(parseRoute("#/tickets")).toEqual({ page: "backlog" });
    expect(parseRoute("#/epics/e2")).toEqual({ page: "epics", id: "e2" });
    // Epic の一覧の画面はないので、ID がなければバックログ
    expect(parseRoute("#/epics")).toEqual({ page: "backlog" });
    // Iteration の一覧の画面はないので、ID がなければカンバン
    expect(parseRoute("#/iterations")).toEqual({ page: "board" });
    expect(parseRoute("#/iterations/s2")).toEqual({ page: "iterations", id: "s2" });
    expect(parseRoute("#/history")).toEqual({ page: "history" });
    expect(parseRoute("#/history?view=epic")).toEqual({ page: "history", view: "epic" });
    expect(parseRoute("#/history?view=x")).toEqual({ page: "history" });
    expect(parseRoute("#/board?iteration=s4&epic=e1&assignee=eiki%2Fagent")).toEqual({
      page: "board",
      iteration: "s4",
      epic: "e1",
      assignee: "eiki/agent",
    });
  });

  it("hrefOf と parseRoute は往復する", () => {
    for (const route of [
      { page: "board" as const, epic: "e1" },
      { page: "board" as const, iteration: "s4", epic: "e1", assignee: "eiki/agent" },
      { page: "board" as const, iteration: "-" },
      { page: "ticket" as const, id: "t3" },
      { page: "epics" as const, id: "e1" },
      { page: "iterations" as const, id: "s2" },
      { page: "history" as const, view: "epic" as const },
    ]) {
      expect(parseRoute(hrefOf(route))).toEqual(route);
    }
  });
});
