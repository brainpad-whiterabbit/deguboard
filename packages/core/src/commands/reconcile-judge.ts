// 照合（dg sync）が対象のチケットごとに行うことの決定（ST-4〜ST-6・RN-6・MT-6、ADR-028）。事実（TicketReconcileFacts）を受け取って
// 行うことの列（ReconcileAction）を返すだけで、git・gh・ファイルを読まない（import は型と定数と純粋な関数だけ）。
// 事実を集めるのは setup.ts の collectReconcileFacts（ロックの外）と reconcileAll（ロックの中の読み直し）で、列を上から順に行うのも
// reconcileAll。決定の組み合わせ（PR の有無と作成時刻と Run の開始の前後・前の作業の PR・止められた遷移・done への前進と消えたブランチ）は
// reconcile-judge.test.ts が git なしで確かめ、git を通すテスト（commands-flow-reconcile.test.ts）は経路の代表だけを見る
//   - 列の順は警告と書き込みの順になる（sync の warnings の並びと、1 件のチケットへの書き込みが 1 回であること）
//   - 手直しの Run の区切りと finished_at（最後の push の時刻を git に聞く）と、対象にならなかった実行中の Run の閉じ方は、
//     まだ行う側（reconcileAll）が決める。ここは手直しの Run を見る位置（settle_fix_run）だけを列に置く

import type { BranchFacts, PrLines } from "../git/facts.js";
import type { Status } from "../model/common.js";
import {
  OPENED_STEPS,
  type Run,
  type RunId,
  type RunResult,
  type StepOpener,
} from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import {
  reconcileStatus,
  regressionWarnings,
  type ReconcileOutcome,
} from "../workflow/reconcile.js";
import type { ResolvedWorkflow } from "../workflow/resolve.js";

/** 決定が読む実行中の Run の項目 */
export type RunningFact = Pick<Run, "id" | "ticket" | "step" | "started_at">;

/** 対象のチケット 1 件の照合を決めるのに要る事実 */
export interface TicketReconcileFacts {
  /** 照合の対象のチケット（作業ブランチを持ち、終わっていない）の、ロックの中で読み直した今の値 */
  ticket: Pick<Ticket, "id" | "status" | "pr" | "lines"> & { branch: string };
  /** 未チェックの受け入れ条件の番号（done にしたときに知らせる。TK-5） */
  unchecked: readonly number[];
  /** 依存するチケットがすべて終わっているか（事実の deps_done） */
  depsDone: boolean;
  workflow: ResolvedWorkflow;
  /** 作業ブランチの事実（git/facts.ts の collectBranchFacts がこのチケットの今の入力で読んだもの） */
  branch: BranchFacts;
  /** このマシンで実行中の Run（ほかのチケットのものを含んでよい） */
  running: readonly RunningFact[];
  /** config の merge.delete_branch（done にしたチケットの残りの worktree とブランチを消すか） */
  deleteBranch: boolean;
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
   * 実行中の Run を閉じる（RN-6）。finishedAt が undefined なら行う側が今の時刻で閉じる。
   * 別の文脈が先に閉じていたら、行う側は閉じずに警告して次へ進む（closeOpenedRunUnlessClosed）
   */
  | {
      kind: "close_run";
      run: RunId;
      opener: StepOpener;
      result: RunResult;
      finishedAt: string | undefined;
      error?: string;
    }
  /** sync の warnings に足す文（チケットの ID で始まる） */
  | { kind: "warn"; message: string }
  /** チケットを 1 回の書き込みで書き換える：見つけた PR の番号（ST-6）・マージされた PR の行数（MT-6）・前進（ST-4） */
  | { kind: "update_ticket"; pr?: number; lines?: PrLines; advance?: ReconcileAdvance }
  /** done にしたチケットの残りの worktree とブランチを、ロックを放した後に消す（ST-4。t849） */
  | { kind: "remove_merged_work"; branch: string; mergedHead: string | undefined }
  /**
   * 開いたままの手直しの Run を、区切りがあれば閉じる（RN-6）。区切りと finished_at は行う側が読んで決める。
   * advancedTo は今回の前進の先（前進しなければ undefined）
   */
  | { kind: "settle_fix_run"; run: RunId; advancedTo: Status | undefined }
  /** フックが記録しなかった見直し（持ち主のない保留）を、見直しの記録として書く（RN-9。数え方は orphan-review-judge.ts） */
  | { kind: "record_reviews" };

const warn = (id: string, text: string): ReconcileAction => ({
  kind: "warn",
  message: `${id}: ${text}`,
});

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
 *   4. 開いたままの手直しの Run と、持ち主のない保留の見直し
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
  if (fixing) actions.push({ kind: "settle_fix_run", run: fixing.id, advancedTo: advance?.to });
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
