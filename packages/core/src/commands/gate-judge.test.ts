// 品質ゲートの判定の組み合わせ（段 × for × 事実）を、git・gh なしで確かめる。
// 事実を集める経路（gh の呼び方、fetch、記録、検査を回す）は gate.test.ts と pr.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import type { PrGateFacts } from "../git/facts.js";
import type { GateLevel } from "../model/ticket.js";
import type { CheckOutcome } from "./gate-check.js";
import {
  concludeGate,
  gateFailure,
  gatePassage,
  gateReads,
  heavyReviewRounds,
  judgeBeforeCheck,
  reviewedTip,
  waivedBy,
  type GateConditionId,
  type GateFacts,
  type GateStage,
  type GateView,
  type PrFact,
  type ReviewRun,
} from "./gate-judge.js";

/** リモートの先端。時刻はすべてこのファイルの定数で、時計を読まない */
const TIP = { sha: "a".repeat(40), at: "2026-01-02T00:00:00Z" };
const OTHER = "b".repeat(40);
const BRANCH_AT = "2026-01-01T00:00:00Z";
/** 先端のコミットの時刻より前・後 */
const BEFORE_TIP = "2026-01-01T12:00:00Z";
const AFTER_TIP = "2026-01-02T00:10:00Z";

const openPr = (over: Partial<PrGateFacts> = {}): PrFact => ({
  kind: "read",
  pr: { number: 7, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", head: TIP.sha, ...over },
});

/** 見直しの Run。既定は先端を見直して通った、閉じた見直し */
const run = (over: Partial<ReviewRun> = {}): ReviewRun => ({
  id: "r1",
  step: "review",
  head: TIP.sha,
  started_at: AFTER_TIP,
  finished_at: AFTER_TIP,
  result: "success",
  review: { heavy: 0, light: 0, passed: true },
  ...over,
});
/** 見直した SHA を持たない Run（前の版の Run） */
const withoutHead = (r: ReviewRun): ReviewRun => {
  const { head: _head, ...rest } = r;
  return rest;
};
const heavy = (id: `r${string}`, started_at: string): ReviewRun =>
  run({ id, started_at, finished_at: started_at, review: { heavy: 1, light: 0, passed: false } });

/** ゲートの事実。既定は high の merge で、すべての条件を満たす（PR #7 が開いて衝突せず、先端を見直して通り、受け入れ条件 2 件に印） */
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  ticket: "t1",
  level: "high",
  for: "merge",
  recordedPr: 7,
  branchAt: BRANCH_AT,
  pr: openPr(),
  acceptance: [
    { index: 1, checked: true },
    { index: 2, checked: true },
  ],
  review: { tip: TIP, runs: [run()] },
  latest: TIP.sha,
  checkConfigured: true,
  ...over,
});

const PASSED: CheckOutcome = { ok: true, detail: "The check (actions.test: x) passed" };
const FAILED: CheckOutcome = {
  ok: false,
  detail:
    "The check (actions.test: x) failed on the latest commit aaaaaaaa (exit 1). End of output:\n落ちたテスト",
};

/** 2 段を通した結論。検査は、1 段目が判定すると決めたときだけ check（既定は通る）を入れる */
const judge = (
  over: Partial<GateFacts> = {},
  opts: { waived?: ReadonlySet<GateConditionId>; check?: CheckOutcome } = {},
): GateView => {
  const draft = judgeBeforeCheck(facts(over), opts.waived);
  return concludeGate(draft, draft.check === "judge" ? (opts.check ?? PASSED) : undefined);
};
const ids = (view: GateView) => view.conditions.map((c) => c.id);
const failed = (view: GateView) => view.conditions.filter((c) => !c.ok).map((c) => c.id);
const detail = (view: GateView, id: GateConditionId) =>
  view.conditions.find((c) => c.id === id)?.detail;

const LEVELS: GateLevel[] = ["high", "low", "free"];
const STAGES: GateStage[] = ["ready", "merge"];
type PerScope = Record<GateLevel, Record<GateStage, GateConditionId[]>>;

