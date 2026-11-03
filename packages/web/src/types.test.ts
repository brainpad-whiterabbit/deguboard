// 写しを照らすためだけに core の実行時のコード（matchesQuery・canTransition）を取り込む（画面のコードは型だけを取る。ADR-007）
import {
  canTransition,
  matchesQuery,
  resolveWorkflow,
  STATUSES as CORE_STATUSES,
} from "@deguboard/core";
import { describe, expect, it } from "vitest";
import { movableStatuses, STATUSES, ticketMatchesQuery, type WorkflowView } from "./types.js";

const t = { id: "t12" as const, title: "Web の検索", labels: ["UI", "search-ui"] };

describe("検索の当て方（ticketMatchesQuery）", () => {
  it("番号・タイトル・ラベルの部分一致で、前後の空白と大文字小文字によらない", () => {
    expect(ticketMatchesQuery(t, "T1")).toBe(true);
    expect(ticketMatchesQuery(t, " web ")).toBe(true);
    expect(ticketMatchesQuery(t, "ui")).toBe(true);
    expect(ticketMatchesQuery(t, "t3")).toBe(false);
    expect(ticketMatchesQuery(t, "")).toBe(true);
  });

  it("labels を false にするとラベルには当てない", () => {
    expect(ticketMatchesQuery(t, "search-ui", false)).toBe(false);
    expect(ticketMatchesQuery(t, "検索", false)).toBe(true);
  });

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
  const transitions: WorkflowView["transitions"] = [
    { from: "todo", to: "done", by: [], requires: [] },
    { from: "todo", to: "review", by: ["agent"], requires: [] },
    { from: "in_progress", to: "review", requires: ["deps_done"] },
    { from: "review", to: "done", by: ["human"], requires: ["pr_merged"] },
  ];

  it("transitions が空なら、どの遷移も自由なのですべての Status を並べる", () => {
    expect(movableStatuses("review", [], "human")).toEqual([...STATUSES]);
  });

  it("今の Status は残し、by が [] の遷移と、by が主体を含まない遷移の先は外す", () => {
    expect(movableStatuses("todo", transitions, "human")).toEqual([
      "todo",
      "in_progress",
      "abandoned",
    ]);
    expect(movableStatuses("todo", transitions, "agent")).toEqual([
      "todo",
      "in_progress",
      "review",
      "abandoned",
    ]);
  });

  it("requires だけの制約の先は並べる（満たさないときは ticket.move が理由を出して拒否する）", () => {
    expect(movableStatuses("in_progress", transitions, "human")).toContain("review");
  });

  it("主体が分からなければ by は見ず、by が [] の遷移だけ外す", () => {
    expect(movableStatuses("todo", transitions, undefined)).toEqual([
      "todo",
      "in_progress",
      "review",
      "abandoned",
    ]);
  });

  it("並ぶ先は core の canTransition が主体の理由で拒否しない先と同じ（requires の判定は除く）", () => {
    const wf = resolveWorkflow({
      id: "w",
      name: "w",
      transitions,
      reconcile: [],
      fields: [],
    } as unknown as Parameters<typeof resolveWorkflow>[0]);
    for (const kind of ["human", "agent"] as const)
      for (const from of CORE_STATUSES) {
        const expected = CORE_STATUSES.filter((to) => {
          if (to === from) return true;
          const check = canTransition(wf, from, to, kind, {});
          return check.ok || check.reason !== "actor_not_allowed";
        });
        expect(movableStatuses(from, transitions, kind), `${kind} ${from}`).toEqual(expected);
      }
  });
});
