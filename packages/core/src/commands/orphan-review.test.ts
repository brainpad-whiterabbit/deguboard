import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { resetGhCache } from "../git/facts.js";
import { runGit } from "../git/run.js";
import { runSchema, type Run, type RunReview } from "../model/run.js";
import { amendRunning, bindTranscript, readReviewFindings } from "../run/record.js";
import { runPath } from "../storage/paths.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { gate, type GateView } from "./gate.js";
import { next, type NextStep } from "./next.js";
import { orphanReviewRuns, orphanReviewsOf } from "./orphan-review.js";
import { prReady, type PrAdvanceView } from "./pr.js";
import { runFinish, runReviewResult, runStart } from "./run.js";
import { init, lint, sync } from "./setup.js";
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
      // dg pr ready が読む PR の本文（gh api）。本文は空
      `case "$1" in api) echo '{"body":""}'; exit 0;; esac`,
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
  return { f, ctx, pushAt };
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

describe("dg next と dg gate が持ち主のない保留を見直しとして数える（t699）", () => {
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

describe("dg sync と dg pr ready が持ち主のない保留を見直しの記録として書く（t700）", () => {
  /** チケットの Run の、Git に書いたファイルの中身（キーの有無を見る） */
  const rawRuns = async (ctx: CommandContext) =>
    Promise.all(
      [...ctx.store.runs.values()]
        .filter((d) => d.data.ticket === "t1")
        .map(
          async (d) =>
            JSON.parse(
              await readFile(path.join(ctx.repo.dataDir, runPath(d.id)), "utf8"),
            ) as Record<string, unknown>,
        ),
    );
  const heldRounds = async (ctx: CommandContext) =>
    ((await readReviewFindings(ctx.repo, "t1"))?.rounds ?? []).filter((r) => r.run === null);
  /** next の段階と、gate の条件ごとの成否（記録の ID を含む文は比べない） */
  const judgment = async (ctx: CommandContext) => {
    const step = await stepOf(ctx);
    const view = await judge(ctx);
    const { reason: _, ...stage } = step.stage as unknown as Record<string, unknown>;
    return {
      kind: step.kind,
      stage,
      passed: view.passed,
      conditions: view.conditions.map((c) => [c.id, c.ok]),
    };
  };
  /**
   * prepared の後に一度 sync した文脈。PR の照合（draft でない PR #7 で review に進む）を先に済ませ、
   * 書く前と後の判定の違いを記録を書いたことだけにする
   */
  const synced = async () => {
    const p = await prepared();
    await runCommand(sync, p.ctx, {});
    return p;
  };

  it("sync が保留を、結果を書いた時刻に閉じた capture: none の見直しの Run として書き、保留を結び付ける。判定は書く前と同じ", async () => {
    const { ctx } = await synced();
    const at = later(1);
    await hold(ctx, at, false);
    const before = await judgment(ctx);
    const out = (await runCommand(sync, ctx, {})).data as {
      reviews_recorded: Array<{ id: string; run: string }>;
    };
    expect(out.reviews_recorded).toEqual([{ id: "t1", run: expect.stringMatching(/^r/) }]);
    const [raw] = await rawRuns(ctx);
    expect(raw).toMatchObject({
      id: out.reviews_recorded[0]!.run,
      step: "review",
      started_at: at.toISOString().replace(/\.\d+Z$/, "Z"),
      finished_at: at.toISOString().replace(/\.\d+Z$/, "Z"),
      result: "success",
      usage: { input: null, output: null, cache_read: null, cache_write: null },
      review: passed,
      capture: "none",
    });
    // 閉じた Run には実行中の印を書かない
    expect(raw).not.toHaveProperty("waiting_since");
    expect(await heldRounds(ctx)).toEqual([]);
    expect(await judgment(ctx)).toEqual(before);
    // もう一度の sync は書き足さない
    const again = (await runCommand(sync, ctx, {})).data as { reviews_recorded: unknown[] };
    expect(again.reviews_recorded).toEqual([]);
    expect(await rawRuns(ctx)).toHaveLength(1);
  });

  it("Git に書いた後で保留を結び付け損ねても、次の sync は書き直さずに結び付けだけをやり直す", async () => {
    const { ctx } = await synced();
    await hold(ctx, later(1), false);
    const file = path.join(ctx.repo.localDir, "review-findings", "t1.json");
    const held = await readFile(file, "utf8");
    await runCommand(sync, ctx, {});
    const before = await judgment(ctx);
    // 結び付ける前に止まった残り：保留の回を書く前の形に戻す
    await writeFile(file, held);
    expect(await heldRounds(ctx)).toHaveLength(1);
    const out = (await runCommand(sync, ctx, {})).data as { reviews_recorded: unknown[] };
    expect(out.reviews_recorded).toEqual([]);
    expect(await rawRuns(ctx)).toHaveLength(1);
    expect(await heldRounds(ctx)).toEqual([]);
    expect(await judgment(ctx)).toEqual(before);
  });

  it("同じ push の後に書き直した保留は最新の 1 件だけを書き、ほかの保留の回も外す", async () => {
    const { ctx } = await synced();
    await hold(ctx, later(1), true);
    await hold(ctx, later(2), false);
    const before = await judgment(ctx);
    await runCommand(sync, ctx, {});
    const runs = await rawRuns(ctx);
    expect(runs.map((r) => r["review"])).toEqual([passed]);
    expect((await readReviewFindings(ctx.repo, "t1"))?.rounds).toHaveLength(1);
    expect(await judgment(ctx)).toEqual(before);
  });

  it("capture は保留から作った記録にだけ付き、ほかの Run には付かない。項目のない Run は今までどおり読める", async () => {
    const { ctx } = await prepared();
    ctx.now = () => later(1);
    const implement = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "implement", agent: "claude-code" })
    ).data as Run;
    await runCommand(runFinish, ctx, { run: implement.id, result: "success" });
    await hold(ctx, later(2), false);
    await runCommand(sync, ctx, {});
    const runs = await rawRuns(ctx);
    expect(runs.find((r) => r["step"] === "implement")).not.toHaveProperty("capture");
    expect(runs.find((r) => r["step"] === "review")).toMatchObject({ capture: "none" });
    const { capture: _, ...old } = runs.find((r) => r["step"] === "review")!;
    expect(runSchema.parse(old).capture).toBeUndefined();
  });

  it("フックなしの通し（claim --no-run → 保留 → 直しの push → 保留 → pr ready）が、保留のない別の clone でも gate を通る", async () => {
    const { f, ctx, pushAt } = await prepared();
    await hold(ctx, later(1), true);
    await pushAt(later(2));
    await hold(ctx, later(3), false);
    const before = await judgment(ctx);
    expect(before.passed).toBe(true);
    ctx.now = () => later(4);
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready.reviews_recorded).toHaveLength(2);
    expect(await heldRounds(ctx)).toEqual([]);
    expect(await judgment(ctx)).toEqual(before);
    // まとめ待ちの書き込み（commit.mode）をリモートに送る
    await runCommand(sync, ctx, {});
    const other = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    await runCommand(sync, other, {});
    expect(await heldRounds(other)).toEqual([]);
    const view = await judge(other);
    expect(view.passed).toBe(true);
    expect(condition(view, "fix_rounds").detail).toContain("1 review rounds");
  });

  it("dg の外の変更があっても、書く保留がなければ pr ready は警告で PR を開き、書く保留があれば OUTSIDE_CHANGES で止める", async () => {
    const { ctx } = await synced();
    await hold(ctx, later(1), false);
    await runCommand(sync, ctx, {});
    const file = path.join(ctx.repo.dataDir, "tickets", "t1.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("title: A", "title: 書き換えた"));
    const opened = await runCommand(prReady, ctx, { ticket: "t1" });
    expect((opened.data as PrAdvanceView).reviews_recorded).toEqual([]);
    expect(opened.warnings).toEqual([
      expect.stringContaining("changes made outside dg (Uncommitted changes: tickets/t1.md)"),
    ]);
    // 書く保留があるときは、ロックの中の検査で書く前に止め、保留を残す
    await writeFile(file, text);
    await hold(ctx, later(2), false);
    await writeFile(file, text.replace("title: A", "title: 書き換えた"));
    await expect(runCommand(prReady, ctx, { ticket: "t1" })).rejects.toMatchObject({
      code: "OUTSIDE_CHANGES",
    });
    expect(await heldRounds(ctx)).toHaveLength(1);
  });
});