describe("段と for が判定する条件（TK-9）", () => {
  const judged: PerScope = {
    high: {
      ready: ["pr", "review", "fix_rounds", "check"],
      merge: ["pr", "acceptance", "review", "fix_rounds", "mergeable", "head", "check"],
    },
    low: {
      ready: ["pr", "check"],
      merge: ["pr", "acceptance", "mergeable", "head", "check"],
    },
    free: { ready: ["pr"], merge: ["pr", "mergeable"] },
  };

  for (const level of LEVELS)
    for (const stage of STAGES)
      it(`${level} の ${stage} は ${judged[level][stage].join("・")} をこの順に判定し、すべて満たせば通る`, () => {
        const view = judge({ level, for: stage });
        expect(ids(view)).toEqual(judged[level][stage]);
        expect(view).toMatchObject({
          ticket: "t1",
          for: stage,
          gate: level,
          pr: 7,
          sha: TIP.sha,
          passed: true,
        });
      });

  it("読む事実は、受け入れ条件が merge の high・low、見直しが high、最新のコミットが merge の high・low", () => {
    expect(gateReads("high", "merge")).toEqual({ acceptance: true, review: true, latest: true });
    expect(gateReads("high", "ready")).toEqual({ acceptance: false, review: true, latest: false });
    expect(gateReads("low", "merge")).toEqual({ acceptance: true, review: false, latest: true });
    expect(gateReads("low", "ready")).toEqual({ acceptance: false, review: false, latest: false });
    expect(gateReads("free", "merge")).toEqual({ acceptance: false, review: false, latest: false });
    expect(gateReads("free", "ready")).toEqual({ acceptance: false, review: false, latest: false });
  });
});

describe("事実を 1 つずつ崩したときに満たさない条件（段 × for）", () => {
  /** 満たさない条件を、どの段と for でも同じにする（free は pr と mergeable だけを判定する） */
  const prOnly: PerScope = {
    high: { ready: ["pr"], merge: ["pr", "mergeable"] },
    low: { ready: ["pr"], merge: ["pr", "mergeable"] },
    free: { ready: ["pr"], merge: ["pr", "mergeable"] },
  };
  const nowhere: GateConditionId[] = [];
  const highOnly = (...unmet: GateConditionId[]): PerScope => ({
    high: { ready: unmet, merge: unmet },
    low: { ready: nowhere, merge: nowhere },
    free: { ready: nowhere, merge: nowhere },
  });
  const mergeOnly = (unmet: GateConditionId, free: boolean): PerScope => ({
    high: { ready: nowhere, merge: [unmet] },
    low: { ready: nowhere, merge: [unmet] },
    free: { ready: nowhere, merge: free ? [unmet] : nowhere },
  });

  const cases: Array<{ name: string; broken: Partial<GateFacts>; unmet: PerScope }> = [
    {
      name: "チケットに PR も作業ブランチもない",
      broken: { pr: { kind: "no_selector" }, recordedPr: null },
      unmet: prOnly,
    },
    { name: "PR がない", broken: { pr: { kind: "missing", selector: "t1" } }, unmet: prOnly },
    {
      name: "gh がない・読めない",
      broken: { pr: { kind: "unreadable", reason: "gh is not installed" } },
      unmet: prOnly,
    },
    {
      name: "PR が閉じている",
      broken: { pr: openPr({ state: "CLOSED" }) },
      unmet: {
        high: { ready: ["pr"], merge: ["pr"] },
        low: { ready: ["pr"], merge: ["pr"] },
        free: { ready: ["pr"], merge: ["pr"] },
      },
    },
    {
      name: "PR が draft",
      broken: { pr: openPr({ isDraft: true }) },
      unmet: mergeOnly("pr", true),
    },
    {
      name: "PR が衝突している",
      broken: { pr: openPr({ mergeable: "CONFLICTING" }) },
      unmet: mergeOnly("mergeable", true),
    },
    {
      name: "受け入れ条件に印のない項目がある",
      broken: {
        acceptance: [
          { index: 1, checked: true },
          { index: 2, checked: false },
        ],
      },
      unmet: mergeOnly("acceptance", false),
    },
    {
      name: "リモートの先端を読めない",
      broken: { review: { tip: null, runs: [run()] } },
      unmet: highOnly("review"),
    },
    {
      name: "見直しがない",
      broken: { review: { tip: TIP, runs: [] } },
      unmet: highOnly("review"),
    },
    {
      name: "重い指摘の出た見直しが上限を超えた後に通った",
      broken: {
        review: {
          tip: TIP,
          runs: [
            heavy("r1", "2026-01-02T00:01:00Z"),
            heavy("r2", "2026-01-02T00:02:00Z"),
            heavy("r3", "2026-01-02T00:03:00Z"),
            run({ id: "r4" }),
          ],
        },
      },
      unmet: highOnly("fix_rounds"),
    },
    {
      name: "PR の先端が作業ブランチの最新のコミットと違う",
      broken: { latest: OTHER },
      unmet: mergeOnly("head", false),
    },
    {
      // head は比べない。読めないことは、同じ ref を読む見直し（review）と検査（check。judgeCheck）が落とす
      name: "作業ブランチの最新のコミットだけを読めない",
      broken: { latest: null },
      unmet: highOnly(),
    },
  ];

  for (const c of cases)
    for (const level of LEVELS)
      for (const stage of STAGES) {
        const unmet = c.unmet[level][stage];
        it(`${c.name}：${level} の ${stage} は ${unmet.length > 0 ? `${unmet.join("・")} を満たさない` : "通る"}`, () => {
          const view = judge({ level, for: stage, ...c.broken });
          // 検査は、ほかの条件を満たさないと回さないので満たさない条件に入る（free は検査を判定しない）
          const check: GateConditionId[] = unmet.length > 0 && level !== "free" ? ["check"] : [];
          expect(failed(view)).toEqual([...unmet, ...check]);
          expect(view.passed).toBe(unmet.length === 0);
        });
      }
});

