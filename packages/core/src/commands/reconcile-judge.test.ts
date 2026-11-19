// 照合が対象のチケットごとに行うことの決定の組み合わせ（PR の有無と作成時刻と Run の開始の前後・前の作業の PR・止められた遷移・
// done への前進と消えたブランチ）を、git・gh なしで確かめる。事実を集めて列を行う経路（gh の呼び方・ロック・コミットの題・push・
// 別の文脈が先に閉じた Run）は commands-flow-reconcile.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import type { BranchFacts } from "../git/facts.js";
import type { Facts } from "../workflow/conditions.js";
import { DEFAULT_WORKFLOW } from "../workflow/resolve.js";
import { validateWorkflow } from "../workflow/validate.js";
import {
  decideTicketReconcile,
  type ReconcileAction,
  type RunningFact,
  type TicketReconcileFacts,
} from "./reconcile-judge.js";

/** 実装の Run の開始。時刻はすべてこのファイルの定数で、時計を読まない */
const RUN_AT = "2026-11-06T00:00:00Z";
const BEFORE_RUN = "2026-11-05T23:00:00Z";
const AFTER_RUN = "2026-11-06T02:00:00Z";

/** どの列にも入る、持ち主のない保留の見直しを書く位置 */
const REVIEWS: ReconcileAction = { kind: "record_reviews" };

const implementing = (over: Partial<RunningFact> = {}): RunningFact => ({
  id: "r20261106-000000-aaaa",
  ticket: "t1",
  step: "implement",
  started_at: RUN_AT,
  ...over,
});
const fixing = (over: Partial<RunningFact> = {}): RunningFact =>
  implementing({ id: "r20261106-030000-bbbb", step: "fix", ...over });

/** gh が「PR はない」と答えた、push 済みの作業ブランチの事実 */
const noPr = (over: Facts = {}): BranchFacts => ({
  facts: {
    branch_exists: true,
    branch_pushed: true,
    branch_merged: false,
    pr_open: false,
    pr_draft: false,
    pr_merged: false,
    ...over,
  },
  prMissing: true,
});

/** PR #42 を読めた作業ブランチの事実。既定は下書きで開いている PR（照合は進めない）で、Run の開始より後に作られた */
const withPr = (
  state: "draft" | "open" | "merged" | "closed" = "draft",
  over: Partial<BranchFacts> = {},
  facts: Facts = {},
): BranchFacts => ({
  facts: {
    branch_exists: true,
    branch_pushed: true,
    branch_merged: false,
    pr_open: state === "draft" || state === "open",
    pr_draft: state === "draft",
    pr_merged: state === "merged",
    ...facts,
  },
  pr: 42,
  prCreatedAt: AFTER_RUN,
  ...over,
});

/** 既定は、既定の Workflow の in_progress のチケット t1 で、PR も実行中の Run もない（行うことは見直しの記録だけ） */
const decide = (
  over: Partial<Omit<TicketReconcileFacts, "ticket">> & {
    ticket?: Partial<TicketReconcileFacts["ticket"]>;
  } = {},
): ReconcileAction[] =>
  decideTicketReconcile({
    unchecked: [],
    depsDone: true,
    workflow: DEFAULT_WORKFLOW,
    branch: noPr(),
    running: [],
    deleteBranch: false,
    ...over,
    ticket: { id: "t1", status: "in_progress", branch: "t1-work", ...over.ticket },
  });

const withBoundaries = (boundaries: unknown[]) =>
  validateWorkflow({ boundaries }, "workflow.yaml").workflow!;

const closeAt = (finishedAt: string | undefined): ReconcileAction => ({
  kind: "close_run",
  run: implementing().id,
  opener: "claim",
  result: "success",
  finishedAt,
});
const warning = (message: string): ReconcileAction => ({ kind: "warn", message });
const recordPr: ReconcileAction = { kind: "update_ticket", pr: 42 };