describe("フックが結ばなかった見直しの記録（capture: none）の警告と抜け（t702）", () => {
  /** フックを持つ Claude Code のセッション（このセッションにはフックが届いていない） */
  const hooked = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-702" };
  const WARNING = "were counted as review(s) with no Run linked by a dg hook (capture: none)";
  const nextWarnings = async (ctx: CommandContext) =>
    (await runCommand(next, ctx, { ticket: "t1" })).warnings;
  const gateWarnings = async (ctx: CommandContext) =>
    (await runCommand(gate, ctx, { ticket: "t1", for: "ready" })).warnings;

  it("持ち主のない保留を数えるとき、フックを持つエージェントでは next と gate が警告し、フックを持たない環境では警告しない", async () => {
    const { ctx } = await prepared();
    await hold(ctx, later(1), false);
    ctx.env = hooked;
    expect(await nextWarnings(ctx)).toContainEqual(expect.stringContaining(WARNING));
    expect(await gateWarnings(ctx)).toContainEqual(
      expect.stringContaining("1 review result(s) of t1 were counted"),
    );
    ctx.env = {};
    expect((await nextWarnings(ctx)).some((w) => w.includes(WARNING))).toBe(false);
    expect((await gateWarnings(ctx)).some((w) => w.includes(WARNING))).toBe(false);
  });

  it("sync が書いた capture: none の記録を数えるときも、フックを持つエージェントでは next と gate が警告する", async () => {
    const { ctx } = await prepared();
    await hold(ctx, later(1), false);
    await runCommand(sync, ctx, {});
    ctx.env = hooked;
    expect(await nextWarnings(ctx)).toContainEqual(expect.stringContaining(WARNING));
    expect(await gateWarnings(ctx)).toContainEqual(expect.stringContaining(WARNING));
  });

  it("lint は、フックが結ばなかった見直しの記録があるチケットの実装・手直しの Run の抜けを指摘しない", async () => {
    const { ctx, pushAt } = await prepared();
    const runIssues = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.id === "t1" && i.code.startsWith("lint_run_"))
        .map((i) => i.code);
    // 記録がないうちは、PR があるのに実装の Run がない抜けを指摘する
    expect(await runIssues()).toEqual(["lint_run_implement_missing"]);
    // 保留を sync が capture: none の記録にし、その後に直しを push する（見直しの後のコミット）
    await hold(ctx, later(1), false);
    await runCommand(sync, ctx, {});
    await pushAt(later(2));
    expect(await runIssues()).toEqual([]);
  });
});
