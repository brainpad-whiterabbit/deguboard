// 写しを照らすためだけに core の実行時のコード（matchesQuery・movePermissions）を取り込む（画面のコードは型だけを取る。ADR-033）
import {
  matchesQuery,
  movePermissions,
  resolveWorkflow,
  STATUSES as CORE_STATUSES,
} from "@deguboard/core";
import { describe, expect, it } from "vitest";
import { movableStatuses, STATUSES, ticketMatchesQuery } from "./types.js";

const t = { id: "t12" as const, title: "Web の検索", labels: ["UI", "search-ui"] };

describe("検索の当て方（ticketMatchesQuery）", () => {
  // 当て方の例は core の matchesQuery のテスト（commands/filters.test.ts）が確かめる
  it("core の matchesQuery（ticket list の query）の写しで、同じ結果になる", () => {
    const queries = ["", "  ", "t1", "T12", "t123", "WEB", "検索", "ui", "Search", "なし", " t12 "];
    for (const q of queries)
      for (const labels of [true, false])
        expect([q, labels, ticketMatchesQuery(t, q, labels)]).toEqual([
          q,
          labels,
          matchesQuery(t, q, labels),
        ]);
  });
});

describe("Status の選択に並べる Status（movableStatuses）", () => {
  // 既定：abandon・reopen は human_only、back は anyone、review → done は ask_unless_auto。in_progress → review だけ agent_only に替える
  const moves = movePermissions(
    resolveWorkflow({
      boundaries: [{ from: "in_progress", to: "review", requires: [], decide: "agent_only" }],
    }),
  );

  it("moves がなければ（前の版の cache）、すべての Status を並べる", () => {
    expect(movableStatuses("review", undefined, "human")).toEqual([...STATUSES]);
  });

  it("主体が分からなければ絞らない", () => {
    expect(movableStatuses("todo", moves, undefined)).toEqual([...STATUSES]);
  });

  it("人には --override の要る動き（agent_only の境目を越える）を外す", () => {
    expect(movableStatuses("todo", moves, "human")).toEqual(["todo", "in_progress", "abandoned"]);
    expect(movableStatuses("review", moves, "human")).toEqual([...STATUSES]);
  });

  it("エージェントには拒否される動き（human_only）を外し、承認で進める動きは残す", () => {
    expect(movableStatuses("review", moves, "agent")).toEqual([
      "todo",
      "in_progress",
      "review",
      "done",
    ]);
    expect(movableStatuses("done", moves, "agent")).toEqual(["done"]);
  });

  it("並ぶ先は core の moves の権限と同じ", () => {
    for (const from of CORE_STATUSES) {
      const of = (to: string) => moves.find((m) => m.from === from && m.to === to);
      expect(movableStatuses(from, moves, "human"), `human ${from}`).toEqual(
        CORE_STATUSES.filter((to) => to === from || of(to)?.human === "allow"),
      );
      expect(movableStatuses(from, moves, "agent"), `agent ${from}`).toEqual(
        CORE_STATUSES.filter((to) => to === from || of(to)?.agent !== "reject"),
      );
    }
  });
});
