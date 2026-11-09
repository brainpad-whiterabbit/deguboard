import { describe, expect, it } from "vitest";
import {
  configFields,
  configSchema,
  defaultConfig,
  flattenConfig,
  nestedConfigValue,
  overlayLocalConfig,
} from "./config.js";
import { planSchema } from "./plan.js";
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

  it("configFields は項目ごとの範囲（scope）を持ち、個人で上書きできるのは人ごとに違ってよい項目だけ", () => {
    const local = configFields()
      .filter((f) => f.scope === "local")
      .map((f) => f.key);
    expect(local).toEqual([
      "default_project",
      "git.remote",
      "worktree.root",
      "commit.mode",
      "push.mode",
      "notify.approvals",
      "actions.shell",
      "models.light",
      "models.standard",
      "models.heavy",
    ]);
    for (const key of [
      "git.base_branch",
      "metrics.read_transcripts",
      "auto.merge",
      "actor.human_only",
    ])
      expect(configFields().find((f) => f.key === key)?.scope).toBe("team");
  });

  it("flattenConfig と nestedConfigValue は入れ子とドット区切りを行き来し、空になった入れ子は消す", () => {
    expect(
      flattenConfig({ commit: { mode: "each" }, actions: { test: ["a", "b"] }, x: 1 }),
    ).toEqual({
      "commit.mode": "each",
      "actions.test": ["a", "b"],
      x: 1,
    });
    expect(nestedConfigValue({ mode: "batch", extra: 1 }, ["mode"], "each")).toEqual({
      mode: "each",
      extra: 1,
    });
    expect(nestedConfigValue(undefined, ["light"], "sonnet")).toEqual({ light: "sonnet" });
    expect(nestedConfigValue({ mode: "each" }, ["mode"], undefined)).toBeUndefined();
    expect(nestedConfigValue({ mode: "each", extra: 1 }, ["mode"], undefined)).toEqual({
      extra: 1,
    });
    expect(nestedConfigValue("x", [], "y")).toBe("y");
  });

  it("overlayLocalConfig は上書きできる項目でスキーマに合う値だけを重ね、チーム専用・未知・不正な値は理由つきで無視する", () => {
    const team = configSchema.parse({ commit: { mode: "batch" }, models: { light: "haiku" } });
    const { config, local, ignored } = overlayLocalConfig(team, {
      commit: { mode: "each" },
      models: { heavy: "opus" },
      push: { mode: "なし" },
      auto: { merge: true },
      metrics: { read_transcripts: true },
      nope: { x: 1 },
    });
    expect(config.commit.mode).toBe("each");
    expect(config.models).toEqual({ light: "haiku", standard: "", heavy: "opus" });
    expect(config.push.mode).toBe("auto");
    expect(config.auto.merge).toBe(false);
    expect(config.metrics.read_transcripts).toBe(false);
    expect(local).toEqual({ "commit.mode": "each", "models.heavy": "opus" });
    expect(ignored.map((i) => i.key)).toEqual([
      "push.mode",
      "auto.merge",
      "metrics.read_transcripts",
      "nope.x",
    ]);
    expect(ignored.find((i) => i.key === "auto.merge")?.reason).toContain("チーム専用");
    expect(ignored.find((i) => i.key === "nope.x")?.reason).toContain("スキーマにない");
    expect(ignored.find((i) => i.key === "push.mode")?.reason).toContain("値が正しくない");
    // 個人のファイルがなければ（undefined）チームの値のまま
    expect(overlayLocalConfig(team, undefined)).toEqual({ config: team, local: {}, ignored: [] });
  });

  it("configFields は config の全項目を既定値・型・説明つきで出す", () => {
    const fields = configFields();
    expect(fields.map((f) => f.key)).toEqual([
      "default_project",
      "git.remote",
      "git.base_branch",
      "worktree.root",
      "commit.mode",
      "push.mode",
      "metrics.read_transcripts",
      "notify.approvals",
      "actions.shell",
      "actions.test",
      "auto.merge",
      "review.heavy_categories",
      "lint.require_iteration",
      "models.light",
      "models.standard",
      "models.heavy",
      "actor.human_only",
      "priority.high",
      "priority.medium",
      "priority.low",
    ]);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    expect(byKey.get("commit.mode")).toMatchObject({
      type: "enum",
      options: ["each", "batch", "manual"],
      default: "batch",
    });
    expect(byKey.get("auto.merge")).toMatchObject({ type: "boolean", default: false });
    expect(byKey.get("notify.approvals")).toMatchObject({ type: "boolean", default: true });
    expect(byKey.get("actions.test")).toMatchObject({ type: "list", default: [] });
    expect(byKey.get("git.remote")).toMatchObject({ type: "string", default: "origin" });
    for (const tier of ["light", "standard", "heavy"])
      expect(byKey.get(`models.${tier}`)).toMatchObject({ type: "string", default: "" });
    for (const f of fields) expect(f.description, f.key).not.toBe("");
  });

  it("configFields の clears_to_default は、既定が空でない文字列の項目だけ true（config.set と設定画面が空の値の扱いをこれで決める）", () => {
    const fields = configFields();
    expect(fields.filter((f) => f.clears_to_default).map((f) => f.key)).toEqual([
      "default_project",
      "git.remote",
      "git.base_branch",
      "worktree.root",
      "priority.high",
      "priority.medium",
      "priority.low",
    ]);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    // 既定が空の文字列・選択肢・真偽値・配列は false
    for (const key of ["models.light", "commit.mode", "auto.merge", "actions.test"])
      expect(byKey.get(key)?.clears_to_default, key).toBe(false);
  });

  it("Plan の details.<ticket>.tier は light / standard / heavy だけを受け、それ以外は読む側でも拒否する（PL-1）", () => {
    const base = { id: "p1", project: "default", tickets: ["t1"] };
    for (const tier of ["light", "standard", "heavy"]) {
      const p = planSchema.parse({ ...base, details: { t1: { tier } } });
      expect(p.details["t1"]?.tier).toBe(tier);
    }
    // tier を省いた details も読め、details 自体がなければ空になる
    expect(planSchema.parse({ ...base, details: { t1: { scope: "範囲" } } }).details).toEqual({
      t1: { scope: "範囲" },
    });
    expect(planSchema.parse(base).details).toEqual({});
    expect(() => planSchema.parse({ ...base, details: { t1: { tier: "huge" } } })).toThrow();
    expect(() => planSchema.parse({ ...base, details: { t1: { tier: "" } } })).toThrow();
    expect(() => planSchema.parse({ ...base, details: { t1: { tier: 1 } } })).toThrow();
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
    // retry_reasons より前に書いた Run（キーがない）は空の配列にそろえる
    expect(r.retry_reasons).toEqual([]);
    expect(runSchema.parse({ ...base, retry_reasons: ["検査が落ちた"] }).retry_reasons).toEqual([
      "検査が落ちた",
    ]);
    // tools より前に書いた Run（キーがない）は null にそろえ、ある Run は回数を読む
    expect(r.tools).toBeNull();
    const tools = {
      read: 3,
      search: 2,
      write: 1,
      bash: 4,
      other: 0,
      read_before_write: 2,
      search_before_write: 2,
    };
    expect(runSchema.parse({ ...base, tools }).tools).toEqual(tools);
    expect(runSchema.safeParse({ ...base, tools: { ...tools, read: -1 } }).success).toBe(false);
    // null を省いたり、0 未満や知らない結果を書いたりはできない
    const { model: _model, ...noModel } = base;
    expect(runSchema.safeParse(noModel).success).toBe(false);
    expect(runSchema.safeParse({ ...base, result: "done" }).success).toBe(false);
    expect(runSchema.safeParse({ ...base, usage: { ...base.usage, input: -1 } }).success).toBe(
      false,
    );
  });
});
