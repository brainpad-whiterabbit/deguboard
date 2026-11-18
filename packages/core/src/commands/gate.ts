// 品質ゲート（EX-3、ADR-011）。the "Quality gate" section of `dg guide review` のうち、記録と Git・PR の事実で判定できるものをコードで判定する。
// 判定は保存せず、呼ぶたびに事実から求める。dg pr ready・dg pr merge が gh を呼ぶ前に呼ぶ（pr.ts。EX-6）
// このファイルは事実を集めて（collectGateFacts）検査を回す（judgeCheck）。決めるのは gate-judge.ts の読まない関数

import { NEVER_OVERRIDDEN } from "./pr-approval.js";
import { z } from "zod";
import { fetchPrGateFacts, remoteTip } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import { gateLevelOf, parseAcceptance, type Ticket } from "../model/ticket.js";
import { readRunningRuns } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { judgeCheck, latestCommit } from "./gate-check.js";
import {
  FIX_ROUNDS_LIMIT,
  GATE_STAGES,
  concludeGate,
  gateReads,
  judgeBeforeCheck,
  type GateConditionId,
  type GateFacts,
  type GateStage,
  type GateView,
  type PrFact,
  type ReviewFacts,
} from "./gate-judge.js";
import { unlinkedReviewWarning } from "./hook-sessions.js";
import { ticketRef } from "./helpers.js";
import { orphanReviewRuns } from "./orphan-review.js";

