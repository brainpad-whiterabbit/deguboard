// 照合（dg sync）が行うことの決定（ST-4〜ST-6・RN-6・MT-6、ADR-028）。事実を受け取って行うことの列（ReconcileAction）を
// 返すだけで、git・gh・ファイルを読まない（import は型と定数と純粋な関数だけ）。決めるのは 2 つ：
//   - decideTicketReconcile：対象のチケット（作業ブランチを持ち、終わっていない）ごとに行うこと
//   - decideOpenRunReconcile：その後も開いたままの実行中の Run（対象にならなかったチケットの Run と、上で閉じなかった Run）を
//     どう閉じるか。対象のチケットへの書き込みの後の値で決めるので、分けてある
// 事実を集めるのは setup.ts の collectReconcileFacts（ロックの外）と reconcileAll（ロックの中の読み直し）で、列を上から順に行うのも
// reconcileAll。決定の組み合わせ（PR の有無と作成時刻と Run の開始の前後・前の作業の PR・止められた遷移・done への前進と消えたブランチ・
// 手直しの Run の区切りと finished_at・終わった・戻った・取られたチケットの Run）は reconcile-judge.test.ts が git なしで確かめ、
// git を通すテスト（commands-flow-reconcile.test.ts・commands-flow-reclaim.test.ts）は経路の代表だけを見る
//   - 列の順は警告と書き込みの順になる（sync の warnings の並びと、1 件のチケットへの書き込みが 1 回であること）
//   - 持ち主のない保留の見直しは、書く位置（record_reviews）だけを列に置く（数え方は orphan-review-judge.ts）

import type { BranchFacts, PrLines } from "../git/facts.js";
import { sameUser } from "../model/actor.js";
import { isTerminal, type Status } from "../model/common.js";
import { OPENED_STEPS, type Run, type RunId } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import {
  reconcileStatus,
  regressionWarnings,
  type ReconcileOutcome,
} from "../workflow/reconcile.js";
import type { ResolvedWorkflow } from "../workflow/resolve.js";
import {
  fixRunFinishedAt,
  type CloseRunAction,
  RECONCILE_TAKEN_ERROR,
  RECONCILE_TODO_ERROR,
  runsClosedByMove,
} from "./run-close-judge.js";

/** 決定が読む Run の項目（実行中の Run と、索引にある記録済みの Run） */
export type RunningFact = Pick<Run, "id" | "ticket" | "step" | "started_at">;

/**
 * 作業ブランチに最後に push したコミットの時刻（git/facts.ts の lastPushedAt。push がない・読めない・作業ブランチのない
 * チケットは at が undefined）。開いたままの手直しの Run を閉じる finished_at にする
 */
export interface LastPushFact {
  at: string | undefined;
}

/** 開いたままの手直しの Run の区切りと finished_at を決めるのに要る事実（対象のチケットと、その後も開いたままの Run で同じ） */
export interface FixRunFacts {
  /** このマシンで実行中の Run（ほかのチケットのものと、この照合が閉じたものを含んでよい） */
  running: readonly RunningFact[];
  /** チケットの記録済みの Run（索引にあるもの）。手直しの Run の次の Run を探す。チケットに開いたままの手直しの Run がなければ空でよい */
  recorded: readonly RunningFact[];
  /**
   * チケットの今の作業ブランチで、ロックの外で読んだ最後の push。読んでいない（集めた後に手直しの Run を開いた・作業ブランチを
   * 付け替えた）ときは undefined で、手直しの Run は閉じずに次の sync に回す
   */
  lastPush: LastPushFact | undefined;
}

/** 対象のチケット 1 件の照合を決めるのに要る事実 */
export interface TicketReconcileFacts extends FixRunFacts {
  /** 照合の対象のチケット（作業ブランチを持ち、終わっていない）の、ロックの中で読み直した今の値 */
  ticket: Pick<Ticket, "id" | "status" | "pr" | "lines"> & { branch: string };
  /** 未チェックの受け入れ条件の番号（done にしたときに知らせる。TK-5） */
  unchecked: readonly number[];
  /** 依存するチケットがすべて終わっているか（事実の deps_done） */
  depsDone: boolean;
  workflow: ResolvedWorkflow;
  /** 作業ブランチの事実（git/facts.ts の collectBranchFacts がこのチケットの今の入力で読んだもの） */
  branch: BranchFacts;
  /** config の merge.delete_branch（done にしたチケットの残りの worktree とブランチを消すか） */
  deleteBranch: boolean;
}

