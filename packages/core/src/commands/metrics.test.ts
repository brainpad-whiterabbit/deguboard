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
import { iterationAdd, iterationClose, iterationCreate, iterationStart } from "./iteration.js";
import { fakeGh } from "../../test/helpers/commands-context.js";
import { metricsLines, metricsShow } from "./metrics.js";
import { commit, init } from "./setup.js";
import { ticketCreate } from "./ticket.js";
import { workflowSet } from "./workflow.js";

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
  // ストアに直に置いた Run を dg の書き込みとみなす（dg の外の変更の検査の基準。SY-8）
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

  it("フックが結ばなかった見直しの記録（capture: none）は見直しの回に数え、使用量・時間・ツールの集計からは外す（t702）", async () => {
    const ctx = await scenario();
    const before = (await runCommand(metricsShow, ctx, {})).data.total;
    await ctx.store.create("run", {
      id: "r20261031-070000-0004",
      ticket: "t1",
      step: "review",
      agent: "unknown",
      model: null,
      started_at: "2026-10-31T07:00:00Z",
      finished_at: "2026-10-31T07:00:00Z",
      result: "success",
      error: null,
      retries: 0,
      usage: emptyUsage(),
      tools: null,
      review: { heavy: 1, light: 2, passed: false },
      capture: "none",
    });
    // ストアに直に置いた Run を dg の書き込みとみなしてから、コミットする（scenario と同じ）
    await recordBaseline(ctx.repo);
    await runCommand(commit, ctx, {});
    const after = (await runCommand(metricsShow, ctx, {})).data.total;
    expect(after).toEqual({
      ...before,
      runs: before.runs + 1,
      results: { ...before.results, success: before.results.success + 1 },
      reviews: { recorded: 1, passed: 0, heavy: 1, light: 2 },
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

  it("絞り込みに合う done のチケットのうち、エージェントが claim して実装の Run が 1 件もないものを示す（MT-3）", async () => {
    const ctx = await scenario();
    await runCommand(ticketCreate, ctx, { title: "C" });
    await runCommand(ticketCreate, ctx, { title: "D" });
    await runCommand(iterationCreate, ctx, { name: "I" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t3"] });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    // 完了は dg の外の変更（ストアへの直接の書き込み）として記録する（scenario と同じ）。
    // t4 は人が claim した done。人の claim は Run を開かないので、Run がなくても示さない（RN-5）
    await ctx.store.update("ticket", "t3", { status: "done", assignee: "eiki/agent" });
    await ctx.store.update("ticket", "t4", { status: "done", assignee: "eiki" });
    await recordBaseline(ctx.repo);
    await runCommand(commit, ctx, {});

    // t1 は実装の Run があり、t2 は done でないので示さない。t4 は人の claim なので示さない
    expect((await runCommand(metricsShow, ctx, {})).data.no_runs).toEqual(["t3"]);
    expect((await runCommand(metricsShow, ctx, {})).warnings).toEqual([
      "Done tickets with no implement Run: t3",
    ]);
    expect((await runCommand(metricsShow, ctx, { ticket: "t1" })).data.no_runs).toEqual([]);
    expect((await runCommand(metricsShow, ctx, { epic: "e1" })).data.no_runs).toEqual([]);
    expect((await runCommand(metricsShow, ctx, { project: "default" })).data.no_runs).toEqual([
      "t3",
    ]);
    // Run の条件で絞ったときは、Run のないチケットはどれにも合わないので示さない
    expect((await runCommand(metricsShow, ctx, { step: "implement" })).data.no_runs).toEqual([]);
    expect((await runCommand(metricsShow, ctx, { agent: "codex" })).data.no_runs).toEqual([]);

    // 閉じた Iteration で絞っても示す。done のチケットは閉じても Iteration に残る
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const closed = await runCommand(metricsShow, ctx, { iteration: "s1" });
    expect(closed.data).toMatchObject({ filter: { iteration: "s1" }, no_runs: ["t3"] });
    expect(closed.warnings).toEqual(["Done tickets with no implement Run: t3"]);
  });

  it("実装の Run の step は Workflow の claim が開く step の名前で探す（RN-5）", async () => {
    const ctx = await scenario();
    const projectWorkflow = [...ctx.store.projects.values()][0]?.data.workflow as string;
    await runCommand(workflowSet, ctx, {
      workflow: projectWorkflow,
      definition: {
        id: projectWorkflow,
        name: "renamed",
        transitions: [],
        steps: [{ id: "build", opens_on: "claim" }],
      },
    });
    await runCommand(ticketCreate, ctx, { title: "C" });
    await runCommand(ticketCreate, ctx, { title: "D" });
    // t3 は claim が開く build の Run があり、t4 は implement の Run しかない（build の Run がない）
    await ctx.store.update("ticket", "t3", { status: "done", assignee: "eiki/agent" });
    await ctx.store.update("ticket", "t4", { status: "done", assignee: "eiki/agent" });
    await ctx.store.create("run", {
      id: "r20261031-070000-0004",
      ticket: "t3",
      step: "build",
      agent: "claude-code",
      model: "opus",
      started_at: "2026-10-31T07:00:00Z",
      finished_at: "2026-10-31T07:10:00Z",
      result: "success",
      error: null,
      retries: 0,
      usage: emptyUsage(),
    });
    await ctx.store.create("run", {
      id: "r20261031-080000-0005",
      ticket: "t4",
      step: "implement",
      agent: "claude-code",
      model: "opus",
      started_at: "2026-10-31T08:00:00Z",
      finished_at: "2026-10-31T08:10:00Z",
      result: "success",
      error: null,
      retries: 0,
      usage: emptyUsage(),
    });
    await recordBaseline(ctx.repo);
    await runCommand(commit, ctx, {});

    expect((await runCommand(metricsShow, ctx, {})).data.no_runs).toEqual(["t4"]);
  });

  it("チケットの行数から変更行数と 1 行あたりのトークンを出し、--by iteration で Iteration ごとに比べられる。行数のないチケットは外して数える（MT-6）", async () => {
    const ctx = await scenario();
    await runCommand(iterationCreate, ctx, { name: "I1" });
    await runCommand(iterationCreate, ctx, { name: "I2" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(iterationAdd, ctx, { iteration: "s2", tickets: ["t2"] });
    // t1 はマージされた PR の行数を持つ（+40 -10）。t2 は行数がない
    await ctx.store.update("ticket", "t1", { pr: 7, lines: { additions: 40, deletions: 10 } });
    await recordBaseline(ctx.repo);
    await runCommand(commit, ctx, {});

    const r = await runCommand(metricsShow, ctx, { by: "iteration" });
    // t1 の Run：output 100、input+cache は 1000 + 50 と 200。50 行で割る
    expect(r.data.total.lines).toEqual({
      tickets: 1,
      additions: 40,
      deletions: 10,
      missing: 1,
      per_line: { output: 2, input_cache: 25 },
    });
    expect(r.data.groups.map((g) => [g.key, g.lines])).toEqual([
      [
        "s1",
        {
          tickets: 1,
          additions: 40,
          deletions: 10,
          missing: 0,
          per_line: { output: 2, input_cache: 25 },
        },
      ],
      [
        "s2",
        {
          tickets: 0,
          additions: null,
          deletions: null,
          missing: 1,
          per_line: { output: null, input_cache: null },
        },
      ],
    ]);
    // 工程ごとにも出る（見直しの Run は output がないので、output は実装だけ）
    const byStep = await runCommand(metricsShow, ctx, { iteration: "s1", by: "step" });
    expect(byStep.data.groups.map((g) => [g.key, g.lines.per_line])).toEqual([
      ["implement", { output: 2, input_cache: 21 }],
      ["review", { output: null, input_cache: 4 }],
    ]);
  });
});

describe("metrics lines", () => {
  /** t1〜t4 を done にする。t1 は PR #11（マージ済み）、t2 は PR #12（閉じた）、t3 は PR なし、t4 は PR #14 で行数を記録済み */
  async function doneTickets(): Promise<{ ctx: CommandContext; root: string }> {
    const f = await createFixture();
    cleanups.push(f.cleanup);
    const actor = { kind: "human" as const, user: "eiki" };
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
    const ctx = await openContext({ cwd: f.cloneA, actor });
    for (const title of ["A", "B", "C", "D", "E"]) await runCommand(ticketCreate, ctx, { title });
    await ctx.store.update("ticket", "t1", { status: "done", pr: 11 });
    await ctx.store.update("ticket", "t2", { status: "done", pr: 12 });
    await ctx.store.update("ticket", "t3", { status: "done" });
    await ctx.store.update("ticket", "t4", {
      status: "done",
      pr: 14,
      lines: { additions: 1, deletions: 1 },
    });
    // t5 は PR があるがまだ done でない（照合がマージを見たときに記録する）
    await ctx.store.update("ticket", "t5", { status: "review", pr: 15 });
    await recordBaseline(ctx.repo);
    await runCommand(commit, ctx, {});
    return { ctx, root: f.root };
  }

  const merged = (number: number, additions: number, deletions: number) =>
    JSON.stringify({ number, state: "MERGED", isDraft: false, additions, deletions });

  it("行数のない done のチケットに、マージされた PR の行数を記録する。マージされていない PR は理由を付けて外し、記録済み・PR なし・done でないチケットは読まない", async () => {
    const { ctx, root } = await doneTickets();
    const restore = await fakeGh(root, {
      "11": merged(11, 120, 30),
      "12": JSON.stringify({ number: 12, state: "CLOSED", isDraft: false }),
      "14": merged(14, 999, 999),
      "15": merged(15, 999, 999),
    });
    try {
      const updatedAt = ctx.store.tickets.get("t1")?.data.updated_at;
      const r = await runCommand(metricsLines, ctx, {});
      expect(r.data).toEqual({
        recorded: [{ id: "t1", pr: 11, additions: 120, deletions: 30 }],
        skipped: [{ id: "t2", pr: 12, reason: "PR #12 is not merged (closed)" }],
        remaining: 0,
      });
      expect(r.warnings).toEqual([
        "t2: the changed lines were not recorded (PR #12 is not merged (closed))",
      ]);
      // 書き込みは commit.mode に従う（既定はまとめ待ち）
      expect(r.write).toBeDefined();
      expect(ctx.store.tickets.get("t1")?.data).toMatchObject({
        lines: { additions: 120, deletions: 30 },
        updated_at: updatedAt,
      });
      expect(ctx.store.tickets.get("t2")?.data.lines).toBeUndefined();
      expect(ctx.store.tickets.get("t4")?.data.lines).toEqual({ additions: 1, deletions: 1 });
      expect(ctx.store.tickets.get("t5")?.data.lines).toBeUndefined();

      // もう一度呼ぶと、残るのは取れなかった t2 だけで、何も書かない
      const again = await runCommand(metricsLines, ctx, {});
      expect(again.data.recorded).toEqual([]);
      expect(again.data.skipped.map((s) => s.id)).toEqual(["t2"]);
      expect(again.write).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("limit までを新しいチケットから読み、残りの数を返す。Iteration で絞れる", async () => {
    const { ctx, root } = await doneTickets();
    await runCommand(iterationCreate, ctx, { name: "I" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    const restore = await fakeGh(root, { "11": merged(11, 5, 0), "12": merged(12, 7, 2) });
    try {
      const first = await runCommand(metricsLines, ctx, { limit: 1 });
      expect(first.data.recorded.map((x) => x.id)).toEqual(["t2"]);
      expect(first.data.remaining).toBe(1);
      expect(first.warnings.join("\n")).toContain("1 done tickets with no lines were not read");
      const scoped = await runCommand(metricsLines, ctx, { iteration: "s1" });
      expect(scoped.data).toEqual({
        recorded: [{ id: "t1", pr: 11, additions: 5, deletions: 0 }],
        skipped: [],
        remaining: 0,
      });
    } finally {
      restore();
    }
  });
});