describe("PR による実装の Run（RN-6）", () => {
  it("PR がなければ、実行中の実装の Run を閉じない", () => {
    expect(decide({ running: [implementing()] })).toEqual([REVIEWS]);
  });

  it("Run の開始より後か同じ時刻に作られた PR を見つけたら、PR の作成時刻で success に閉じる", () => {
    for (const prCreatedAt of [AFTER_RUN, RUN_AT]) {
      expect(
        decide({ branch: withPr("draft", { prCreatedAt }), running: [implementing()] }),
      ).toEqual([closeAt(prCreatedAt), recordPr, REVIEWS]);
    }
  });

  it("Run の開始より前に作られた PR では閉じずに、PR の番号と作成時刻と閉じ方を知らせる（PR の後に開き直した Run）", () => {
    expect(
      decide({ branch: withPr("draft", { prCreatedAt: BEFORE_RUN }), running: [implementing()] }),
    ).toEqual([
      warning(
        `t1: implementation Run ${implementing().id} started after PR #42 was created (${BEFORE_RUN}), so reconcile does not close it. When it is finished, close it with run finish (work after the PR becomes a fix Run, by claiming again)`,
      ),
      recordPr,
      REVIEWS,
    ]);
  });

  it("PR の作成時刻を読めなければ、時刻を決めずに閉じる（行う側が今の時刻にする）", () => {
    const { prCreatedAt: _unread, ...unread } = withPr();
    expect(decide({ branch: unread, running: [implementing()] })).toEqual([
      closeAt(undefined),
      recordPr,
      REVIEWS,
    ]);
  });

  it("記録済みの番号で引いた PR でも閉じ、番号は書き直さない（番号を記録したときに閉じられなかった Run の拾い直し）", () => {
    expect(decide({ ticket: { pr: 42 }, branch: withPr(), running: [implementing()] })).toEqual([
      closeAt(AFTER_RUN),
      REVIEWS,
    ]);
  });

  it("PR がマージされずに閉じていても success で閉じる（実装は PR を作るまで）", () => {
    expect(decide({ branch: withPr("closed"), running: [implementing()] })).toEqual([
      closeAt(AFTER_RUN),
      recordPr,
      REVIEWS,
    ]);
  });

  it("別のチケットの Run と、実装でない step の Run は閉じない", () => {
    const others = [implementing({ ticket: "t2" }), implementing({ step: "review" })];
    expect(decide({ branch: withPr(), running: others })).toEqual([recordPr, REVIEWS]);
  });
});

describe("PR の番号と行数の記録（ST-6・MT-6）", () => {
  it("ブランチ名で見つけた PR の番号は、状態が進まなくても記録し、記録済みなら何も書かない（2 回目の sync）", () => {
    expect(decide({ branch: withPr() })).toEqual([recordPr, REVIEWS]);
    expect(decide({ ticket: { pr: 42 }, branch: withPr() })).toEqual([REVIEWS]);
    expect(decide()).toEqual([REVIEWS]);
  });

  it("マージされた PR の行数は done への前進と同じ書き込みで記録し、記録済みの行数は書き直さない", () => {
    const lines = { additions: 120, deletions: 30 };
    const merged = withPr("merged", { prLines: lines });
    const done = { from: "review", to: "done", when: ["pr_merged"] };
    expect(decide({ ticket: { status: "review", pr: 42 }, branch: merged })).toEqual([
      { kind: "update_ticket", lines, advance: done },
      REVIEWS,
    ]);
    expect(
      decide({
        ticket: { status: "review", pr: 42, lines: { additions: 1, deletions: 2 } },
        branch: merged,
      }),
    ).toEqual([{ kind: "update_ticket", advance: done }, REVIEWS]);
  });

  it("行数は、境目が止めて done に進まなくても記録する", () => {
    const lines = { additions: 120, deletions: 30 };
    const actions = decide({
      ticket: { status: "review", pr: 42 },
      workflow: withBoundaries([{ from: "review", to: "done", decide: "human_only" }]),
      branch: withPr("merged", { prLines: lines }),
    });
    expect(actions.filter((a) => a.kind !== "warn")).toEqual([
      { kind: "update_ticket", lines },
      REVIEWS,
    ]);
  });
});

describe("前の作業の PR（ST-6。t206・t747）", () => {
  it("外した PR は根拠にも記録にも使わず、番号・状態・作成時刻と、このチケットの PR だったときの手を知らせる", () => {
    for (const [state, word] of [
      ["MERGED", "merged"],
      ["CLOSED", "closed"],
    ] as const) {
      expect(
        decide({
          branch: {
            ...noPr(),
            ignoredPr: { number: 105, state, createdAt: "2026-10-31T10:00:00Z" },
          },
        }),
      ).toEqual([
        warning(
          `t1: PR #105, found by branch name, is ${word} and was created (2026-10-31T10:00:00Z) before the branch was recorded. It is taken as a PR of earlier work with the same name, so reconcile does not use it. If this PR belongs to this ticket, record it with ticket update t1 --pr 105, then run sync again to reconcile it. If it belongs to earlier work, do nothing`,
        ),
        REVIEWS,
      ]);
    }
  });
});

