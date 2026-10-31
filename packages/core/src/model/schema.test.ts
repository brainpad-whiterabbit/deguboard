import { describe, expect, it } from "vitest";
import { configSchema, defaultConfig } from "./config.js";
import { ticketSchema } from "./ticket.js";
import { workflowDefinitionSchema } from "./workflow.js";

describe("スキーマ", () => {
  it("チケットの必須項目が揃えば読め、既定値が入る", () => {
    const t = ticketSchema.parse({
      id: "t1",
      project: "default",
      title: "x",
      status: "todo",
      created_at: "2026-10-31T04:00:00Z",
      updated_at: "2026-10-31T04:00:00Z",
    });
    expect(t.priority).toBe("medium");
    expect(t.labels).toEqual([]);
    expect(t.depends_on).toEqual([]);
  });

  it("スキーマにないキーは残る（DT-2）", () => {
    const t = ticketSchema.parse({
      id: "t1",
      project: "default",
      title: "x",
      status: "todo",
      estimate: 3,
      created_at: "2026-10-31T04:00:00Z",
      updated_at: "2026-10-31T04:00:00Z",
    });
    expect(t["estimate"]).toBe(3);
  });

  it("日時は文字列のまま保つ", () => {
    const t = ticketSchema.parse({
      id: "t1",
      project: "default",
      title: "x",
      status: "todo",
      created_at: "2026-10-31T13:00:00+09:00",
      updated_at: "2026-10-31T04:00:00Z",
    });
    expect(t.created_at).toBe("2026-10-31T13:00:00+09:00");
  });

  it("config は入れ子の既定値を持つ", () => {
    const c = defaultConfig();
    expect(c.git.remote).toBe("origin");
    expect(c.commit.mode).toBe("batch");
    const partial = configSchema.parse({ git: { base_branch: "develop" } });
    expect(partial.git.remote).toBe("origin");
    expect(partial.git.base_branch).toBe("develop");
  });

  it("Workflow は形だけを検証し、条件の名前は見ない", () => {
    const w = workflowDefinitionSchema.parse({
      id: "x",
      name: "X",
      reconcile: [{ when: ["unknown_fact"], status: "done" }],
    });
    expect(w.reconcile[0]?.when).toEqual(["unknown_fact"]);
    expect(() =>
      workflowDefinitionSchema.parse({ id: "x", name: "X", labels: { nope: "a" } }),
    ).toThrow();
  });
});
