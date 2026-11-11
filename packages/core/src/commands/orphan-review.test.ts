import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { resetGhCache } from "../git/facts.js";
import { runGit } from "../git/run.js";
import type { Run, RunReview } from "../model/run.js";
import { amendRunning, bindTranscript } from "../run/record.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { gate, type GateView } from "./gate.js";
import { next, type NextStep } from "./next.js";
import { orphanReviewRuns, orphanReviewsOf } from "./orphan-review.js";
import { runReviewResult, runStart } from "./run.js";
import { init } from "./setup.js";
import { ticketClaim, ticketCreate, ticketUpdate } from "./ticket.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const passed: RunReview = { heavy: 0, light: 0, passed: true };
const heavy: RunReview = { heavy: 1, light: 0, passed: false };

describe("持ち主のない保留から見直しの記録を作る（orphanReviewsOf。t699）", () => {
  const round = (at: string, review: RunReview, run: Run["id"] | null = null) => ({
    run,
    at,
    review,
  });

  it("結果を書いた時刻に閉じた、通った見直しとして作る", () => {
    const [r] = orphanReviewsOf("t1", [round("2026-11-07T10:06:00Z", passed)], undefined, []);
    expect(r).toMatchObject({
      ticket: "t1",
      step: "review",
      started_at: "2026-11-07T10:06:00Z",
      finished_at: "2026-11-07T10:06:00Z",
      result: "success",
      review: passed,
    });
  });

  it("同じ push の後の保留は最新の 1 件だけ、push をまたぐ保留は別の回にする", () => {
    const rounds = [
      round("2026-11-07T10:06:00Z", heavy),
      round("2026-11-07T10:07:00Z", heavy),
      round("2026-11-07T10:12:00Z", heavy),
      round("2026-11-07T10:13:00Z", passed),
    ];
    const made = orphanReviewsOf("t1", rounds, undefined, [
      "2026-11-07T10:05:00Z",
      "2026-11-07T10:10:00Z",
    ]);
    expect(made.map((r) => [r.started_at, r.review?.passed])).toEqual([
      ["2026-11-07T10:07:00Z", false],
      ["2026-11-07T10:13:00Z", true],
    ]);
    // コミットの時刻が読めなければ区切りがなく、最新の 1 件だけ
    expect(orphanReviewsOf("t1", rounds, undefined, []).map((r) => r.started_at)).toEqual([
      "2026-11-07T10:13:00Z",
    ]);
  });

  it("Run に結び付いた回と、作業ブランチ（branch_at）より前の回は数えない", () => {
    const made = orphanReviewsOf(
      "t1",
      [
        round("2026-11-07T09:00:00Z", passed),
        round("2026-11-07T10:06:00Z", heavy, "r20261107-100600-0001"),
      ],
      "2026-11-07T10:00:00Z",
      [],
    );
    expect(made).toEqual([]);
  });
});