describe("PR の条件（pr・mergeable）と結果の pr・sha", () => {
  it("PR を読めなかった理由を detail に出し、結果の pr はチケットに記録した番号、sha は null にする", () => {
    const none = judge({ pr: { kind: "no_selector" }, recordedPr: null });
    expect(detail(none, "pr")).toBe("The ticket has neither a PR nor a work branch");
    expect(none).toMatchObject({ pr: null, sha: null, passed: false });
    const missing = judge({ pr: { kind: "missing", selector: "t1" }, recordedPr: null });
    expect(detail(missing, "pr")).toBe("No PR (t1)");
    const unreadable = judge({ pr: { kind: "unreadable", reason: "gh is not installed" } });
    expect(detail(unreadable, "pr")).toBe("Cannot check the PR: gh is not installed");
    expect(unreadable).toMatchObject({ pr: 7, sha: null });
    expect(detail(unreadable, "mergeable")).toBe(
      "Cannot read the PR, so conflicts cannot be checked",
    );
  });

  it("読めた PR は gh の番号と先端を結果に出す（チケットに記録がなくても）", () => {
    expect(judge({ recordedPr: null })).toMatchObject({ pr: 7, sha: TIP.sha });
    // PR の先端が別のコミットなら、head だけが落ち、結果の SHA は PR の先端を指す（t750）
    const moved = judge({ pr: openPr({ head: OTHER }) });
    expect(moved).toMatchObject({ passed: false, sha: OTHER });
  });

  it("開いていない PR は状態を、draft は ready では draft と添えて通し、merge では満たさない", () => {
    expect(detail(judge({ pr: openPr({ state: "MERGED" }) }), "pr")).toBe(
      "PR #7 is not open (MERGED)",
    );
    const draft = { pr: openPr({ isDraft: true }) };
    expect(detail(judge({ ...draft, for: "ready" }), "pr")).toBe("PR #7 is open (draft)");
    expect(detail(judge(draft), "pr")).toBe("PR #7 is still a draft");
    expect(detail(judge(), "pr")).toBe("PR #7 is open");
  });

  it("mergeable は MERGEABLE だけを満たすとし、ほかの値（衝突・計算中）は値を detail に出す", () => {
    expect(detail(judge(), "mergeable")).toBe("No conflict with base");
    for (const value of ["CONFLICTING", "UNKNOWN"]) {
      const view = judge({ pr: openPr({ mergeable: value }) });
      expect(failed(view)).toEqual(["mergeable", "check"]);
      expect(detail(view, "mergeable")).toContain(`mergeable is ${value}`);
    }
  });
});