describe("前進と止められた遷移（ST-4）", () => {
  const gated = withBoundaries([
    { from: "in_progress", to: "review", requires: ["branch_pushed"] },
    { from: "review", to: "done", requires: ["pr_merged"], decide: "human_only" },
  ]);
  const toReview = { from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] };

  it("下書きでない PR が開いたら review に進め、見つけた番号を同じ書き込みで記録する", () => {
    expect(decide({ branch: withPr("open") })).toEqual([
      { kind: "update_ticket", pr: 42, advance: toReview },
      REVIEWS,
    ]);
  });

  it("越える境目の requires を満たさなければ進めず、満たさない条件と進め方を知らせる。番号は記録する。満たせば進める", () => {
    expect(
      decide({ workflow: gated, branch: withPr("open", {}, { branch_pushed: false }) }),
    ).toEqual([
      warning(
        't1: the facts (pr_open, !pr_draft) point from in_progress to review, but reconcile does not advance it, because the conditions are not met: branch_pushed (boundaries in_progress → review). It advances at a sync after the conditions are met; a person can go ahead without them with ticket move t1 review --override "reason"',
      ),
      recordPr,
      REVIEWS,
    ]);
    expect(decide({ workflow: gated, ticket: { pr: 42 }, branch: withPr("open") })).toEqual([
      { kind: "update_ticket", advance: toReview },
      REVIEWS,
    ]);
  });

  it("human_only の境目は requires を満たしても越えず、人が進める手を知らせる", () => {
    expect(
      decide({ workflow: gated, ticket: { status: "review", pr: 42 }, branch: withPr("merged") }),
    ).toEqual([
      warning(
        "t1: the facts (pr_merged) point from review to done, but reconcile does not advance it, because the Workflow limits the move to a person (human_only) (boundaries review → done). A person moves it with ticket move t1 done",
      ),
      REVIEWS,
    ]);
  });

  it("requires を満たさず human_only でもある境目は、両方の理由と、人が強制して進める手を知らせる", () => {
    expect(
      decide({
        workflow: gated,
        ticket: { status: "review", pr: 42 },
        branch: withPr("open", {}, { branch_merged: true }),
      }),
    ).toEqual([
      warning(
        't1: the facts (branch_merged) point from review to done, but reconcile does not advance it, because the conditions are not met: pr_merged, and the Workflow limits the move to a person (human_only) (boundaries review → done). A person moves it with ticket move t1 done --override "reason"',
      ),
      REVIEWS,
    ]);
  });

  it("PR の番号を記録したチケットは、読めた PR がマージ済みでなければブランチのマージだけでは done に進めず、PR の事実を読めなければ（gh がない）ブランチのマージで done に進める（ST-6）", () => {
    const ticket = { status: "review", pr: 7 } as const;
    const held = decide({
      ticket,
      branch: { ...withPr("open", { pr: 7 }, { branch_merged: true }) },
    });
    expect(held).toEqual([
      warning(
        't1: the facts (branch_merged) point from review to done, but reconcile does not advance it, because the conditions are not met: pr_merged (boundaries review → done). It advances at a sync after the conditions are met; a person can go ahead without them with ticket move t1 done --override "reason"',
      ),
      REVIEWS,
    ]);
    // gh がないと、PR の事実（pr_*）も PR の番号も読めない
    const unread: BranchFacts = {
      facts: { branch_exists: true, branch_pushed: true, branch_merged: true },
    };
    expect(decide({ ticket, branch: unread })).toEqual([
      {
        kind: "update_ticket",
        advance: { from: "review", to: "done", when: ["branch_merged"] },
      },
      REVIEWS,
    ]);
  });

  it("依存が終わっていないチケットは、ブランチがあっても in_progress に進めない（deps_done は渡した値で決まる）", () => {
    const todo = { status: "todo" } as const;
    expect(decide({ ticket: todo, depsDone: false })).toEqual([
      warning(
        't1: the facts (branch_exists) point from todo to in_progress, but reconcile does not advance it, because the conditions are not met: deps_done (boundaries todo → in_progress). It advances at a sync after the conditions are met; a person can go ahead without them with ticket move t1 in_progress --override "reason"',
      ),
      REVIEWS,
    ]);
    expect(decide({ ticket: todo, depsDone: true })).toEqual([
      {
        kind: "update_ticket",
        advance: { from: "todo", to: "in_progress", when: ["branch_exists"] },
      },
      REVIEWS,
    ]);
  });
});

