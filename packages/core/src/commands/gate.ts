// 品質ゲート（EX-3、ADR-011）。the "Quality gate" section of `dg guide review` のうち、記録と Git・PR の事実で判定できるものをコードで判定する。
// 判定は保存せず、呼ぶたびに事実から求める。dg pr ready・dg pr merge が gh を呼ぶ前に呼ぶ（pr.ts。EX-6）

import { z } from "zod";
import { fetchPrGateFacts, lastPushedAt } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import {
  DEFAULT_GATE_LEVEL,
  parseAcceptance,
  type GateLevel,
  type Ticket,
} from "../model/ticket.js";
import { readRunningRuns } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { judgeCheck } from "./gate-check.js";
import { ticketRef } from "./helpers.js";

/** 重い指摘を直す回数の上限（見直しは最初を含めて 3 回まで。the "Limit" section of `dg guide review`） */
export const FIX_ROUNDS_LIMIT = 2;

export const GATE_STAGES = ["ready", "merge"] as const;
export type GateStage = (typeof GATE_STAGES)[number];

export const GATE_CONDITIONS = [
  "pr",
  "acceptance",
  "review",
  "fix_rounds",
  "mergeable",
  "check",
] as const;
export type GateConditionId = (typeof GATE_CONDITIONS)[number];

export interface GateCondition {
  id: GateConditionId;
  ok: boolean;
  /** 判定の材料か、満たさない理由（1 文） */
  detail: string;
}

export interface GateView {
  ticket: string;
  /** ready は PR を出す前（gh pr ready）、merge はマージの前（gh pr merge） */
  for: GateStage;
  /** 判定した段（チケットの gate。ないときは high。TK-9） */
  gate: GateLevel;
  pr: number | null;
  passed: boolean;
  conditions: GateCondition[];
}