/** ロックの外で読んだ PR の作成時刻（git/facts.ts の fetchPrCreatedAt。読めなければ理由） */
export type PrCreatedFact = { createdAt: string } | { createdAt?: undefined; reason: string };

/** 対象のチケットを照合した後も開いたままの実行中の Run 1 件を、どう閉じるか決めるのに要る事実 */
export interface OpenRunFacts extends FixRunFacts {
  /** このマシンで実行中の Run のうち、この照合がまだ閉じていないもの */
  run: RunningFact;
  /** その Run のチケットの今の値（対象のチケットへの書き込みの後） */
  ticket: Pick<Ticket, "id" | "status" | "pr" | "branch" | "assignee">;
  /** sync を呼んだ主体の ID。同じユーザ（人とその AI）の claim の Run は閉じない */
  actor: string;
  /** チケットの pr の作成時刻。集めていなければ（集めた後に PR のある done になった）undefined */
  prCreated: PrCreatedFact | undefined;
}

/** 照合がチケットを進めるときの前後の Status と、当てはまったきっかけの条件 */
export interface ReconcileAdvance {
  from: Status;
  to: Status;
  when: string[];
}

/** 照合が行うことの 1 つ。行う側は列を上から順に行う */
export type ReconcileAction =
  /**
   * 実行中の Run を閉じる（RN-6。形は run-close-judge.ts の CloseRunAction で、Run を開く操作が前の手直しの Run を閉じる決定と同じ）。
   * 別の文脈が先に閉じていたら、行う側は閉じずに警告して次へ進む（closeOpenedRunUnlessClosed）。note は sync の warnings に足す
   */
  | CloseRunAction
  /**
   * sync の warnings に足す文（チケットの ID で始まる）。run は、閉じずに次の sync に回すと決めた Run
   * （行う側は、その Run を同じ照合でもう一度決めない。settledRuns）
   */
  | { kind: "warn"; message: string; run?: RunId }
  /** チケットを 1 回の書き込みで書き換える：見つけた PR の番号（ST-6）・マージされた PR の行数（MT-6）・前進（ST-4） */
  | { kind: "update_ticket"; pr?: number; lines?: PrLines; advance?: ReconcileAdvance }
  /** done にしたチケットの残りの worktree とブランチを、ロックを放した後に消す（ST-4。t849） */
  | { kind: "remove_merged_work"; branch: string; mergedHead: string | undefined }
  /** フックが記録しなかった見直し（持ち主のない保留）を、見直しの記録として書く（RN-9。数え方は orphan-review-judge.ts） */
  | { kind: "record_reviews" };

/** Run を閉じるかどうかの決定が返す行うこと（閉じる・知らせる） */
export type RunAction = Extract<ReconcileAction, { kind: "close_run" | "warn" }>;

const warn = (id: string, text: string): RunAction => ({
  kind: "warn",
  message: `${id}: ${text}`,
});

/**
 * 開いたままの手直しの Run（もう一度の claim が開いた step。RN-5）を、区切りがあれば閉じる（RN-6）。手直しにはチケットの操作が
 * ないので、照合が区切りを見たときに、それまでの最後の push の時刻で閉じる。区切りは上から順に：
 *   - 同じチケットの次の Run の開始（実行中・記録済みを問わず、手直しの Run と同じ秒か後に始まったもののうち最も早いもの。
 *     普段は開いた openRun が先に閉じている。同じ秒を数える理由は run-close-judge.ts の startsAtOrAfterFixRun）
 *   - PR の ready（review への前進）・マージ（done への前進）。照合が今回進めるときに見る（advancedTo）
 *   - チケットが終わっている（別のマシンの照合や ticket move で done・abandoned になっていた）
 * finished_at は、この Run の開始より後で区切りまでの最後の push の時刻。その push がなければ区切りの時刻、マージの区切りでは
 * PR のマージ時刻（mergedAt）、それもなければ今（finishedAt は undefined）。区切りがなければ何もしない。
 * 最後の push を今の作業ブランチで読んでいなければ、閉じずに知らせる（ロックの中で git に聞き直さない）
 */