/** 偽の gh。PR #7 は開いた draft でない PR */
async function fakeGh(root: string) {
  const bin = path.join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const json = JSON.stringify({ number: 7, state: "OPEN", isDraft: false, mergeable: "MERGEABLE" });
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
      'case "$3" in',
      `  feat/t1|7) echo '${json}';;`,
      '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const saved = process.env["PATH"];
  process.env["PATH"] = bin + path.delimiter + (saved ?? "");
  resetGhCache();
  cleanups.push(() => {
    process.env["PATH"] = saved;
    resetGhCache();
  });
}

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("dg next と dg gate が持ち主のない保留を見直しとして数える（t699）", () => {
  /** t1 を feat/t1 で Run なしに claim し、1 コミット push して PR #7 を記録した文脈（フックのない環境） */
  async function prepared() {
    const f = await createFixture();
    cleanups.push(f.cleanup);
    const actor = { kind: "agent" as const, user: "eiki" };
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {
      template: "software-development",
    });
    const ctx: CommandContext = await openContext({ cwd: f.cloneA, actor });
    await runCommand(ticketCreate, ctx, { title: "A" });
    // 作業ブランチ（branch_at）を 2 時間前からにする（push より前の保留を作業ブランチの中に置くため）
    ctx.now = () => later(-120);
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "feat/t1",
      no_run: true,
    });
    await git(f.cloneA, ["checkout", "-qb", "feat/t1"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    await git(f.cloneA, ["push", "-q", "origin", "feat/t1"]);
    await fakeGh(f.root);
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 7 });
    /** コミッタの時刻を at にした直しを push する */
    const pushAt = async (at: Date) => {
      await runGit(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "直し"], {
        env: { GIT_COMMITTER_DATE: at.toISOString() },
      });
      await git(f.cloneA, ["push", "-q", "origin", "feat/t1"]);
    };
    return { ctx, pushAt };
  }

  /** Run のないまま見直しの結果を書く（保留になる）。at は書いた時刻 */
  async function hold(ctx: CommandContext, at: Date, withHeavy: boolean) {
    ctx.now = () => at;
    const out = await runCommand(runReviewResult, ctx, {
      ticket: "t1",
      findings: withHeavy
        ? [
            {
              severity: "heavy",
              category: "不具合",
              file: null,
              line: null,
              reason: "壊れる",
              fix: null,
            },
          ]
        : [],
    });
    expect(out.data).toMatchObject({ pending: true });
  }

  const stepOf = async (ctx: CommandContext) =>
    (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
  const judge = async (ctx: CommandContext) =>
    (await runCommand(gate, ctx, { ticket: "t1", for: "ready" })).data as GateView;
  const condition = (view: GateView, id: string) => view.conditions.find((c) => c.id === id)!;

  it("通った保留なら next は reviewed（通った）で ready を返し、gate --for ready が通る", async () => {
    const { ctx } = await prepared();
    await hold(ctx, later(1), false);
    expect(await stepOf(ctx)).toMatchObject({
      kind: "ready",
      stage: { name: "reviewed", reviews: 1, review_passed: true },
    });
    const view = await judge(ctx);
    expect(view.passed).toBe(true);
    expect(condition(view, "review").detail).toContain("held review result written at");
  });

  it("重い指摘の保留なら next は fix を返し、gate は review で落ちて fix_rounds に数える", async () => {
    const { ctx } = await prepared();
    await hold(ctx, later(1), true);
    expect(await stepOf(ctx)).toMatchObject({
      kind: "fix",
      stage: { name: "reviewed", fixes: 1, review_passed: false },
    });
    const view = await judge(ctx);
    expect(condition(view, "review")).toMatchObject({ ok: false });
    expect(condition(view, "fix_rounds").detail).toContain("1 review rounds");
  });

  it("結果を書いた時刻が作業ブランチの先頭の push より前の保留は、今の見直しに数えない", async () => {
    const { ctx } = await prepared();
    await hold(ctx, later(-60), false);
    expect(await stepOf(ctx)).toMatchObject({ kind: "review", stage: { name: "fixed" } });
    expect(condition(await judge(ctx), "review")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("No review after the last push"),
    });
  });

  it("同じ push の後の保留は最新の 1 件だけを数え、push をまたぐ保留は別の回に数える", async () => {
    const { ctx, pushAt } = await prepared();
    // 同じ push の後：重い指摘の後に通った結果を書き直したら、最新の通った 1 件だけ（重い回を数えない）
    await hold(ctx, later(1), true);
    await hold(ctx, later(2), false);
    let view = await judge(ctx);
    expect(view.passed).toBe(true);
    expect(condition(view, "fix_rounds").detail).toContain("0 review rounds");
    // push をまたぐ：重い指摘の後に直しを push し、通った結果を書けば、重い回は 1 回
    await hold(ctx, later(3), true);
    await pushAt(later(4));
    await hold(ctx, later(5), false);
    view = await judge(ctx);
    expect(view.passed).toBe(true);
    expect(condition(view, "fix_rounds").detail).toContain("1 review rounds");
    expect(await stepOf(ctx)).toMatchObject({
      kind: "ready",
      stage: { reviews: 2, fixes: 1 },
    });
  });

  it("見直しの Run が開いているか、動いているサブエージェントの印があれば、保留を数えない", async () => {
    const { ctx } = await prepared();
    await hold(ctx, later(1), false);
    const ticket = ctx.store.require("ticket", "t1").data;
    // 開いた見直しの Run がある（フックがこれから結び付ける）
    ctx.now = () => later(2);
    const reviewRun = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data as Run;
    expect(await orphanReviewRuns(ctx, ticket, [reviewRun])).toEqual([]);
    expect(condition(await judge(ctx), "review").detail).toContain("has not finished");
    // 動いているサブエージェントの印がある Run（見直し以外）がある。止まって待つ印が付けば数える
    const implement = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "implement", agent: "claude-code" })
    ).data as Run;
    await bindTranscript(ctx.repo, implement.id, path.join(ctx.repo.localDir, "a.jsonl"), true);
    expect(await orphanReviewRuns(ctx, ticket, [implement])).toEqual([]);
    const waiting = await amendRunning(ctx.repo, implement.id, {
      waiting_since: later(3).toISOString(),
    });
    expect(await orphanReviewRuns(ctx, ticket, [waiting])).toHaveLength(1);
  });
});
