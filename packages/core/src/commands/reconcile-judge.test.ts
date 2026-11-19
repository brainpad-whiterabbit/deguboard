// 照合が行うことの決定の組み合わせ（PR の有無と作成時刻と Run の開始の前後・前の作業の PR・止められた遷移・
// done への前進と消えたブランチ・手直しの Run の区切りと finished_at・終わった・戻った・取られたチケットに開いたままの Run）を、
// git・gh なしで確かめる。事実を集めて列を行う経路（gh の呼び方・ロック・コミットの題・push・別の文脈が先に閉じた Run）は
// commands-flow-reconcile.test.ts と commands-flow-reclaim.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import type { BranchFacts } from "../git/facts.js";
import type { Facts } from "../workflow/conditions.js";
import { DEFAULT_WORKFLOW } from "../workflow/resolve.js";
import { validateWorkflow } from "../workflow/validate.js";
import {
  decideOpenRunReconcile,
  decideTicketReconcile,
  type OpenRunFacts,
  type ReconcileAction,
  type RunningFact,
  type TicketReconcileFacts,
} from "./reconcile-judge.js";

/** 実装の Run の開始。時刻はすべてこのファイルの定数で、時計を読まない */
const RUN_AT = "2026-11-06T00:00:00Z";
const BEFORE_RUN = "2026-11-05T23:00:00Z";
const AFTER_RUN = "2026-11-06T02:00:00Z";
/** 手直しの Run の開始と、その前後 */
const FIX_AT = "2026-11-06T03:00:00Z";
const AFTER_FIX = "2026-11-06T03:30:00Z";
const NEXT_AT = "2026-11-06T04:00:00Z";
const AFTER_NEXT = "2026-11-06T04:30:00Z";
const MERGED_AT = "2026-11-06T05:00:00Z";

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
  implementing({ id: "r20261106-030000-bbbb", step: "fix", started_at: FIX_AT, ...over });
/** 手直しの Run の次の Run（見直し）。既定は手直しより後に始まった */
const reviewing = (over: Partial<RunningFact> = {}): RunningFact =>
  implementing({ id: "r20261106-040000-cccc", step: "review", started_at: NEXT_AT, ...over });

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

/**
 * 既定は、既定の Workflow の in_progress のチケット t1 で、PR も実行中の Run もない（行うことは見直しの記録だけ）。
 * 作業ブランチの最後の push は読めていて、push はない
 */
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
    recorded: [],
    lastPush: { at: undefined },
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

/** 手直しの Run を success で閉じる。basis は finished_at の根拠で、区切りの文と一緒に、閉じたときの知らせになる */
const closeFix = (finishedAt: string | undefined, why: string, basis: string): ReconcileAction => ({
  kind: "close_run",
  run: fixing().id,
  opener: "reclaim",
  result: "success",
  finishedAt,
  note: `t1: closed with ${why} as the boundary (${basis})`,
});
const BY_PUSH = "time of the last push";
const BY_BOUNDARY = "time of the boundary, since there was no push before it";
const BY_MERGE = "PR merge time, since there was no push";
const BY_NOW = "current time, since there was no push";
const nextRun = `start of the next Run ${reviewing().id}`;

