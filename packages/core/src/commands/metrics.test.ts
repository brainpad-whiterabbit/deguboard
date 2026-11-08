import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { recordBaseline } from "../git/outside.js";
import { emptyUsage } from "../model/run.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { epicAdd, epicCreate } from "./epic.js";
import { findCommand } from "./index.js";
import { metricsShow } from "./metrics.js";
import { commit, init } from "./setup.js";
import { ticketCreate } from "./ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** t1（e1）・t2 を起票し、Run を 3 つ runs/ に直接置いてコミットする（Run を作るコマンドはまだない） */
async function scenario(): Promise<CommandContext> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "human" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  const ctx = await openContext({ cwd: f.cloneA, actor });
  await runCommand(ticketCreate, ctx, { title: "A" });
  await runCommand(ticketCreate, ctx, { title: "B" });
  await runCommand(epicCreate, ctx, { title: "E" });
  await runCommand(epicAdd, ctx, { epic: "e1", tickets: ["t1"] });
  const base = {
    step: "implement",
    agent: "claude-code",
    model: "opus",
    started_at: "2026-10-31T04:00:00Z",
    finished_at: "2026-10-31T04:10:00Z",
    result: "success",
    error: null,
    retries: 0,
  };
  await ctx.store.create("run", {
    ...base,
    id: "r20261031-040000-0001",
    ticket: "t1",
    usage: { input: 1000, output: 100, cache_read: 50, cache_write: null },
    tools: {
      read: 5,
      search: 3,
      write: 2,
      bash: 4,
      other: 1,
      read_before_write: 4,
      search_before_write: 3,
    },
  });
  await ctx.store.create("run", {
    ...base,
    id: "r20261031-050000-0002",
    ticket: "t1",
    step: "review",
    model: "sonnet",
    result: "failure",
    usage: { ...emptyUsage(), input: 200, estimated: true },
  });
  await ctx.store.create("run", {
    ...base,
    id: "r20261031-060000-0003",
    ticket: "t2",
    agent: "codex",
    model: null,
    finished_at: null,
    result: null,
    usage: emptyUsage(),
  });
  // ストアに直に置いた Run を dg の書き込みとみなす（dg の外の変更の検査の基準。ADR-021）
  await recordBaseline(ctx.repo);
  await runCommand(commit, ctx, {});
  return ctx;
}

describe("metrics show", () => {
  it("Run を集計し、null は足さずに欠けた数を返し、推定を含む Run を数える。ツールの回数のない Run は tools の欠けに数える", async () => {
    const ctx = await scenario();
    const r = await runCommand(metricsShow, ctx, {});
    expect(r.write).toBeUndefined();
    expect(r.data).toMatchObject({
      filter: {},
      by: null,
      total: {
        runs: 3,
        results: { success: 1, failure: 1, interrupted: 0, unfinished: 1 },
        duration_seconds: 1200,
        input: 1200,
        output: 100,
        cache_read: 50,
        cache_write: null,
        tools: {
          read: 5,
          search: 3,
          write: 2,
          bash: 4,
          other: 1,
          read_before_write: 4,
          search_before_write: 3,
        },
        missing: {
          duration_seconds: 1,
          input: 1,
          output: 2,
          cache_read: 2,
          cache_write: 3,
          tools: 2,
        },
        estimated_runs: 1,
      },
      groups: [],
    });
  });

  it("すべての単位で絞り込み・集計でき、ID は番号だけでも受け付ける", async () => {
    const ctx = await scenario();
    const runsOf = async (input: object) =>
      (await runCommand(metricsShow, ctx, input)).data.total.runs;
    expect(await runsOf({ run: "r20261031-050000-0002" })).toBe(1);
    expect(await runsOf({ ticket: "1" })).toBe(2);
    expect(await runsOf({ epic: "e1" })).toBe(2);
    expect(await runsOf({ iteration: "s1" })).toBe(0);
    expect(await runsOf({ project: "default" })).toBe(3);
    expect(await runsOf({ agent: "codex" })).toBe(1);
    expect(await runsOf({ model: "opus" })).toBe(1);
    expect(await runsOf({ step: "review" })).toBe(1);
    expect(await runsOf({ step: "implement", ticket: "t1" })).toBe(1);

    const byEpic = (await runCommand(metricsShow, ctx, { by: "epic" })).data;
    expect(byEpic.groups.map((g) => [g.key, g.runs, g.input])).toEqual([
      ["e1", 2, 1200],
      [null, 1, null],
    ]);
    const byModel = (await runCommand(metricsShow, ctx, { ticket: "t1", by: "model" })).data;
    expect(byModel.filter).toEqual({ ticket: "t1" });
    expect(byModel.groups.map((g) => g.key)).toEqual(["opus", "sonnet"]);

    const byStep = (await runCommand(metricsShow, ctx, { by: "step" })).data;
    expect(byStep.groups.map((g) => [g.key, g.runs, g.input])).toEqual([
      ["implement", 2, 1000],
      ["review", 1, 200],
    ]);
    const reviewOnly = (await runCommand(metricsShow, ctx, { step: "review" })).data;
    expect(reviewOnly.filter).toEqual({ step: "review" });
    expect(reviewOnly.total).toMatchObject({ runs: 1, input: 200, estimated_runs: 1 });

    await expect(runCommand(metricsShow, ctx, { epic: "x" })).rejects.toMatchObject({
      name: "UsageError",
    });
    await expect(runCommand(metricsShow, ctx, { by: "day" })).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("集計値をファイルに保存せず、データの作業ツリーを変えない", async () => {
    const ctx = await scenario();
    const before = await readdir(ctx.repo.dataDir, { recursive: true });
    await runCommand(metricsShow, ctx, { by: "ticket" });
    expect(await readdir(ctx.repo.dataDir, { recursive: true })).toEqual(before);
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect(await readdir(path.join(ctx.repo.dataDir, "runs"))).toHaveLength(3);
  });

  it("集計に入った Run のチケットが見つからないときだけ、単位ごとの集計などで警告する", async () => {
    const ctx = await scenario();
    await ctx.store.create("run", {
      id: "r20261031-070000-0004",
      ticket: "t9",
      step: "implement",
      agent: "claude-code",
      model: null,
      started_at: "2026-10-31T07:00:00Z",
      finished_at: null,
      result: null,
      error: null,
      retries: 0,
      usage: emptyUsage(),
    });
    await recordBaseline(ctx.repo);
    expect((await runCommand(metricsShow, ctx, {})).warnings).toEqual([]);
    const r = await runCommand(metricsShow, ctx, { by: "project" });
    expect(r.warnings[0]).toContain("t9");
    expect(r.data.groups.at(-1)).toMatchObject({ key: null, runs: 1 });
    // 絞り込みで外れた Run のチケットは警告しない
    expect((await runCommand(metricsShow, ctx, { ticket: "t1", by: "epic" })).warnings).toEqual([]);
    expect((await runCommand(metricsShow, ctx, { epic: "e1" })).warnings).toEqual([]);
    expect((await runCommand(metricsShow, ctx, { agent: "codex", by: "agent" })).warnings).toEqual(
      [],
    );
    expect(findCommand("metrics.show")).toBe(metricsShow);
  });
});