/** 見直しの Run（閉じたものと実行中のもの）を開始の順に */
function reviewRuns(ctx: CommandContext, ticket: Ticket, running: readonly Run[]): Run[] {
  return [...[...ctx.store.runs.values()].map((d) => d.data), ...running]
    .filter((r) => r.ticket === ticket.id && r.step === REVIEW_STEP)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

/**
 * 修正ループの回数：このブランチ（branch_at より後）の見直しのうち、結果に重い指摘が出た回の数。
 * 実行中でも結果を記録した見直しは数える（dg gate の fix_rounds と dg next の段階が同じ数を使う）
 */
export function heavyReviewRounds(runs: readonly Run[], branchAt: string | undefined): number {
  const since = branchAt ?? "";
  return runs.filter(
    (r) =>
      r.step === REVIEW_STEP && r.started_at >= since && r.review !== null && r.review.heavy > 0,
  ).length;
}

/**
 * チケットの品質ゲートを判定する。gh・Git が読めない条件は満たさないとする（判定できないものを通さない）。
 * 判定する条件はチケットの段（gate。TK-9）で決まる。high はすべて、low は見直し（review・fix_rounds）を除き、
 * free は pr と（マージの前の）mergeable だけ。判定しない条件は conditions に出さず、その材料（見直しの Run・push の時刻と
 * そのための fetch・検査）も読まない
 */
export async function judgeGate(
  ctx: CommandContext,
  ticket: Ticket,
  stage: GateStage,
): Promise<GateView> {
  const level = ticket.gate ?? DEFAULT_GATE_LEVEL;
  const conditions: GateCondition[] = [];
  const add = (id: GateConditionId, ok: boolean, detail: string) =>
    conditions.push({ id, ok, detail });

  // PR
  const selector = ticket.pr !== undefined ? String(ticket.pr) : ticket.branch;
  let prNumber: number | null = ticket.pr ?? null;
  let mergeable: string | undefined;
  if (!selector) add("pr", false, "The ticket has neither a PR nor a work branch");
  else {
    const facts = await fetchPrGateFacts(ctx.repo, selector);
    if ("reason" in facts) add("pr", false, `Cannot check the PR: ${facts.reason}`);
    else if ("missing" in facts) add("pr", false, `No PR (${selector})`);
    else {
      prNumber = facts.pr.number;
      mergeable = facts.pr.mergeable;
      if (facts.pr.state !== "OPEN")
        add("pr", false, `PR #${prNumber} is not open (${facts.pr.state})`);
      else if (stage === "merge" && facts.pr.isDraft)
        add("pr", false, `PR #${prNumber} is still a draft`);
      else add("pr", true, `PR #${prNumber} is open${facts.pr.isDraft ? " (draft)" : ""}`);
    }
  }

  // 受け入れ条件。PR を出す前は、付けられない項目の理由を PR の本文に書けばよいので見ない。free は見ない
  if (stage === "merge" && level !== "free") {
    const items = parseAcceptance(ctx.store.tickets.get(ticket.id)?.body ?? "") ?? [];
    const unchecked = items.filter((i) => !i.checked).map((i) => i.index);
    add(
      "acceptance",
      unchecked.length === 0,
      unchecked.length === 0
        ? `All ${items.length} acceptance criteria are marked`
        : `Acceptance criteria ${unchecked.join(", ")} are not marked`,
    );
  }

  // 見直しは high だけが判定する
  if (level === "high") await judgeReview(ctx, ticket, add);

  // base と衝突しない（マージの前だけ）
  if (stage === "merge") {
    if (mergeable === undefined)
      add("mergeable", false, "Cannot read the PR, so conflicts cannot be checked");
    else
      add(
        "mergeable",
        mergeable === "MERGEABLE",
        mergeable === "MERGEABLE"
          ? "No conflict with base"
          : `mergeable is ${mergeable} (there is a conflict, or it is still being computed. Wait a moment and check again)`,
      );
  }

  // 検査（actions.test）。free は回さない。時間がかかるので、ほかの条件をすべて満たしたときだけ回す（空なら回さずに通すので、いつでも判定する）
  if (level !== "free") {
    if (ctx.config.actions.test.length === 0 || conditions.every((c) => c.ok)) {
      const check = await judgeCheck(ctx, ticket);
      add("check", check.ok, check.detail);
    } else
      add(
        "check",
        false,
        "The other conditions are not met, so the check (actions.test) was not run",
      );
  }

  return {
    ticket: ticket.id,
    for: stage,
    gate: level,
    pr: prNumber,
    passed: conditions.every((c) => c.ok),
    conditions,
  };
}

/** 見直しの条件（review・fix_rounds）を足す。見直しの Run と push の時刻（fetch を含む）はここでだけ読む */
async function judgeReview(
  ctx: CommandContext,
  ticket: Ticket,
  add: (id: GateConditionId, ok: boolean, detail: string) => void,
): Promise<void> {
  // 見直し：最後の push より後に始めた見直しが、閉じていて通っている
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const reviews = reviewRuns(ctx, ticket, running);
  const pushedAt = ticket.branch
    ? await lastPushedAt(ctx.repo, ticket.branch, { fetch: true }).catch(() => undefined)
    : undefined;
  // 比べるのはリモートの先端のコミットの時刻（push した時刻ではない。facts.ts の lastPushedAt）
  if (pushedAt === undefined)
    add("review", false, "Cannot read the time of the last push of the work branch");
  else {
    const after = reviews.filter((r) => r.started_at >= pushedAt);
    const latest = after.at(-1);
    if (!latest) add("review", false, `No review after the last push (${pushedAt})`);
    else if (latest.finished_at === null)
      add("review", false, `Review ${latest.id} after the last push has not finished`);
    else if (latest.result !== "success")
      add("review", false, `Review ${latest.id} after the last push closed as ${latest.result}`);
    else if (latest.review === null)
      add(
        "review",
        false,
        `The result of review ${latest.id} is not recorded (dg run review-result)`,
      );
    else if (!latest.review.passed)
      add(
        "review",
        false,
        `Review ${latest.id} did not pass (${latest.review.heavy} heavy findings)`,
      );
    else add("review", true, `Review ${latest.id} after the last push passed`);
  }

  const rounds = heavyReviewRounds(reviews, ticket.branch_at);
  add(
    "fix_rounds",
    rounds <= FIX_ROUNDS_LIMIT,
    rounds <= FIX_ROUNDS_LIMIT
      ? `${rounds} review rounds found heavy findings (limit ${FIX_ROUNDS_LIMIT})`
      : `${rounds} review rounds found heavy findings, which exceeds the limit of ${FIX_ROUNDS_LIMIT}. Ask the human whether to continue`,
  );
}

export const gate = defineCommand({
  name: "gate",
  positionals: ["ticket"],
  group: "gate",
  summary:
    "Judge the quality gate from records and the Git and PR facts, and return the result of each condition (conditions) and the reasons for any unmet one (EX-3). The conditions are " +
    "pr (the PR is open; with --for merge, not a draft) · acceptance (with --for merge, every acceptance criterion is checked) · " +
    "review (a review Run that started after the time of the latest commit on the work branch's remote tip has closed with success, and the run review-result result passed) · " +
    `fix_rounds (reviews that raised heavy findings on this branch are at most ${FIX_ROUNDS_LIMIT} times) · mergeable (with --for merge, gh's mergeable is MERGEABLE) · ` +
    "check (config's actions.test passes when run in a worktree with no uncommitted changes, checked out at the latest commit of the work branch (remote tip). When every file in the diff against base falls under actions.light_paths, the lighter check actions.light_test runs instead, and detail gives which one ran and why. When actions.test is empty, it passes without judging and detail says so. When it fails, detail gives the exit code and the tail of the output. A passing result is remembered per commit and per command in deguboard-local and is not rerun for the same commit (it still counts after the worktree is removed, e.g. after a merge. A failing result is not remembered; the next check reruns it). It takes time, so it runs only when all the other conditions are met). " +
    "A condition that gh or Git cannot read is treated as unmet. " +
    "Which conditions are judged depends on the ticket's gate level (TK-9; gate in the output; a ticket with no gate is high). " +
    "high judges all of them (--for merge: pr · acceptance · review · fix_rounds · mergeable · check; --for ready: pr · review · fix_rounds · check). " +
    "low leaves out review and fix_rounds (merge: pr · acceptance · mergeable · check; ready: pr · check). " +
    "free judges only pr and, with --for merge, mergeable (merge: pr · mergeable; ready: pr). Conditions that are not judged do not appear in conditions, and their inputs (review Runs, the push time and its fetch, the check) are not read. " +
    "Set the level with dg ticket create/import/update --gate; lowering it follows a person's instruction. " +
    "dg pr ready and dg pr merge make the same judgment before they call gh. Proceeding outside the conditions of the level is left to a person (a person runs gh). They do not write ticket data (they only record the results of passed checks in deguboard-local)",
  input: z.object({
    ticket: ticketRef,
    for: z
      .enum(GATE_STAGES)
      .optional()
      .describe(
        "ready is before opening the PR (gh pr ready), merge is before merging (gh pr merge). Defaults to merge when omitted",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    return ok(await judgeGate(ctx, ticket, input.for ?? "merge"));
  },
});

export const gateCommands = [gate];