describe("開いたままの手直しの Run（RN-6）", () => {
  /** PR #42（下書き）を記録済みの in_progress のチケット。照合は進めず、書き換えもしない */
  const drafted = { ticket: { pr: 42 }, branch: withPr() } as const;
  /** 下書きでなくなった PR。照合が review に進める */
  const ready = { ticket: { pr: 42 }, branch: withPr("open") } as const;
  const toReview: ReconcileAction = {
    kind: "update_ticket",
    advance: { from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
  };

  it("区切り（次の Run の開始・前進）がなければ、push があっても閉じない。手直しより前に始まった Run と別のチケットの Run は区切りにしない", () => {
    const pushed = { at: AFTER_FIX };
    expect(decide({ ...drafted, running: [fixing()], lastPush: pushed })).toEqual([REVIEWS]);
    expect(
      decide({
        ...drafted,
        running: [fixing(), reviewing({ ticket: "t2" })],
        recorded: [reviewing({ started_at: AFTER_RUN })],
        lastPush: pushed,
      }),
    ).toEqual([REVIEWS]);
    // 別のチケットの手直しの Run は見ない
    expect(decide({ ...ready, running: [fixing({ ticket: "t2" })] })).toEqual([toReview, REVIEWS]);
  });

  it("同じチケットの次の Run の開始を区切りに、それまでの最後の push の時刻で閉じる。次の Run は実行中でも記録済み（閉じた Run）でもよい", () => {
    const closed = closeFix(AFTER_FIX, nextRun, BY_PUSH);
    const lastPush = { at: AFTER_FIX };
    expect(decide({ ...drafted, running: [fixing(), reviewing()], lastPush })).toEqual([
      closed,
      REVIEWS,
    ]);
    expect(decide({ ...drafted, running: [fixing()], recorded: [reviewing()], lastPush })).toEqual([
      closed,
      REVIEWS,
    ]);
  });

  it("手直しの Run と同じ秒に始まった次の Run も区切りに数える（秒までの記録では前後を決められない）", () => {
    const same = reviewing({ started_at: FIX_AT });
    expect(decide({ ...drafted, running: [fixing(), same] })).toEqual([
      closeFix(FIX_AT, nextRun, BY_BOUNDARY),
      REVIEWS,
    ]);
  });

  it("次の Run が複数あれば、最も早く始まったものを区切りにする（実行中と記録済みをまたいで比べる）", () => {
    const later = reviewing({ id: "r20261106-043000-dddd", started_at: AFTER_NEXT });
    expect(
      decide({ ...drafted, running: [fixing(), later], recorded: [reviewing()] }).at(0),
    ).toEqual(closeFix(NEXT_AT, nextRun, BY_BOUNDARY));
  });

  it("finished_at は、手直しの開始から区切りまで（両端を含む）の push ならその時刻、開始より前か区切りより後の push なら区切りの時刻", () => {
    for (const [at, finishedAt, basis] of [
      [FIX_AT, FIX_AT, BY_PUSH],
      [AFTER_FIX, AFTER_FIX, BY_PUSH],
      [NEXT_AT, NEXT_AT, BY_PUSH],
      [AFTER_RUN, NEXT_AT, BY_BOUNDARY],
      [AFTER_NEXT, NEXT_AT, BY_BOUNDARY],
      [undefined, NEXT_AT, BY_BOUNDARY],
    ] as const) {
      expect(
        decide({ ...drafted, running: [fixing(), reviewing()], lastPush: { at } }).at(0),
      ).toEqual(closeFix(finishedAt, nextRun, basis));
    }
  });

  it("照合が今回進めるとき（PR の ready・マージ）は前進を区切りに、チケットの書き換えの後、見直しの記録の前で閉じる。push がなければ時刻を決めない（行う側が今の時刻にする）", () => {
    expect(decide({ ...ready, running: [fixing()], lastPush: { at: AFTER_FIX } })).toEqual([
      toReview,
      closeFix(AFTER_FIX, "advance to review", BY_PUSH),
      REVIEWS,
    ]);
    for (const at of [undefined, AFTER_RUN]) {
      expect(decide({ ...ready, running: [fixing()], lastPush: { at } })).toEqual([
        toReview,
        closeFix(undefined, "advance to review", BY_NOW),
        REVIEWS,
      ]);
    }
  });

  it("マージ（done への前進）の区切りでは、手直しの開始より後の push がなければ PR のマージ時刻で閉じ、マージ時刻も読めなければ時刻を決めない", () => {
    const review = { status: "review", pr: 42 } as const;
    const toDone = (branch: BranchFacts, at: string | undefined) =>
      decide({ ticket: review, branch, running: [fixing()], lastPush: { at } }).find(
        (a) => a.kind === "close_run",
      );
    const merged = withPr("merged", { prMergedAt: MERGED_AT });
    expect(toDone(merged, AFTER_FIX)).toEqual(closeFix(AFTER_FIX, "advance to done", BY_PUSH));
    expect(toDone(merged, undefined)).toEqual(closeFix(MERGED_AT, "advance to done", BY_MERGE));
    expect(toDone(merged, AFTER_RUN)).toEqual(closeFix(MERGED_AT, "advance to done", BY_MERGE));
    expect(toDone(withPr("merged"), undefined)).toEqual(
      closeFix(undefined, "advance to done", BY_NOW),
    );
  });

  it("次の Run の開始と前進の両方があれば、次の Run の開始を区切りにする", () => {
    expect(decide({ ...ready, running: [fixing(), reviewing()] })).toEqual([
      toReview,
      closeFix(NEXT_AT, nextRun, BY_BOUNDARY),
      REVIEWS,
    ]);
  });

  it("最後の push を今の作業ブランチで読んでいなければ、区切りがあっても閉じずに次の sync に回すと知らせ、区切りがなければ何も知らせない", () => {
    expect(decide({ ...ready, running: [fixing()], lastPush: undefined })).toEqual([
      toReview,
      warning(
        `t1: the last push of its work branch was not read for its current state, so the fix Run ${fixing().id} is closed at the next sync`,
      ),
      REVIEWS,
    ]);
    expect(decide({ ...drafted, running: [fixing()], lastPush: undefined })).toEqual([REVIEWS]);
  });
});

describe("対象のチケットを照合した後も開いたままの Run（RN-6）", () => {
  const ME = "eiki/agent";
  /** 既定は、自分の AI が claim した in_progress のチケット t1 の実装の Run（何もしない） */
  const decideOpen = (
    over: Partial<Omit<OpenRunFacts, "ticket">> & { ticket?: Partial<OpenRunFacts["ticket"]> } = {},
  ) =>
    decideOpenRunReconcile({
      run: implementing(),
      actor: ME,
      running: [],
      recorded: [],
      lastPush: { at: undefined },
      prCreated: undefined,
      ...over,
      ticket: { id: "t1", status: "in_progress", assignee: ME, ...over.ticket },
    });
  const closeImpl = (
    result: "success" | "failure",
    over: { finishedAt?: string; error?: string } = {},
  ): ReconcileAction => ({
    kind: "close_run",
    run: implementing().id,
    opener: "claim",
    result,
    finishedAt: over.finishedAt,
    ...(over.error !== undefined ? { error: over.error } : {}),
  });

  it("終わっていないチケットの、自分のユーザ（人とその AI）の claim の実装の Run は閉じない。担当のないチケットの Run も閉じない", () => {
    for (const status of ["in_progress", "review"] as const) {
      expect(decideOpen({ ticket: { status } })).toEqual([]);
      expect(decideOpen({ ticket: { status, assignee: "eiki" } })).toEqual([]);
      expect(decideOpen({ ticket: { status, assignee: undefined } })).toEqual([]);
    }
    expect(decideOpen({ actor: "eiki" })).toEqual([]);
  });

  it("todo に戻ったチケットの実装の Run は、担当によらず failure で閉じる（unclaim と同じ）", () => {
    for (const assignee of [undefined, ME, "hanako"]) {
      expect(decideOpen({ ticket: { status: "todo", assignee } })).toEqual([
        closeImpl("failure", { error: "Went back to todo during reconcile" }),
      ]);
    }
  });

  it("ほかの主体（別のユーザの人か AI）の claim になったチケットの実装の Run は failure で閉じる", () => {
    for (const assignee of ["hanako", "hanako/agent"]) {
      for (const status of ["in_progress", "review"] as const) {
        expect(decideOpen({ ticket: { status, assignee } })).toEqual([
          closeImpl("failure", { error: "Became claimed by another actor during reconcile" }),
        ]);
      }
    }
  });

  it("終わっていないチケットでは、手直しの Run とほかの step の Run を、todo でも別の主体の claim でも閉じない", () => {
    for (const run of [fixing(), reviewing()]) {
      for (const ticket of [
        { status: "todo" },
        { status: "in_progress", assignee: "hanako" },
      ] as const) {
        expect(decideOpen({ run, ticket, running: [run, reviewing()] })).toEqual([]);
      }
    }
  });

  it("終わったチケットの実装の Run は ticket move と同じ結果で閉じる：abandoned は PR があっても failure、PR のない done は success（時刻は行う側の今）", () => {
    expect(decideOpen({ ticket: { status: "abandoned" } })).toEqual([closeImpl("failure")]);
    expect(decideOpen({ ticket: { status: "abandoned", pr: 42, branch: "t1-work" } })).toEqual([
      closeImpl("failure"),
    ]);
    expect(decideOpen({ ticket: { status: "done" } })).toEqual([closeImpl("success")]);
    expect(decideOpen({ ticket: { status: "done", branch: "t1-work" } })).toEqual([
      closeImpl("success"),
    ]);
    // 別の主体の claim のまま終わったチケットでも、終わったチケットの閉じ方にする
    expect(decideOpen({ ticket: { status: "done", assignee: "hanako" } })).toEqual([
      closeImpl("success"),
    ]);
  });

  it("PR のある done の実装の Run は success で、Run の開始より後か同じ時刻の PR の作成時刻で閉じ、開始より前の作成時刻は使わない", () => {
    const ticket = { status: "done", pr: 42 } as const;
    for (const [createdAt, finishedAt] of [
      [AFTER_RUN, AFTER_RUN],
      [RUN_AT, RUN_AT],
      [BEFORE_RUN, undefined],
    ] as const) {
      expect(decideOpen({ ticket, prCreated: { createdAt } })).toEqual([
        closeImpl("success", finishedAt !== undefined ? { finishedAt } : {}),
      ]);
    }
  });

  it("PR のある done で、作成時刻を読めなかったら理由を知らせて時刻を決めずに閉じ、集めていなければ閉じずに次の sync に回すと知らせる", () => {
    const ticket = { status: "done", pr: 42 } as const;
    expect(decideOpen({ ticket, prCreated: { reason: "PR #42 not found" } })).toEqual([
      warning(
        "t1: cannot get the creation time of PR #42, so the implementation Run is closed at the current time (PR #42 not found)",
      ),
      closeImpl("success"),
    ]);
    expect(decideOpen({ ticket, prCreated: undefined })).toEqual([
      warning(
        "t1: the creation time of PR #42 was not read before the ticket was reconciled, so the implementation Run is closed at the next sync",
      ),
    ]);
  });

  it("終わったチケットの手直しの Run は、チケットの終了を区切りに success で閉じる。次の Run があればその開始が区切り。push がなければ時刻を決めない", () => {
    for (const status of ["done", "abandoned"] as const) {
      const ticket = { status, pr: 42, branch: "t1-work" };
      const finished = `ticket finished (${status})`;
      expect(decideOpen({ run: fixing(), ticket, running: [fixing()] })).toEqual([
        closeFix(undefined, finished, BY_NOW),
      ]);
      expect(
        decideOpen({ run: fixing(), ticket, running: [fixing()], lastPush: { at: AFTER_FIX } }),
      ).toEqual([closeFix(AFTER_FIX, finished, BY_PUSH)]);
      expect(
        decideOpen({
          run: fixing(),
          ticket,
          running: [fixing()],
          recorded: [reviewing()],
          lastPush: { at: AFTER_NEXT },
        }),
      ).toEqual([closeFix(NEXT_AT, nextRun, BY_BOUNDARY)]);
    }
  });

  it("終わったチケットの手直しの Run も、最後の push を今の作業ブランチで読んでいなければ閉じずに知らせる。ほかの step の Run は閉じない", () => {
    const ticket = { status: "done", pr: 42, branch: "t1-work" } as const;
    expect(decideOpen({ run: fixing(), ticket, lastPush: undefined })).toEqual([
      warning(
        `t1: the last push of its work branch was not read for its current state, so the fix Run ${fixing().id} is closed at the next sync`,
      ),
    ]);
    expect(decideOpen({ run: reviewing(), ticket })).toEqual([]);
  });
});

describe("列の順", () => {
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
      }).map((a) =>
        a.kind === "warn" ? a.message.slice(0, 12) : a.kind === "close_run" ? a.opener : a.kind,
      ),
    ).toEqual([
      "claim",
      "t1: PR #9, f",
      "update_ticket",
      "remove_merged_work",
      "reclaim",
      "record_reviews",
      "t1: acceptan",
    ]);
  });
});