function fixRunActions(
  f: FixRunFacts,
  input: {
    ticket: string;
    /** チケットの今の Status（今回進めるなら進めた先） */
    status: Status;
    run: RunningFact;
    advancedTo?: Status | undefined;
    mergedAt?: string | undefined;
  },
): RunAction[] {
  const { ticket, run } = input;
  const later = [...f.running, ...f.recorded]
    .filter((r) => r.id !== run.id && r.ticket === ticket && r.started_at >= run.started_at)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
  const boundary: { at?: string; why: string } | undefined = later
    ? { at: later.started_at, why: `start of the next Run ${later.id}` }
    : input.advancedTo !== undefined
      ? { why: `advance to ${input.advancedTo}` }
      : isTerminal(input.status)
        ? { why: `ticket finished (${input.status})` }
        : undefined;
  if (!boundary) return [];
  if (!f.lastPush)
    return [
      {
        ...warn(
          ticket,
          `the last push of its work branch was not read for its current state, so the fix Run ${run.id} is closed at the next sync`,
        ),
        run: run.id,
      },
    ];
  const { finishedAt, pushed } = fixRunFinishedAt({
    pushedAt: f.lastPush.at,
    startedAt: run.started_at,
    boundaryAt: boundary.at,
    fallback: input.mergedAt,
  });
  const basis = pushed
    ? "time of the last push"
    : boundary.at !== undefined
      ? "time of the boundary, since there was no push before it"
      : input.mergedAt !== undefined
        ? "PR merge time, since there was no push"
        : "current time, since there was no push";
  return [
    {
      kind: "close_run",
      run: run.id,
      opener: "reclaim",
      result: "success",
      finishedAt,
      note: `${ticket}: closed with ${boundary.why} as the boundary (${basis})`,
    },
  ];
}

/**
 * 作業ブランチの PR があれば実装は終わっている。実行中の実装の Run を PR の作成時刻で閉じる（RN-6）。
 * 実装は PR を作るまでなので、PR がマージされずに閉じていても success にする。
 * 記録済みの番号で引いた PR でも閉じる（番号を記録したときに閉じられなかった Run の拾い直し）。
 * PR より後に開き直した Run は PR では終わらないので、閉じずに知らせる（PR の後の作業はもう一度の claim で手直しの Run にする）。
 * 作成時刻を読めなかった PR では、今の時刻で閉じる（finishedAt は undefined）
 */
function implementationRunActions(f: TicketReconcileFacts): ReconcileAction[] {
  const { pr, prCreatedAt } = f.branch;
  if (pr === undefined) return [];
  const implementing = f.running.find(
    (r) => r.ticket === f.ticket.id && r.step === OPENED_STEPS.claim,
  );
  if (!implementing) return [];
  if (prCreatedAt !== undefined && prCreatedAt < implementing.started_at)
    return [
      warn(
        f.ticket.id,
        `implementation Run ${implementing.id} started after PR #${pr} was created (${prCreatedAt}), so reconcile does not close it. When it is finished, close it with run finish (work after the PR becomes a fix Run, by claiming again)`,
      ),
    ];
  return [
    {
      kind: "close_run",
      run: implementing.id,
      opener: "claim",
      result: "success",
      finishedAt: prCreatedAt,
    },
  ];
}

/** きっかけは当てはまったが境目の方針が止めたチケットの、止めた理由と人の進め方（ST-4） */
function blockedWarning(
  ticket: TicketReconcileFacts["ticket"],
  outcome: Extract<ReconcileOutcome, { kind: "blocked" }>,
): ReconcileAction {
  const unmet = outcome.unmet.length > 0;
  const why = [
    ...(unmet ? [`the conditions are not met: ${outcome.unmet.join(", ")}`] : []),
    ...(outcome.humanOnly ? ["the Workflow limits the move to a person (human_only)"] : []),
  ].join(", and ");
  const move = `ticket move ${ticket.id} ${outcome.to}`;
  return warn(
    ticket.id,
    `the facts (${outcome.trigger.when.join(", ")}) point from ${ticket.status} to ${outcome.to}, but reconcile does not advance it, because ${why} (${outcome.policy}). ` +
      (outcome.humanOnly
        ? `A person moves it with ${move}${unmet ? ' --override "reason"' : ""}`
        : `It advances at a sync after the conditions are met; a person can go ahead without them with ${move} --override "reason"`),
  );
}