describe("受け入れ条件（acceptance）", () => {
  it("印のない項目の番号を detail に出し、すべて付けば件数を出す。項目がなければ満たす", () => {
    const view = judge({
      acceptance: [
        { index: 1, checked: false },
        { index: 2, checked: true },
        { index: 3, checked: false },
      ],
    });
    expect(detail(view, "acceptance")).toBe("Acceptance criteria 1, 3 are not marked");
    expect(detail(judge(), "acceptance")).toBe("All 2 acceptance criteria are marked");
    expect(detail(judge({ acceptance: [] }), "acceptance")).toBe(
      "All 0 acceptance criteria are marked",
    );
  });
});

describe("見直し（review）", () => {
  const review = (runs: ReviewRun[], tip: typeof TIP | null = TIP) =>
    judge({ for: "ready", review: { tip, runs } });

  it("リモートの先端を読めなければ満たさない", () => {
    expect(detail(review([run()], null), "review")).toBe(
      "Cannot read the remote tip of the work branch (the last push)",
    );
  });

  it("見直した SHA が先端と同じ見直しだけを数える。見直しの後に push された先端は見直していない（t763）", () => {
    // 見直しの開始が先端のコミットの時刻より後でも、SHA が違えば見直していない（見直しの前に作って後で push したコミット）
    const stale = review([run({ head: OTHER })]);
    expect(failed(stale)).toEqual(["review", "check"]);
    expect(detail(stale, "review")).toBe(
      `No review of the last push (remote tip aaaaaaaa, committed at ${TIP.at})`,
    );
    // push の前に見直したコミットが後で先端になれば満たす（開始が先端のコミットの時刻より前でも）
    expect(failed(review([run({ started_at: BEFORE_TIP })]))).toEqual([]);
  });

  it("SHA を持たない見直し（前の版の Run）は、開始が先端のコミットの時刻より前なら数えず、同じか後なら数える（t763）", () => {
    const at = (started_at: string) => withoutHead(run({ started_at }));
    expect(failed(review([at(BEFORE_TIP)]))).toEqual(["review", "check"]);
    expect(failed(review([at(TIP.at)]))).toEqual([]);
    expect(failed(review([at(AFTER_TIP)]))).toEqual([]);
    expect(reviewedTip({ started_at: BEFORE_TIP }, TIP)).toBe(false);
    expect(reviewedTip({ head: TIP.sha, started_at: BEFORE_TIP }, TIP)).toBe(true);
  });

  it("先端を見直した最後の見直しが、閉じていない・success でない・結果がない・重い指摘があるなら満たさない", () => {
    expect(detail(review([run({ finished_at: null, result: null })]), "review")).toBe(
      "Review r1 of the last push has not finished",
    );
    expect(detail(review([run({ result: "interrupted" })]), "review")).toBe(
      "Review r1 of the last push closed as interrupted",
    );
    expect(detail(review([run({ review: null })]), "review")).toBe(
      "The result of review r1 is not recorded (dg run review-result)",
    );
    expect(detail(review([run({ review: { heavy: 2, light: 1, passed: false } })]), "review")).toBe(
      "Review r1 did not pass (2 heavy findings)",
    );
    expect(detail(review([run()]), "review")).toBe("Review r1 of the last push passed");
  });

  it("先端を見直した見直しが複数あれば最後のものを使い、先端を見ていない後の見直しは使わない", () => {
    const first = heavy("r1", "2026-01-02T00:01:00Z");
    const second = run({ id: "r2", started_at: "2026-01-02T00:02:00Z" });
    expect(failed(review([first, second]))).toEqual([]);
    // 通った見直しの後に、重い指摘の出た見直しがあれば満たさない
    expect(failed(review([second, heavy("r3", "2026-01-02T00:03:00Z")]))).toEqual([
      "review",
      "check",
    ]);
    // 別のコミットを見た後の見直しは、先端の見直しではない
    const elsewhere = run({ id: "r3", head: OTHER, started_at: "2026-01-02T00:03:00Z" });
    expect(detail(review([first, elsewhere]), "review")).toBe(
      "Review r1 did not pass (1 heavy findings)",
    );
  });
});

