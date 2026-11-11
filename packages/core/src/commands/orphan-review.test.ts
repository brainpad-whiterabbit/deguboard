import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { resetGhCache } from "../git/facts.js";
import { runGit } from "../git/run.js";
import { toIsoDateTime } from "../model/common.js";
import { runSchema, type Run, type RunReview } from "../model/run.js";
import {
  amendRunning,
  bindTranscript,
  peekRunningRuns,
  readReviewFindings,
  readTranscriptPaths,
} from "../run/record.js";
import { runPath } from "../storage/paths.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { gate, type GateView } from "./gate.js";
import { hook, type HookView } from "./hook.js";
import { next, type NextStep } from "./next.js";
import { adoptableReviewRecord, orphanReviewRuns, orphanReviewsOf } from "./orphan-review.js";
import { prReady, type PrAdvanceView } from "./pr.js";
import { runFinish, runReviewResult, runStart } from "./run.js";
import { configSet, init, sync } from "./setup.js";
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

  it("保留の回のセッションを記録の session に写し、セッションのない前の回は null にする（t701）", () => {
    const made = orphanReviewsOf(
      "t1",
      [
        { ...round("2026-11-07T10:06:00Z", passed), session: "s-a" },
        round("2026-11-07T10:12:00Z", passed),
      ],
      undefined,
      ["2026-11-07T10:10:00Z"],
    );
    expect(made.map((r) => r.session)).toEqual(["s-a", null]);
  });
});