/**
 * 対象のチケット 1 件について、照合が行うことの列を決める。順は次のとおり：
 *   1. PR による実装の Run（閉じるか、PR より後に始まったと知らせる）
 *   2. 警告：外した前の作業の PR、止められた遷移、後退を指す事実（消えたブランチ・閉じた PR）
 *   3. チケットの書き換え（pr・lines・前進を 1 回で）と、done にしたチケットの片付け
 *   4. 開いたままの手直しの Run（区切りがあれば閉じる）と、持ち主のない保留の見直し
 *   5. done にしたときに残っていた受け入れ条件の知らせ
 */
export function decideTicketReconcile(f: TicketReconcileFacts): ReconcileAction[] {
  const { ticket } = f;
  const { pr, prMergedHead, prLines, prMissing, ignoredPr } = f.branch;
  const facts = { ...f.branch.facts, deps_done: f.depsDone };
  const actions: ReconcileAction[] = [...implementationRunActions(f)];
  if (ignoredPr)
    actions.push(
      warn(
        ticket.id,
        `PR #${ignoredPr.number}, found by branch name, is ${ignoredPr.state.toLowerCase()} and was created (${ignoredPr.createdAt}) before the branch was recorded. It is taken as a PR of earlier work with the same name, so reconcile does not use it. If this PR belongs to this ticket, record it with ticket update ${ticket.id} --pr ${ignoredPr.number}, then run sync again to reconcile it. If it belongs to earlier work, do nothing`,
      ),
    );
  const outcome = reconcileStatus(f.workflow, ticket.status, facts, { pr: ticket.pr ?? pr });
  // きっかけは当てはまったが境目の方針が止めたチケットは、書き換えずに知らせる
  if (outcome.kind === "blocked") actions.push(blockedWarning(ticket, outcome));
  const advance: ReconcileAdvance | undefined =
    outcome.kind === "advance"
      ? { from: ticket.status, to: outcome.to, when: [...outcome.trigger.when] }
      : undefined;
  // done に進むなら、消えたブランチは正常（マージ後に消した）なので警告しない
  if (advance?.to !== "done") {
    for (const w of regressionWarnings(ticket.status, facts, { prMissing }))
      actions.push(warn(ticket.id, w));
  }
  // ブランチ名で見つけた PR の番号は、状態が進まなくても記録する（記録済みなら触れない）。
  // マージされた PR の行数も、状態が done に進まなくても記録する（記録済みなら触れない。MT-6）
  const recordPr = pr !== undefined && ticket.pr === undefined ? pr : undefined;
  const recordLines = prLines !== undefined && ticket.lines === undefined ? prLines : undefined;
  if (recordPr !== undefined || recordLines !== undefined || advance)
    actions.push({
      kind: "update_ticket",
      ...(recordPr !== undefined ? { pr: recordPr } : {}),
      ...(recordLines !== undefined ? { lines: recordLines } : {}),
      ...(advance ? { advance } : {}),
    });
  // done にしたチケットの残りの worktree とブランチは、ロックを放した後に消す（設定が true のときだけ。t849）
  if (advance?.to === "done" && f.deleteBranch)
    actions.push({ kind: "remove_merged_work", branch: ticket.branch, mergedHead: prMergedHead });
  // 開いたままの手直しの Run は、次の Run の開始・PR の ready・マージの区切りで閉じる（RN-6）
  const fixing = f.running.find((r) => r.ticket === ticket.id && r.step === OPENED_STEPS.reclaim);
  if (fixing)
    actions.push(
      ...fixRunActions(f, {
        ticket: ticket.id,
        status: advance?.to ?? ticket.status,
        run: fixing,
        advancedTo: advance?.to,
        mergedAt: f.branch.prMergedAt,
      }),
    );
  actions.push({ kind: "record_reviews" });
  // 遷移は止めず、受け入れ条件の確認が残っていることだけ知らせる（TK-5）
  if (advance?.to === "done" && f.unchecked.length > 0)
    actions.push(
      warn(
        ticket.id,
        `acceptance criteria items ${f.unchecked.join(", ")} were left unchecked when the ticket became done`,
      ),
    );
  return actions;
}

