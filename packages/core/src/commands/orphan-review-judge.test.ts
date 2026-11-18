// 持ち主のない保留の見直しの判定の組み合わせ（開いた見直しの Run・待ちの印・書き終わりの待ち・動いているサブエージェント・push の区切り）を、
// git・ファイルなしで確かめる。事実を集める経路（会話記録の live の印を読む、コミットの時刻を読む）と、dg next・dg gate・dg sync・
// dg pr ready が数えて書く通しは orphan-review.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import type { Run, RunId, RunReview } from "../model/run.js";
import {
  adoptableReviewRecord,
  countOrphanReviews,
  orphanReviewsOf,
  type HeldRound,
  type OrphanReviewFacts,
  type RunningFact,
} from "./orphan-review-judge.js";

/** 時刻はすべてこのファイルの定数で、時計を読まない */
const BRANCH_AT = "2026-11-07T10:00:00Z";
const PUSH_1 = "2026-11-07T10:05:00Z";
const PUSH_2 = "2026-11-07T10:10:00Z";

const passed: RunReview = { heavy: 0, light: 0, passed: true };
const heavy: RunReview = { heavy: 1, light: 0, passed: false };

const round = (at: string, review: RunReview, run: RunId | null = null): HeldRound => ({
  run,
  at,
  review,
});

describe("持ち主のない保留から見直しの記録を作る（orphanReviewsOf。t699）", () => {
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
    const made = orphanReviewsOf("t1", rounds, undefined, [PUSH_1, PUSH_2]);
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
      BRANCH_AT,
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
      [PUSH_2],
    );
    expect(made.map((r) => r.session)).toEqual(["s-a", null]);
  });

  it("保留の回の先端（head）を記録に写し、先端のない前の回には head を書かない（t763）", () => {
    const made = orphanReviewsOf(
      "t1",
      [{ ...round("2026-11-07T10:06:00Z", passed), head: "a".repeat(40) }, round(PUSH_2, passed)],
      undefined,
      [PUSH_2],
    );
    expect(made[0]).toMatchObject({ head: "a".repeat(40) });
    expect(made[1]).not.toHaveProperty("head");
  });
});

describe("保留を数えるか、これから Run に結び付くかもしれないので数えないか（countOrphanReviews）", () => {
  /** 実行中の Run。既定は t1 の、待ちの印のない開いた実装の Run */
  const open = (over: Partial<RunningFact> = {}): RunningFact => ({
    id: "r-open",
    ticket: "t1",
    step: "implement",
    finished_at: null,
    waiting_since: null,
    settling_since: null,
    ...over,
  });
  /** 既定は、BRANCH_AT の後・PUSH_1 の後に書いた通った保留が 1 件あり、実行中の Run がない事実 */
  const facts = (over: Partial<OrphanReviewFacts> = {}): OrphanReviewFacts => ({
    running: [],
    live: new Set(),
    rounds: [round("2026-11-07T10:06:00Z", passed)],
    since: BRANCH_AT,
    commits: [PUSH_1],
    ...over,
  });
  const count = (over: Partial<OrphanReviewFacts>) =>
    countOrphanReviews("t1", facts(over)).map((r) => r.started_at);

  it("実行中の Run がなければ、保留を結果を書いた時刻の記録として数える", () => {
    expect(count({})).toEqual(["2026-11-07T10:06:00Z"]);
  });

  it("保留の回がない（すべて Run に結び付いている）なら空", () => {
    expect(count({ rounds: [round("2026-11-07T10:06:00Z", passed, "r1")] })).toEqual([]);
  });

  it("チケットの開いた見直しの Run があれば、待ちの印や動いている印に関わらず数えない", () => {
    for (const r of [
      open({ step: "review" }),
      open({ step: "review", waiting_since: PUSH_2 }),
      open({ step: "review", settling_since: PUSH_2 }),
    ])
      expect(count({ running: [r] })).toEqual([]);
  });

  it("閉じた見直しの Run と、ほかのチケットの開いた見直しの Run は数えるのを妨げない", () => {
    expect(count({ running: [open({ step: "review", finished_at: PUSH_2 })] })).toHaveLength(1);
    expect(count({ running: [open({ step: "review", ticket: "t2" })] })).toHaveLength(1);
  });

  // 動いているサブエージェントの印 × 止まって待つ印 × 書き終わり待ちの印 × どのチケットの Run か
  const cases: Array<[string, RunningFact, boolean, boolean]> = [
    ["動いている印があり、待ちの印がない", open(), true, false],
    ["動いている印があり、止まって待つ印がある", open({ waiting_since: PUSH_2 }), true, true],
    ["動いている印があり、書き終わり待ちの印がある", open({ settling_since: PUSH_2 }), true, true],
    ["動いている印がない", open(), false, true],
    ["動いている印があるが、ほかのチケットの Run", open({ ticket: "t2" }), true, true],
    ["動いている印があるが、閉じた Run", open({ finished_at: PUSH_2 }), true, true],
  ];
  it.each(cases)("見直し以外の Run：%s → 数えるか", (_, r, live, counted) => {
    const made = count({ running: [r], live: new Set(live ? [r.id] : []) });
    expect(made).toHaveLength(counted ? 1 : 0);
  });

  it("待ちの印のある Run と動いている Run が並べば、動いている Run があるので数えない", () => {
    const waiting = open({ id: "r-wait", waiting_since: PUSH_2 });
    const running = open({ id: "r-live" });
    expect(count({ running: [waiting, running], live: new Set(["r-wait", "r-live"]) })).toEqual([]);
    expect(count({ running: [waiting, running], live: new Set(["r-wait"]) })).toHaveLength(1);
  });

  it("数えるときは push の区切りごとに最新の 1 件、作業ブランチより前の回は数えない", () => {
    const rounds = [
      round("2026-11-07T09:00:00Z", heavy),
      round("2026-11-07T10:06:00Z", heavy),
      round("2026-11-07T10:07:00Z", heavy),
      round("2026-11-07T10:12:00Z", passed),
    ];
    expect(count({ rounds, commits: [PUSH_1, PUSH_2] })).toEqual([
      "2026-11-07T10:07:00Z",
      "2026-11-07T10:12:00Z",
    ]);
    // 区切りを読めなければ最新の 1 件だけ
    expect(count({ rounds, commits: [] })).toEqual(["2026-11-07T10:12:00Z"]);
    // 動いているサブエージェントがあれば、区切りがあっても数えない
    expect(
      count({ rounds, commits: [PUSH_1, PUSH_2], running: [open()], live: new Set(["r-open"]) }),
    ).toEqual([]);
  });
});

describe("起動のフックが引き取る見直しの記録（adoptableReviewRecord。t701）", () => {
  const record = (over: Partial<Run>): Run => ({
    ...orphanReviewsOf("t1", [round("2026-11-07T10:06:00Z", passed)], "", [])[0]!,
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
    const launchedAt = PUSH_1;
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