describe("修正ループの回数（fix_rounds）", () => {
  const rounds = (runs: ReviewRun[]) => judge({ for: "ready", review: { tip: TIP, runs } });

  it("重い指摘の出た見直しが上限（2 回）までは満たし、3 回で満たさない", () => {
    const two = rounds([heavy("r1", "2026-01-02T00:01:00Z"), heavy("r2", "2026-01-02T00:02:00Z")]);
    expect(failed(two)).toEqual(["review", "check"]);
    expect(detail(two, "fix_rounds")).toBe("2 review rounds found heavy findings (limit 2)");
    const three = rounds([
      heavy("r1", "2026-01-02T00:01:00Z"),
      heavy("r2", "2026-01-02T00:02:00Z"),
      heavy("r3", "2026-01-02T00:03:00Z"),
    ]);
    expect(failed(three)).toEqual(["review", "fix_rounds", "check"]);
    expect(detail(three, "fix_rounds")).toContain("exceeds the limit of 2");
  });

  it("作業ブランチを切る前の見直しと、見直しでない Run は数えず、実行中でも結果を記録した見直しは数える", () => {
    const runs: ReviewRun[] = [
      heavy("r0", "2025-12-31T00:00:00Z"),
      heavy("r1", "2026-01-02T00:01:00Z"),
      { ...heavy("r2", "2026-01-02T00:02:00Z"), step: "implement" },
      { ...heavy("r3", "2026-01-02T00:03:00Z"), finished_at: null, result: null },
      run({ id: "r4", review: null }),
    ];
    expect(heavyReviewRounds(runs, BRANCH_AT)).toBe(2);
    // 作業ブランチを切った時刻がなければ、すべての見直しを数える
    expect(heavyReviewRounds(runs, undefined)).toBe(3);
  });
});

describe("PR の先端（head。t750）", () => {
  it("PR の先端が最新のコミットと同じなら満たし、違えば両方の SHA を、gh が先端を返さなければその旨を detail に出す", () => {
    expect(detail(judge(), "head")).toBe(
      "PR #7's head aaaaaaaa is the latest commit of the work branch",
    );
    expect(detail(judge({ latest: OTHER }), "head")).toBe(
      "PR #7's head aaaaaaaa is not the latest commit of the work branch (bbbbbbbb). Push or fetch so they match, then judge again",
    );
    const unread = judge({ pr: openPr({ head: undefined }) });
    expect(detail(unread, "head")).toBe(
      "Cannot read the head commit of PR #7 from gh, so it cannot be compared with the work branch",
    );
    expect(unread.sha).toBeNull();
  });

  it("PR を読めない・最新のコミットを読めないときは head を判定しない（pr・review・check が別に落ちる）", () => {
    expect(ids(judge({ pr: { kind: "missing", selector: "t1" } }))).not.toContain("head");
    expect(ids(judge({ latest: null }))).not.toContain("head");
  });
});

