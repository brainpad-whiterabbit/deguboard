import { describe, expect, it } from "vitest";
import { hrefOf, isDetailRoute, parseRoute } from "./router.js";

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
    expect(parseRoute("#/plans/p5")).toEqual({ page: "plans", id: "p5" });
    // Plan の一覧の画面はないので、ID がなければカンバン
    expect(parseRoute("#/plans")).toEqual({ page: "board" });
    expect(parseRoute("#/history")).toEqual({ page: "history" });
    expect(parseRoute("#/history?view=epic")).toEqual({ page: "history", view: "epic" });
    expect(parseRoute("#/history?view=ticket")).toEqual({ page: "history", view: "ticket" });
    expect(parseRoute("#/history?view=x")).toEqual({ page: "history" });
    // 検索語と結果の絞り込みもハッシュに持つ。知らない結果は読まない
    expect(parseRoute("#/history?view=ticket&q=%E3%83%AD%E3%82%B0+in&result=done")).toEqual({
      page: "history",
      view: "ticket",
      q: "ログ in",
      result: "done",
    });
    expect(parseRoute("#/history?q=&result=x")).toEqual({ page: "history" });
    expect(parseRoute("#/config")).toEqual({ page: "config" });
    // Run の画面はない（ADR-027）。前の版の #/runs はカンバンとして読む
    expect(parseRoute("#/runs")).toEqual({ page: "board" });
    expect(parseRoute("#/runs?by=iteration&iteration=s5")).toEqual({
      page: "board",
      iteration: "s5",
    });
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
      { page: "board" as const, iteration: "*" },
      { page: "ticket" as const, id: "t3" },
      { page: "epics" as const, id: "e1" },
      { page: "iterations" as const, id: "s2" },
      { page: "plans" as const, id: "p5" },
      { page: "history" as const, view: "epic" as const },
      { page: "history" as const, q: "t1?a&b" },
      {
        page: "history" as const,
        view: "ticket" as const,
        q: "ログ",
        result: "abandoned" as const,
      },
      { page: "config" as const },
    ]) {
      expect(parseRoute(hrefOf(route))).toEqual(route);
    }
  });

  it("チケット・Epic・Iteration・Plan の詳細だけを詳細のルートとして扱う（エディタのパネルに開く。UI-12）", () => {
    for (const hash of ["#/tickets/t1", "#/epics/e1", "#/iterations/s1", "#/plans/p1"])
      expect(isDetailRoute(parseRoute(hash)), hash).toBe(true);
    for (const hash of ["#/board", "#/backlog", "#/history", "#/runs", "#/config", "#/plans"])
      expect(isDetailRoute(parseRoute(hash)), hash).toBe(false);
  });
});
