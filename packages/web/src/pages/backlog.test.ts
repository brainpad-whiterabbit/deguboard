import { describe, expect, it } from "vitest";
import { iteration } from "../test-helpers.js";
import type { Ticket } from "../types.js";
import { EMPTY_FILTER, filterBacklog, sectionsOf } from "./backlog.js";

function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    project: "default",
    title: partial.id,
    status: "todo",
    priority: "medium",
    labels: [],
    depends_on: [],
    runs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("バックログの絞り込み", () => {
  const tickets = [
    ticket({ id: "t1", title: "ログイン", priority: "low", labels: ["web"] }),
    ticket({ id: "t2", title: "API", priority: "high", status: "in_progress", epic: "e1" }),
    ticket({ id: "t3", title: "済み", status: "done" }),
    ticket({ id: "t4", title: "やめた", status: "abandoned" }),
    ticket({ id: "t5", title: "画面", priority: "high", iteration: "s1", labels: ["web", "ui"] }),
  ];

  it("担当者で絞る。NO_CLAIM は担当者のないもの", () => {
    const withClaim = tickets.map((t) => (t.id === "t2" ? { ...t, assignee: "eiki/agent" } : t));
    expect(
      filterBacklog(withClaim, { ...EMPTY_FILTER, assignee: "eiki/agent" }).map((t) => t.id),
    ).toEqual(["t2"]);
    expect(filterBacklog(withClaim, { ...EMPTY_FILTER, assignee: "-" }).map((t) => t.id)).toEqual([
      "t5",
      "t1",
    ]);
  });

  it("done と abandoned を除き、優先度と番号の順に並べる", () => {
    expect(filterBacklog(tickets, EMPTY_FILTER).map((t) => t.id)).toEqual(["t2", "t5", "t1"]);
  });

  it("番号・タイトル・ラベルで検索し、属性で絞り込む", () => {
    expect(filterBacklog(tickets, { ...EMPTY_FILTER, query: "web" }).map((t) => t.id)).toEqual([
      "t5",
      "t1",
    ]);
    expect(filterBacklog(tickets, { ...EMPTY_FILTER, query: "T2" }).map((t) => t.id)).toEqual([
      "t2",
    ]);
    expect(filterBacklog(tickets, { ...EMPTY_FILTER, query: "画面" }).map((t) => t.id)).toEqual([
      "t5",
    ]);
    expect(
      filterBacklog(tickets, { ...EMPTY_FILTER, status: "in_progress" }).map((t) => t.id),
    ).toEqual(["t2"]);
    expect(filterBacklog(tickets, { ...EMPTY_FILTER, priority: "high" }).map((t) => t.id)).toEqual([
      "t2",
      "t5",
    ]);
    expect(filterBacklog(tickets, { ...EMPTY_FILTER, epic: "e1" }).map((t) => t.id)).toEqual([
      "t2",
    ]);
    expect(filterBacklog(tickets, { ...EMPTY_FILTER, label: "ui" }).map((t) => t.id)).toEqual([
      "t5",
    ]);
  });
});

describe("バックログの区画", () => {
  const iterations = [
    iteration({ id: "s3", name: "後", status: "planned" }),
    iteration({ id: "s1", name: "済", status: "closed" }),
    iteration({ id: "s2", name: "今", status: "active" }),
    iteration({ id: "s4", name: "次", status: "planned" }),
  ];
  const tickets = [
    ticket({ id: "t1", priority: "high", iteration: "s2" }),
    ticket({ id: "t2", iteration: "s3" }),
    ticket({ id: "t3" }),
    ticket({ id: "t4", priority: "high" }),
    ticket({ id: "t5", status: "done", iteration: "s1" }),
    ticket({ id: "t6", iteration: "s2" }),
  ];
  const shape = (rows: Ticket[]) =>
    sectionsOf(rows, iterations, tickets).map((s) => [
      s.iteration?.id ?? "-",
      s.tickets.map((t) => t.id),
    ]);

  it("active → planned（番号の順）→ Iteration なしに分け、区画の中は優先度と番号の順。チケットの残らない closed は出さない", () => {
    expect(shape(filterBacklog(tickets, EMPTY_FILTER))).toEqual([
      ["s2", ["t1", "t6"]],
      ["s3", ["t2"]],
      ["s4", []],
      ["-", ["t4", "t3"]],
    ]);
  });

  it("絞り込みはすべての区画に効き、0 件の区画も残す", () => {
    expect(shape(filterBacklog(tickets, { ...EMPTY_FILTER, priority: "high" }))).toEqual([
      ["s2", ["t1"]],
      ["s3", []],
      ["s4", []],
      ["-", ["t4"]],
    ]);
  });
});