describe("検査を回すか（1 段目の check）と結論（2 段目）", () => {
  const draftCheck = (over: Partial<GateFacts> = {}, waived?: ReadonlySet<GateConditionId>) =>
    judgeBeforeCheck(facts(over), waived).check;
  const unreviewed: Partial<GateFacts> = { review: { tip: TIP, runs: [] } };

  it("1 段目は検査のほかの条件だけを返し、すべて満たせば検査を判定する", () => {
    const draft = judgeBeforeCheck(facts());
    expect(draft.conditions.map((c) => c.id)).not.toContain("check");
    expect(draft.check).toBe("judge");
  });

  it("ほかの条件を 1 つでも満たさなければ検査を回さず、結論に not_run の印を付ける", () => {
    expect(draftCheck(unreviewed)).toBe("not_run");
    const view = judge(unreviewed, { check: PASSED });
    expect(view.conditions.at(-1)).toEqual({
      id: "check",
      ok: false,
      detail: "The other conditions are not met, so the check (actions.test) was not run",
      not_run: true,
    });
  });

  it("actions.test が空なら、ほかの条件を満たさなくても検査を判定する（回さずに通すので）", () => {
    expect(draftCheck({ ...unreviewed, checkConfigured: false })).toBe("judge");
  });

  it("low は見直しがなくても検査を判定し、free はどの事実でも検査を判定しない", () => {
    for (const stage of STAGES) {
      expect(draftCheck({ ...unreviewed, level: "low", for: stage })).toBe("judge");
      expect(draftCheck({ level: "free", for: stage })).toBe("out_of_scope");
      expect(draftCheck({ level: "free", for: stage, checkConfigured: false })).toBe(
        "out_of_scope",
      );
    }
    // free は検査が落ちる設定でも、検査の条件を出さずに通る
    const free = judge({
      ...unreviewed,
      level: "free",
      acceptance: [{ index: 1, checked: false }],
    });
    expect(free).toMatchObject({ gate: "free", passed: true });
    expect(ids(free)).toEqual(["pr", "mergeable"]);
  });

  it("満たさない条件がすべて人の承認で越える条件なら検査を判定し、越えられない条件が残れば回さない（t884）", () => {
    const waived = waivedBy("merge", true);
    const unmarked: Partial<GateFacts> = {
      ...unreviewed,
      acceptance: [{ index: 1, checked: false }],
    };
    expect(draftCheck(unmarked)).toBe("not_run");
    expect(draftCheck(unmarked, waived)).toBe("judge");
    expect(draftCheck({ ...unmarked, pr: openPr({ mergeable: "CONFLICTING" }) }, waived)).toBe(
      "not_run",
    );
    // 越えても判定は変えない（満たさない条件は ok: false のまま）
    expect(failed(judge(unmarked, { waived }))).toEqual(["acceptance", "review"]);
  });

  it("回した検査の結果を最後の条件に入れ、落ちた検査は detail をそのまま出して通さない", () => {
    const passed = judge({}, { check: PASSED });
    expect(passed.conditions.at(-1)).toEqual({ id: "check", ok: true, detail: PASSED.detail });
    expect(passed.passed).toBe(true);
    const low = judge({ level: "low", ...unreviewed }, { check: FAILED });
    expect(failed(low)).toEqual(["check"]);
    expect(low.conditions.at(-1)).toEqual({ id: "check", ok: false, detail: FAILED.detail });
    expect(low.passed).toBe(false);
  });

  it("判定すると決めた検査の結果を渡さなければエラーにし、判定しない検査の結果は使わない", () => {
    expect(() => concludeGate(judgeBeforeCheck(facts()))).toThrow("no result was given");
    const free = concludeGate(judgeBeforeCheck(facts({ level: "free" })), FAILED);
    expect(free.passed).toBe(true);
    const skipped = concludeGate(judgeBeforeCheck(facts(unreviewed)), PASSED);
    expect(skipped.conditions.at(-1)).toMatchObject({ id: "check", ok: false, not_run: true });
  });
});