/**
 * 対象のチケットの列が、もう決めた Run（閉じる・閉じずに次の sync に回す）。行う側は、その後も開いたままの Run を決めるときに
 * これらを飛ばす。飛ばさないと、今回 done に進んだチケットで閉じなかった手直しの Run（最後の push を読んでいない）と、
 * 別の文脈が先に閉じた Run を、終わったチケットの Run としてもう一度決めて、同じ警告が sync の warnings に 2 つ並ぶ
 */
export function settledRuns(actions: readonly ReconcileAction[]): RunId[] {
  return actions.flatMap((a) =>
    (a.kind === "close_run" || a.kind === "warn") && a.run !== undefined ? [a.run] : [],
  );
}

/**
 * 終わったチケットに開いたままの実装の Run（RN-6）。ticket move と同じ結果で閉じる（abandoned は failure、PR のない done は success）。
 * PR のある done は、PR を見つけた別のマシンの照合が done にした後の残りなので、PR の発見と同じく success で、finished_at は
 * PR の作成時刻（Run の開始より前なら使わず、読めなければ知らせて、今の時刻）。作成時刻を集めていなければ、閉じずに次の sync に回す
 */
function finishedTicketImplementationActions(f: OpenRunFacts): RunAction[] {
  const { ticket, run } = f;
  const ends = runsClosedByMove(ticket, ticket.status);
  if (ends?.openers.includes("claim"))
    return [
      {
        kind: "close_run",
        run: run.id,
        opener: "claim",
        result: ends.result,
        finishedAt: undefined,
      },
    ];
  if (ticket.status !== "done" || ticket.pr === undefined) return [];
  const created = f.prCreated;
  if (!created)
    return [
      warn(
        ticket.id,
        `the creation time of PR #${ticket.pr} was not read before the ticket was reconciled, so the implementation Run is closed at the next sync`,
      ),
    ];
  const finishedAt =
    created.createdAt !== undefined && created.createdAt >= run.started_at
      ? created.createdAt
      : undefined;
  return [
    ...(created.createdAt === undefined
      ? [
          warn(
            ticket.id,
            `cannot get the creation time of PR #${ticket.pr}, so the implementation Run is closed at the current time (${created.reason})`,
          ),
        ]
      : []),
    { kind: "close_run", run: run.id, opener: "claim", result: "success", finishedAt },
  ];
}

/**
 * 対象のチケットを照合した後も開いたままの実行中の Run 1 件を、どう閉じるか決める（RN-6）。照合の対象にならなかったチケット
 * （終わった・作業ブランチのない）の Run と、対象のチケットで閉じなかった Run を、チケットの今の値で見る：
 *   - 終わったチケットの手直しの Run は、次の Run の開始かチケットの終了を区切りに success（fixRunActions）
 *   - 終わったチケットの実装の Run は、ticket move と同じ結果。PR のある done は PR の作成時刻で success
 *   - todo に戻ったチケットと、ほかの主体の claim になったチケットの実装の Run は failure（unclaim と同じ）
 * 終わっていないチケットの手直しの Run と、自分のユーザの claim の実装の Run、ほかの step の Run は触らない
 */
export function decideOpenRunReconcile(f: OpenRunFacts): RunAction[] {
  const { ticket, run } = f;
  if (isTerminal(ticket.status)) {
    if (run.step === OPENED_STEPS.reclaim)
      return fixRunActions(f, { ticket: ticket.id, status: ticket.status, run });
    if (run.step === OPENED_STEPS.claim) return finishedTicketImplementationActions(f);
    return [];
  }
  if (run.step !== OPENED_STEPS.claim) return [];
  // error は定数の名前をここに書く（web の l10n.test.ts が、core のソースで error に渡す定数を拾って訳の表と突き合わせる）
  const failure = { kind: "close_run", run: run.id, opener: "claim", result: "failure" } as const;
  if (ticket.status === "todo")
    return [{ ...failure, finishedAt: undefined, error: RECONCILE_TODO_ERROR }];
  if (ticket.assignee !== undefined && !sameUser(ticket.assignee, f.actor))
    return [{ ...failure, finishedAt: undefined, error: RECONCILE_TAKEN_ERROR }];
  return [];
}