describe("done への前進（ST-4・TK-5）", () => {
  const merged = noPr({ branch_merged: true });
  const done = {
    kind: "update_ticket",
    advance: { from: "review", to: "done", when: ["branch_merged"] },
  } as const;
  const review = { status: "review" } as const;

  it("merge.delete_branch が true のときだけ、done にしたチケットの残りの片付けを、書き換えの後に置く。PR のないブランチでは PR の先端を持たない", () => {
    expect(decide({ ticket: review, branch: merged })).toEqual([done, REVIEWS]);
    expect(decide({ ticket: review, branch: merged, deleteBranch: true })).toEqual([
      done,
      { kind: "remove_merged_work", branch: "t1-work", mergedHead: undefined },
      REVIEWS,
    ]);
    const head = "a".repeat(40);
    expect(
      decide({
        ticket: { status: "review", pr: 42 },
        branch: withPr("merged", { prMergedHead: head }),
        deleteBranch: true,
      }),
    ).toContainEqual({ kind: "remove_merged_work", branch: "t1-work", mergedHead: head });
  });

  it("done のほかへの前進と、進まなかったチケットでは、merge.delete_branch が true でも片付けない", () => {
    const kinds = (actions: ReconcileAction[]) => actions.map((a) => a.kind);
    expect(kinds(decide({ branch: withPr("open"), deleteBranch: true }))).toEqual([
      "update_ticket",
      "record_reviews",
    ]);
    expect(kinds(decide({ deleteBranch: true }))).toEqual(["record_reviews"]);
  });

  it("done にしたときに未チェックの受け入れ条件があれば、遷移は止めずに、列の最後で番号を知らせる。done のほかへの前進では知らせない", () => {
    expect(decide({ ticket: review, branch: merged, unchecked: [2, 3] })).toEqual([
      done,
      REVIEWS,
      warning("t1: acceptance criteria items 2, 3 were left unchecked when the ticket became done"),
    ]);
    expect(
      decide({ branch: withPr("open"), unchecked: [2] }).filter((a) => a.kind === "warn"),
    ).toEqual([]);
  });
});

describe("後退を指す事実（ST-5）", () => {
  it("消えたブランチは書き換えずに知らせる。done に進むなら、マージ後に消した正常な形なので知らせない", () => {
    expect(decide({ branch: noPr({ branch_exists: false }) })).toEqual([
      warning("t1: The work branch was not found locally or on the remote"),
      REVIEWS,
    ]);
    expect(
      decide({
        ticket: { status: "review", pr: 42 },
        branch: withPr("merged", {}, { branch_exists: false }),
      }),
    ).toEqual([
      { kind: "update_ticket", advance: { from: "review", to: "done", when: ["pr_merged"] } },
      REVIEWS,
    ]);
  });

  it("境目が止めて done に進まなかったチケットでは、消えたブランチを知らせる", () => {
    const actions = decide({
      ticket: { status: "review", pr: 42 },
      workflow: withBoundaries([{ from: "review", to: "done", decide: "human_only" }]),
      branch: withPr("merged", {}, { branch_exists: false }),
    });
    expect(actions.at(1)).toEqual(
      warning("t1: The work branch was not found locally or on the remote"),
    );
  });

  it("review のチケットの PR がマージされずに閉じていたら知らせ、gh が PR はないと答えただけなら知らせない", () => {
    const review = { status: "review" } as const;
    expect(decide({ ticket: review, branch: withPr("closed") })).toEqual([
      warning("t1: The PR was closed without being merged"),
      recordPr,
      REVIEWS,
    ]);
    expect(decide({ ticket: review })).toEqual([REVIEWS]);
    // in_progress のチケットでは、閉じた PR を知らせない
    expect(decide({ branch: withPr("closed") })).toEqual([recordPr, REVIEWS]);
  });
});

describe("列の順と、手直しの Run を見る位置", () => {
  it("開いたままの手直しの Run は、チケットの書き換えの後、見直しの記録の前に見る。前進の先を添え、進まなければ添えない", () => {
    const settle = (advancedTo?: "review" | "done"): ReconcileAction => ({
      kind: "settle_fix_run",
      run: fixing().id,
      advancedTo,
    });
    expect(decide({ ticket: { pr: 42 }, branch: withPr(), running: [fixing()] })).toEqual([
      settle(),
      REVIEWS,
    ]);
    expect(decide({ ticket: { pr: 42 }, branch: withPr("open"), running: [fixing()] })).toEqual([
      {
        kind: "update_ticket",
        advance: { from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      },
      settle("review"),
      REVIEWS,
    ]);
    // 別のチケットの手直しの Run は見ない
    expect(decide({ running: [fixing({ ticket: "t2" })] })).toEqual([REVIEWS]);
  });

  it("行うことは、Run を閉じる・警告・チケットの書き換え・片付け・手直しの Run・見直しの記録・残った受け入れ条件の順に並ぶ", () => {
    const lines = { additions: 5, deletions: 1 };
    const head = "a".repeat(40);
    expect(
      decide({
        ticket: { status: "review" },
        branch: {
          ...withPr("merged", { prLines: lines, prMergedHead: head }, { branch_exists: false }),
          ignoredPr: { number: 9, state: "CLOSED", createdAt: BEFORE_RUN },
        },
        running: [implementing(), fixing()],
        unchecked: [1],
        deleteBranch: true,
      }).map((a) => (a.kind === "warn" ? a.message.slice(0, 12) : a.kind)),
    ).toEqual([
      "close_run",
      "t1: PR #9, f",
      "update_ticket",
      "remove_merged_work",
      "settle_fix_run",
      "record_reviews",
      "t1: acceptan",
    ]);
  });
});