describe("起動のフックが引き取る見直しの記録（adoptableReviewRecord。t701）", () => {
  const record = (over: Partial<Run>): Run => ({
    ...orphanReviewsOf(
      "t1",
      [{ run: null, at: "2026-11-07T10:06:00Z", review: passed }],
      "",
      [],
    )[0]!,
    id: "r20261107-100600-0001",
    session: "s-a",
    ...over,
  });

  it("同じチケット・同じセッションで起動より後（同じ秒を含む）に書かれた capture: none の見直しの記録のうち、最も後のものを引き取る", () => {
    const newer = record({ id: "r20261107-100700-0002", started_at: "2026-11-07T10:07:00Z" });
    expect(
      adoptableReviewRecord([record({}), newer], "t1", "s-a", "2026-11-07T10:06:00Z")?.id,
    ).toBe(newer.id);
  });

  it("別のセッション・セッションの分からない記録・起動より前の記録・印のない Run・ほかのチケットは引き取らない", () => {
    const launchedAt = "2026-11-07T10:05:00Z";
    const { capture: _, ...captured } = record({});
    for (const r of [
      record({ session: "s-b" }),
      record({ session: null }),
      record({ started_at: "2026-11-07T10:04:59Z" }),
      captured,
      record({ ticket: "t2" }),
    ])
      expect(adoptableReviewRecord([r], "t1", "s-a", launchedAt)).toBeUndefined();
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

describe("前景の見直し役が返ったとき、起動のフックが先に書かれた見直しの記録を引き取る（t701）", () => {
  const SESSION = "s-parent";
  const PROMPT = "deguboard: ticket=t1 step=review\n\n見直す";

  /** 一度 sync した prepared に、会話記録を読む設定と HOME（会話記録の置き場所）を足す。review-result のセッションは DEGUBOARD_SESSION */
  const withTranscripts = async () => {
    const p = await prepared();
    await runCommand(sync, p.ctx, {});
    await runCommand(configSet, p.ctx, { key: "metrics.read_transcripts", value: "true" });
    p.ctx.config = p.ctx.store.config;
    const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    p.ctx.env = { HOME: home, DEGUBOARD_SESSION: SESSION };
    const parent = path.join(home, ".claude", "projects", "d", `${SESSION}.jsonl`);
    const transcript = path.join(path.dirname(parent), SESSION, "subagents", "agent-a1.jsonl");
    // 見直し役の記録：頼んだ文と、使用量の付いた応答 2 つ（入力 3 ずつ）
    const response = (id: string) => ({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        id,
        model: "claude-test-1",
        content: "答え",
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(
      transcript,
      [
        { type: "user", timestamp: new Date().toISOString(), message: { content: PROMPT } },
        response("m1"),
        response("m2"),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    return { ...p, parent, transcript };
  };

  /** 前景の起動が返ったときの PostToolUse（SubagentStop は先に来て、閉じる Run がなかった）。at は返った時刻 */
  const returned = async (ctx: CommandContext, parent: string, at: Date, durationMs: number) => {
    ctx.now = () => at;
    const r = await runCommand(hook, ctx, {
      event: "PostToolUse",
      payload: {
        session_id: SESSION,
        transcript_path: parent,
        tool_name: "Agent",
        tool_input: { prompt: PROMPT, description: "x" },
        tool_response: {
          status: "completed",
          agentId: "a1",
          resolvedModel: "claude-test-1",
          totalDurationMs: durationMs,
        },
      },
    });
    return r.data as HookView;
  };

  const reviewRuns = (ctx: CommandContext) =>
    [...ctx.store.runs.values()]
      .filter((d) => d.data.ticket === "t1" && d.data.step === "review")
      .map((d) => d.data);

  it("run review-result が保留の回にセッションを書き、sync が書く記録の session に写す", async () => {
    const { ctx } = await withTranscripts();
    await hold(ctx, later(2), false);
    expect((await readReviewFindings(ctx.repo, "t1"))?.rounds.at(-1)).toMatchObject({
      run: null,
      session: SESSION,
    });
    await runCommand(sync, ctx, {});
    expect(reviewRuns(ctx)).toEqual([
      expect.objectContaining({ capture: "none", session: SESSION }),
    ]);
  });

  it("見直し役が動いている間に sync が保留を記録にしていたら、新しい Run を開かずにその記録へ会話記録を結び、使用量を数え直して capture: none を外し、gate が通る", async () => {
    const { ctx, parent, transcript } = await withTranscripts();
    // 起動は later(1.5)、見直し役が結果を書くのは later(2)、別のプロセスの sync が記録にしてから、later(3) に返る
    await hold(ctx, later(2), false);
    await runCommand(sync, ctx, {});
    const [record] = reviewRuns(ctx);
    expect(record).toMatchObject({ capture: "none", session: SESSION });

    const view = await returned(ctx, parent, later(3), 90_000);
    expect(view.done).toContainEqual(
      expect.stringContaining(`Took over the review record ${record!.id}`),
    );
    expect(view.done.some((d) => d.startsWith("Opened the"))).toBe(false);
    expect(await peekRunningRuns(ctx.repo)).toEqual([]);
    const runs = reviewRuns(ctx);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: record!.id,
      agent: "claude-code",
      model: "claude-test-1",
      started_at: toIsoDateTime(new Date(later(3).getTime() - 90_000)),
      finished_at: toIsoDateTime(later(3)),
      result: "success",
      error: null,
      review: passed,
      session: SESSION,
      usage: { input: 6, output: 2 },
    });
    const raw = JSON.parse(
      await readFile(path.join(ctx.repo.dataDir, runPath(record!.id)), "utf8"),
    ) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("capture");
    expect((await readTranscriptPaths(ctx.repo)).get(record!.id)).toBe(transcript);
    // 保留の結果と回は残さない（次の見直しの Run に結び付けない）
    expect(
      await readFile(path.join(ctx.repo.localDir, "reviews", "t1.json")).catch(() => null),
    ).toBeNull();
    expect((await readReviewFindings(ctx.repo, "t1"))?.rounds.map((r) => r.run)).toEqual([
      record!.id,
    ]);
    // 最新の見直しは結果なしの失敗にならず、gate が通る
    const gateView = await judge(ctx);
    expect(gateView.passed).toBe(true);
    expect(condition(gateView, "review").ok).toBe(true);
    expect(await stepOf(ctx)).toMatchObject({ stage: { reviews: 1, review_passed: true } });
    // もう一度の sync は書き足さない
    await runCommand(sync, ctx, {});
    expect(reviewRuns(ctx)).toHaveLength(1);
  });

  it("別のセッションの記録と、起動より前に書かれた記録は引き取らず、今までどおり Run を開く", async () => {
    // 別のセッション（ほかの見直し役）が書いた結果
    const other = await withTranscripts();
    other.ctx.env = { ...other.ctx.env, DEGUBOARD_SESSION: "s-other" };
    await hold(other.ctx, later(2), false);
    await runCommand(sync, other.ctx, {});
    const [fromOther] = reviewRuns(other.ctx);
    const v1 = await returned(other.ctx, other.parent, later(3), 90_000);
    expect(v1.done).toContainEqual(expect.stringMatching(/^Opened the review Run/));
    expect(v1.done.some((d) => d.startsWith("Took over"))).toBe(false);
    expect(other.ctx.store.runs.get(fromOther!.id)?.data).toMatchObject({ capture: "none" });

    // 同じセッションでも、起動（later(2.5)）より前に書かれた結果
    const before = await withTranscripts();
    await hold(before.ctx, later(2), false);
    await runCommand(sync, before.ctx, {});
    const [earlier] = reviewRuns(before.ctx);
    const v2 = await returned(before.ctx, before.parent, later(3), 30_000);
    expect(v2.done).toContainEqual(expect.stringMatching(/^Opened the review Run/));
    expect(before.ctx.store.runs.get(earlier!.id)?.data).toMatchObject({ capture: "none" });
  });
});