describe("dg pr ready・dg pr merge が越える条件と止める条件（gatePassage。t884）", () => {
  const approved = waivedBy("merge", true);
  const none = waivedBy("merge", false);
  const unreviewed: Partial<GateFacts> = {
    review: { tip: TIP, runs: [] },
    acceptance: [{ index: 1, checked: false }],
  };
  /** 止めたときの GATE_FAILED の detail */
  const stopped = (view: GateView, waived: ReadonlySet<GateConditionId>) => {
    const passage = gatePassage(view, waived);
    if (passage.proceed) throw new Error("止まるはずの結果が進んだ");
    return { ...passage, ...gateFailure(view, passage) };
  };

  it("人の承認で越えるのは merge の check・review・fix_rounds・acceptance だけで、承認がない・ready は何も越えない", () => {
    expect([...approved].sort()).toEqual(["acceptance", "check", "fix_rounds", "review"]);
    expect([...none]).toEqual([]);
    expect([...waivedBy("ready", true)]).toEqual([]);
    expect([...waivedBy("ready", false)]).toEqual([]);
  });

  for (const level of LEVELS)
    for (const stage of STAGES)
      it(`${level} の ${stage} は、ゲートを満たせば越えた条件なしで進み、PR の番号と判定した先端を返す`, () => {
        const view = judge({ level, for: stage });
        expect(gatePassage(view, waivedBy(stage, false))).toEqual({
          proceed: true,
          pr: 7,
          sha: TIP.sha,
          overridden: [],
        });
      });

  it("満たさない条件があれば止め、条件と理由を 1 行ずつ出す。ready は人が gh pr ready を打つ道を案内する", () => {
    const view = judge({ for: "ready", review: { tip: TIP, runs: [] } });
    const stop = stopped(view, waivedBy("ready", false));
    expect(stop.failed).toEqual([
      `review: No review of the last push (remote tip aaaaaaaa, committed at ${TIP.at})`,
      "check: The other conditions are not met, so the check (actions.test) was not run",
    ]);
    expect(stop.message).toBe(
      "t1 does not meet the quality gate (dg gate t1 --for ready), so gh pr ready is not called",
    );
    expect(stop.detail).toContain(stop.failed.join("\n"));
    expect(stop.detail).toContain("ask a human to run gh pr ready");
    // 段が変更に合わないときの付け替え（版上げの例は出さない。t661）
    expect(stop.detail).toContain("dg ticket update t1 --gate <level>");
    expect(stop.detail).toContain("then run dg pr ready again");
    expect(stop.detail).not.toContain("version-bump");
  });

  it("ready は承認があっても越えない", () => {
    const view = judge({ for: "ready", review: { tip: TIP, runs: [] } });
    expect(gatePassage(view, waivedBy("ready", true)).proceed).toBe(false);
  });

  it("検査が落ちれば止め、終了コードと出力の末尾を持つ検査の detail を理由に出す（t601）", () => {
    for (const stage of STAGES) {
      const stop = stopped(judge({ for: stage }, { check: FAILED }), waivedBy(stage, false));
      expect(stop.failed).toEqual([`check: ${FAILED.detail}`]);
      expect(stop.detail).toContain("exit 1");
      expect(stop.detail).toContain("落ちたテスト");
    }
  });

  it("merge で承認がなければ越えず、人に聞いて --approved-by を渡す道を案内する（人に gh を打たせない）", () => {
    const stop = stopped(judge(unreviewed), none);
    expect(stop.failed.map((l) => l.split(":")[0])).toEqual(["acceptance", "review", "check"]);
    expect(stop.blocking).toEqual([]);
    expect(stop.detail).toContain("the check (actions.test) was not run");
    expect(stop.detail).toContain("it always needs a person's approval (fixed in Core");
    expect(stop.detail).toContain("ask whether to merge anyway");
    expect(stop.detail).toContain("dg pr merge t1 --approved-by human");
    expect(stop.detail).toContain("check, review, fix_rounds, acceptance");
    expect(stop.detail).not.toContain("ask a human to run gh pr merge");
    expect(stop.detail).not.toContain("does not override");
  });

  it("merge で承認があれば、満たさない review・acceptance を越えて進み、通った検査は越えた条件に入らない", () => {
    const view = judge(unreviewed, { waived: approved, check: PASSED });
    expect(view.passed).toBe(false);
    expect(gatePassage(view, approved)).toEqual({
      proceed: true,
      pr: 7,
      sha: TIP.sha,
      overridden: ["acceptance", "review"],
    });
  });

  it("検査・見直し・手直しの回数・受け入れ条件のどれも満たさなくても、承認があればすべて越えて進む", () => {
    const all: Partial<GateFacts> = {
      acceptance: [{ index: 1, checked: false }],
      review: {
        tip: TIP,
        runs: [
          heavy("r1", "2026-01-02T00:01:00Z"),
          heavy("r2", "2026-01-02T00:02:00Z"),
          heavy("r3", "2026-01-02T00:03:00Z"),
        ],
      },
    };
    // 承認がなければ、ほかの条件を満たさないので検査は回さず、人に聞く道を案内する
    const stop = stopped(judge(all), none);
    expect(stop.detail).toContain("the check (actions.test) was not run");
    expect(stop.detail).toContain("ask whether to merge anyway");
    expect(stop.detail).not.toContain("does not override");
    // 承認があれば検査を回し（結果を事実として残す）、落ちた検査も越える
    const view = judge(all, { waived: approved, check: FAILED });
    expect(view.conditions.find((c) => c.id === "check")).toMatchObject({ ok: false });
    expect(gatePassage(view, approved)).toMatchObject({
      proceed: true,
      overridden: ["acceptance", "review", "fix_rounds", "check"],
    });
  });

  it("draft・衝突・PR の先端の食い違いは、承認があっても越えられず、越えられない条件を案内する", () => {
    const blocked: Array<[Partial<GateFacts>, string, string]> = [
      [{ pr: openPr({ isDraft: true }) }, "pr", "pr: PR #7 is still a draft"],
      [
        { pr: openPr({ mergeable: "CONFLICTING" }) },
        "mergeable",
        "mergeable: mergeable is CONFLICTING",
      ],
      [{ latest: OTHER }, "head", "head: PR #7's head aaaaaaaa is not the latest commit"],
      // PR の先端を読めない（判定したコミットに固定できない）。head の条件が理由を持つので、理由を重ねない
      [{ pr: openPr({ head: undefined }) }, "head", "head: Cannot read the head commit of PR #7"],
    ];
    for (const [broken, id, line] of blocked) {
      const stop = stopped(judge(broken, { waived: approved }), approved);
      expect(stop.blocking).toEqual([id]);
      expect(stop.failed.filter((l) => l.startsWith(`${id}:`))).toHaveLength(1);
      expect(stop.detail).toContain(line);
      expect(stop.detail).toContain(`A person's approval does not override ${id}`);
      expect(stop.detail).toContain("pr, mergeable, and head are never overridden");
      expect(stop.detail).not.toContain("ask whether to merge anyway");
    }
  });

  it("越えられる条件と越えられない条件がどちらも満たされなければ、越えられない条件だけを blocking に出す", () => {
    const stop = stopped(
      judge({ ...unreviewed, pr: openPr({ mergeable: "CONFLICTING" }) }, { waived: approved }),
      approved,
    );
    expect(stop.blocking).toEqual(["mergeable"]);
    expect(stop.failed.map((l) => l.split(":")[0])).toEqual([
      "acceptance",
      "review",
      "mergeable",
      "check",
    ]);
  });

  it("free の merge で gh が PR の先端を返さなければ、理由を head: で足して止める。ready は先端に固定しないので進む（t750）", () => {
    const noHead: Partial<GateFacts> = { level: "free", pr: openPr({ head: undefined }) };
    const view = judge(noHead);
    expect(view).toMatchObject({ passed: true, sha: null });
    const stop = stopped(view, none);
    expect(stop.failed).toEqual([
      "head: cannot read the PR head commit from gh, so the merge cannot be pinned to the judged commit",
    ]);
    expect(stop.blocking).toEqual(["head"]);
    expect(gatePassage(judge({ ...noHead, for: "ready" }), none)).toEqual({
      proceed: true,
      pr: 7,
      sha: null,
      overridden: [],
    });
  });

  it("low は見直しがなくても ready に進み、merge は受け入れ条件に印がなければ止まり、印が付けば進む（t663）", () => {
    const low: Partial<GateFacts> = { level: "low", review: { tip: null, runs: [] } };
    const unmarked = { ...low, acceptance: [{ index: 1, checked: false }] };
    expect(gatePassage(judge({ ...unmarked, for: "ready" }), none).proceed).toBe(true);
    expect(stopped(judge(unmarked), none).failed).toEqual([
      "acceptance: Acceptance criteria 1 are not marked",
      "check: The other conditions are not met, so the check (actions.test) was not run",
    ]);
    expect(gatePassage(judge(low), none).proceed).toBe(true);
  });

  it("free は見直しがなく受け入れ条件に印がなくても、ready にも merge にも進む（t663）", () => {
    const free: Partial<GateFacts> = { ...unreviewed, level: "free", latest: null };
    for (const stage of STAGES)
      expect(gatePassage(judge({ ...free, for: stage }), none)).toMatchObject({
        proceed: true,
        overridden: [],
      });
  });

  it("PR を読めなければ、どの段の ready・merge も止まる", () => {
    for (const level of LEVELS)
      for (const stage of STAGES) {
        const view = judge({
          level,
          for: stage,
          pr: { kind: "unreadable", reason: "gh is not installed" },
          recordedPr: null,
        });
        const stop = stopped(view, waivedBy(stage, true));
        expect(stop.failed[0]).toBe("pr: Cannot check the PR: gh is not installed");
        expect(stop.blocking).toContain("pr");
      }
  });
});
