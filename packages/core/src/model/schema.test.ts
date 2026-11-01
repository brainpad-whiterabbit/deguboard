import { describe, expect, it } from "vitest";
import { configSchema, defaultConfig } from "./config.js";
import { emptyUsage, isRunId, newRunId, runSchema } from "./run.js";
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

  it("Run の ID は開始日時と乱数で作り、辞書順が開始の順になる", () => {
    const a = newRunId(new Date("2026-10-31T04:15:00.123Z"), new Uint8Array([0x3f, 0xa2]));
    expect(a).toBe("r20261031-041500-3fa2");
    expect(isRunId(a)).toBe(true);
    const b = newRunId(new Date("2026-10-31T13:00:00Z"));
    expect(isRunId(b)).toBe(true);
    expect([b, a].sort()).toEqual([a, b]);
    expect(isRunId("r1")).toBe(false);
  });

  it("Run は取れなかった値の null と推定の印を保ち、スキーマにないキーを残す", () => {
    const base = {
      id: "r20261031-041500-3fa2",
      ticket: "t12",
      step: "implement",
      agent: "claude-code",
      model: null,
      started_at: "2026-10-31T04:15:00Z",
      finished_at: null,
      result: null,
      error: null,
      retries: 0,
      usage: { ...emptyUsage(), input: 1200, estimated: true, reasoning: 5 },
      files: ["src/a.ts"],
    };
    const r = runSchema.parse(base);
    expect(r.model).toBeNull();
    expect(r.usage.output).toBeNull();
    expect(r.usage.estimated).toBe(true);
    expect(r.usage["reasoning"]).toBe(5);
    expect(r["files"]).toEqual(["src/a.ts"]);
    // null を省いたり、0 未満や知らない結果を書いたりはできない
    const { model: _model, ...noModel } = base;
    expect(runSchema.safeParse(noModel).success).toBe(false);
    expect(runSchema.safeParse({ ...base, result: "done" }).success).toBe(false);
    expect(runSchema.safeParse({ ...base, usage: { ...base.usage, input: -1 } }).success).toBe(
      false,
    );
  });
});