/** 見直しの Run（閉じたものと、extra の実行中のものと持ち主のない保留）を開始の順に */
function reviewRuns(ctx: CommandContext, ticket: Ticket, extra: readonly Run[]): Run[] {
  return [...[...ctx.store.runs.values()].map((d) => d.data), ...extra]
    .filter((r) => r.ticket === ticket.id && r.step === REVIEW_STEP)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

/** PR の事実を gh で読む。チケットに PR の番号も作業ブランチもなければ gh を呼ばない */
async function readPrFact(ctx: CommandContext, ticket: Ticket): Promise<PrFact> {
  const selector = ticket.pr !== undefined ? String(ticket.pr) : ticket.branch;
  if (!selector) return { kind: "no_selector" };
  const facts = await fetchPrGateFacts(ctx.repo, selector);
  if ("reason" in facts) return { kind: "unreadable", reason: facts.reason };
  if ("missing" in facts) return { kind: "missing", selector };
  return { kind: "read", pr: facts.pr };
}

/** 見直しの事実（見直しの Run とリモートの先端）を読む。見直しの Run と push の時刻（fetch を含む）はここでだけ読む */
async function readReviewFacts(
  ctx: CommandContext,
  ticket: Ticket,
  warnings: string[],
): Promise<ReviewFacts> {
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const tip = ticket.branch
    ? await remoteTip(ctx.repo, ticket.branch, { fetch: true }).catch(() => undefined)
    : undefined;
  // フックが記録しなかった見直し（持ち主のない保留）も数える（dg next と同じ関数。orphan-review.ts）。コミットの時刻を読むので fetch の後
  const runs = reviewRuns(ctx, ticket, [
    ...running,
    ...(await orphanReviewRuns(ctx, ticket, running)),
  ]);
  const unlinked = unlinkedReviewWarning(ctx.env ?? process.env, ticket.id, runs, ticket.branch_at);
  if (unlinked) warnings.push(unlinked);
  return { tip: tip ?? null, runs };
}

/**
 * 品質ゲートの判定に使う事実を集める。段と for が判定しない条件の材料（見直しの Run・push の時刻とそのための fetch・
 * 受け入れ条件・作業ブランチの最新のコミット）は読まず、空の値で渡す（どれを読むかは gate-judge.ts の gateReads）。
 * gh・Git が読めなかったことも値で持つ（判定が満たさないとする）。
 * warnings には、フックが結ばなかった見直しを数えたときの警告を足す（t702。dg gate だけが渡す）
 */
export async function collectGateFacts(
  ctx: CommandContext,
  ticket: Ticket,
  stage: GateStage,
  warnings: string[] = [],
): Promise<GateFacts> {
  const level = gateLevelOf(ticket);
  const reads = gateReads(level, stage);
  const pr = await readPrFact(ctx, ticket);
  const acceptance = reads.acceptance
    ? (parseAcceptance(ctx.store.tickets.get(ticket.id)?.body ?? "") ?? [])
    : [];
  const review = reads.review
    ? await readReviewFacts(ctx, ticket, warnings)
    : { tip: null, runs: [] };
  // 作業ブランチの最新のコミットは、見直しの事実の fetch の後に読む（追跡 ref が進んだ後）。PR を読めなければ比べないので読まない
  const latest =
    reads.latest && pr.kind === "read" && ticket.branch
      ? ((await latestCommit(ctx, ticket.branch)) ?? null)
      : null;
  return {
    ticket: ticket.id,
    level,
    for: stage,
    recordedPr: ticket.pr ?? null,
    branchAt: ticket.branch_at,
    pr,
    acceptance,
    review,
    latest,
    checkConfigured: ctx.config.actions.test.length > 0,
  };
}

/**
 * チケットの品質ゲートを判定する：事実を集め（collectGateFacts）、検査のほかの条件を決め（judgeBeforeCheck）、
 * 検査を判定すると決まったときだけ回して（judgeCheck。時間がかかるので最後）、結論を出す（concludeGate）。
 * 判定する条件・読めない事実の扱い・waived（人の承認で越える条件。dg pr merge --approved-by だけが渡す）は gate-judge.ts
 */
export async function judgeGate(
  ctx: CommandContext,
  ticket: Ticket,
  stage: GateStage,
  warnings: string[] = [],
  waived: ReadonlySet<GateConditionId> = new Set(),
): Promise<GateView> {
  const facts = await collectGateFacts(ctx, ticket, stage, warnings);
  const draft = judgeBeforeCheck(facts, waived);
  return concludeGate(draft, draft.check === "judge" ? await judgeCheck(ctx, ticket) : undefined);
}

// 要件 EX-3（品質ゲートの判定）・TK-9（段ごとに判定する条件）
export const gate = defineCommand({
  name: "gate",
  positionals: ["ticket"],
  group: "gate",
  summary:
    "Judge the quality gate from records and the Git and PR facts, and return the result of each condition (conditions) and the reasons for any unmet one. The conditions are " +
    "pr (the PR is open; with --for merge, not a draft) · acceptance (with --for merge, every acceptance criterion is checked) · " +
    "review (the latest review of the work branch's remote tip has closed with success, and the run review-result result passed. A review counts for the tip when the SHA it recorded (the local tip of the work branch when the review Run was opened, or when a held result was written) is the remote tip's SHA. A review with no recorded SHA (an earlier version's Run) counts when it started after the time of the remote tip's commit) · " +
    "(a review result held with no review Run, while the ticket has no open review Run and no running sub-agent, counts as a review closed when the result was written; when several are held after the same push, only the latest counts) · " +
    `fix_rounds (reviews that raised heavy findings on this branch are at most ${FIX_ROUNDS_LIMIT} times) · mergeable (with --for merge, gh's mergeable is MERGEABLE) · ` +
    "head (with --for merge at high and low, the PR's head commit (sha in the output, which dg pr merge pins with --match-head-commit) is the latest commit of the work branch, the commit that review and check judge) · " +
    "check (config's actions.test passes when run in a worktree with no uncommitted changes, checked out at the latest commit of the work branch (remote tip). When the last commit whose actions.test passed is an ancestor of the latest commit, no merge commit came after it, actions.test is unchanged, and every file changed since then falls under actions.light_paths, the lighter check actions.light_test runs instead (with no such record yet, the diff against base decides the same way). Otherwise actions.test runs. detail gives which one ran and why. When actions.test is empty, it passes without judging and detail says so. When it fails, detail gives the exit code and the tail of the output. A passing result is remembered per commit and per command in deguboard-local and is not rerun for the same commit (it still counts after the worktree is removed, e.g. after a merge. A failing result is not remembered; the next check reruns it). It takes time, so it runs only when all the other conditions are met; not_run: true marks a check skipped because they were not met). " +
    "A condition that gh or Git cannot read is treated as unmet. " +
    "Which conditions are judged depends on the ticket's gate level (gate in the output; a ticket with no gate is high). " +
    "high judges all of them (--for merge: pr · acceptance · review · fix_rounds · mergeable · head · check; --for ready: pr · review · fix_rounds · check). " +
    "low leaves out review and fix_rounds (merge: pr · acceptance · mergeable · head · check; ready: pr · check). " +
    "free judges only pr and, with --for merge, mergeable (merge: pr · mergeable; ready: pr). At free, dg pr merge still pins the PR's head (sha), so a commit pushed after the judgment is not merged. Conditions that are not judged do not appear in conditions, and their inputs (review Runs, the push time and its fetch, the check) are not read. " +
    "Set the level with dg ticket create/import/update --gate; only a person can lower it (dg ticket update --gate from an agent is rejected when it lowers the level; fixed in Core). " +
    "--only check judges only check, with the same judgment, on the HEAD of the work branch's worktree (a commit not pushed yet is fine; uncommitted changes refuse it), whatever the level. Run it before the push. With --only, --for is not judged (the view only echoes it). The result is remembered per commit and command, so dg pr ready and dg pr merge after the push reuse it for the same commit. " +
    "dg pr ready and dg pr merge make the same judgment before they call gh. Proceeding outside the conditions of the level is left to a person: for a merge, a person approves it and dg pr merge --approved-by overrides unmet check, review, fix_rounds, and acceptance (fixed in Core; " +
    NEVER_OVERRIDDEN +
    "; dg pr merge --help); for ready, a person runs gh. They do not write ticket data (they only record the results of passed checks in deguboard-local)",
  input: z.object({
    ticket: ticketRef,
    for: z
      .enum(GATE_STAGES)
      .optional()
      .describe(
        "ready is before opening the PR (gh pr ready), merge is before merging (gh pr merge). Defaults to merge when omitted",
      ),
    only: z
      .enum(["check"])
      .optional()
      .describe(
        "check: run only the check condition on the work branch's worktree HEAD (before the push). See the summary. With it, for is not judged: the view only echoes it, and no merge conditions are judged",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    if (input.only === "check") {
      const check = await judgeCheck(ctx, ticket, { local: true });
      // --only check は検査の条件だけを返す（段に関係なく判定する）
      const view: GateView = {
        ticket: ticket.id,
        for: input.for ?? "merge",
        gate: gateLevelOf(ticket),
        pr: ticket.pr ?? null,
        sha: null,
        passed: check.ok,
        conditions: [{ id: "check", ok: check.ok, detail: check.detail }],
      };
      return ok(view);
    }
    const warnings: string[] = [];
    const view = await judgeGate(ctx, ticket, input.for ?? "merge", warnings);
    return ok(view, undefined, warnings);
  },
});

export const gateCommands = [gate];
