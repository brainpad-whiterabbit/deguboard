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
    expect(parseRoute("#/iterations")).toEqual({ page: "iterations", id: undefined });
  });

  it("hrefOf と parseRoute は往復する", () => {
    for (const route of [
      { page: "board" as const, epic: "e1" },
      { page: "ticket" as const, id: "t3" },
      { page: "epics" as const, id: "e1" },
      { page: "iterations" as const, id: "s2" },
    ]) {
      expect(parseRoute(hrefOf(route))).toEqual(route);
    }
  });
});
