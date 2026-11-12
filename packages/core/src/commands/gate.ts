// 品質ゲート（EX-3、ADR-011）。the "Quality gate" section of `dg guide review` のうち、記録と Git・PR の事実で判定できるものをコードで判定する。
// 判定は保存せず、呼ぶたびに事実から求める。dg pr ready・dg pr merge が gh を呼ぶ前に呼ぶ（pr.ts。EX-6）

import { z } from "zod";
import { fetchPrGateFacts, remoteTip, type BranchTip } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import {
  gateLevelOf,
  gateScopeOf,
  parseAcceptance,
  type GateLevel,
  type Ticket,
} from "../model/ticket.js";
import { readRunningRuns } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { judgeCheck, latestCommit } from "./gate-check.js";
import { unlinkedReviewWarning } from "./hook-sessions.js";
import { ticketRef } from "./helpers.js";
import { orphanReviewRuns } from "./orphan-review.js";

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
  "head",
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
  /** 判定した PR の先端のコミット（gh の headRefOid）。PR を読めなければ null。dg pr merge はこの SHA を --match-head-commit で渡す（t750） */
  sha: string | null;
  passed: boolean;
  conditions: GateCondition[];
}

const short = (sha: string) => sha.slice(0, 8);

/** 見直しの Run（閉じたものと、extra の実行中のものと持ち主のない保留）を開始の順に */
function reviewRuns(ctx: CommandContext, ticket: Ticket, extra: readonly Run[]): Run[] {
  return [...[...ctx.store.runs.values()].map((d) => d.data), ...extra]
    .filter((r) => r.ticket === ticket.id && r.step === REVIEW_STEP)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

/**
 * 見直しが作業ブランチのリモートの先端（tip）を見直したか（t763）。見直した SHA（Run の head）があれば先端の SHA と同じか、
 * なければ（この項目より前の Run・読めなかった Run）見直しの開始が先端のコミットの時刻より後か（push した時刻は Git に残らないので近似）。
 * SHA で比べるのは、見直しの前に作って後で push したコミット・時計のずれ・古いコミットへの force-push を時刻では見分けられないため。
 * dg gate の review と dg next の段階が同じ関数で判定する
 */
export function reviewedTip(run: Pick<Run, "head" | "started_at">, tip: BranchTip): boolean {
  return run.head !== undefined ? run.head === tip.sha : run.started_at >= tip.at;
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
 * そのための fetch・検査）も読まない。warnings には、フックが結ばなかった見直しを数えたときの警告を足す（t702。dg gate だけが渡す）
 */
export async function judgeGate(
  ctx: CommandContext,
  ticket: Ticket,
  stage: GateStage,
  warnings: string[] = [],
): Promise<GateView> {
  const level = gateLevelOf(ticket);
  const scope = gateScopeOf(level);
  const conditions: GateCondition[] = [];
  const add = (id: GateConditionId, ok: boolean, detail: string) =>
    conditions.push({ id, ok, detail });

  // PR
  const selector = ticket.pr !== undefined ? String(ticket.pr) : ticket.branch;
  let prNumber: number | null = ticket.pr ?? null;
  let mergeable: string | undefined;
  let head: string | undefined;
  let prRead = false;
  if (!selector) add("pr", false, "The ticket has neither a PR nor a work branch");
  else {
    const facts = await fetchPrGateFacts(ctx.repo, selector);
    if ("reason" in facts) add("pr", false, `Cannot check the PR: ${facts.reason}`);
    else if ("missing" in facts) add("pr", false, `No PR (${selector})`);
    else {
      prNumber = facts.pr.number;
      mergeable = facts.pr.mergeable;
      head = facts.pr.head;
      prRead = true;
      if (facts.pr.state !== "OPEN")
        add("pr", false, `PR #${prNumber} is not open (${facts.pr.state})`);
      else if (stage === "merge" && facts.pr.isDraft)
        add("pr", false, `PR #${prNumber} is still a draft`);
      else add("pr", true, `PR #${prNumber} is open${facts.pr.isDraft ? " (draft)" : ""}`);
    }
  }

  // 受け入れ条件。PR を出す前は、付けられない項目の理由を PR の本文に書けばよいので見ない。段が判定しない（free）ときも見ない
  if (stage === "merge" && scope.acceptance) {
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

  // 見直しは段が判定するときだけ（high）
  if (scope.review) await judgeReview(ctx, ticket, add, warnings);

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

    // PR の先端は、見直しと検査が判定したブランチの最新のコミット（リモートの先端）と同じでなければならない（t750）。
    // 違えば判定していないコミットをマージすることになるので通さない。先端を読めないときは、見直し（review）と検査（check）が
    // 別の条件で落ちるので比べない。free は見直しも検査も判定しないので比べず、マージは判定した PR の先端（sha）に固定する
    if (prRead && (scope.review || scope.check)) {
      const tip = ticket.branch ? await latestCommit(ctx, ticket.branch) : undefined;
      if (tip !== undefined) {
        const same = head === tip;
        add(
          "head",
          same,
          same
            ? `PR #${prNumber}'s head ${short(tip)} is the latest commit of the work branch`
            : head === undefined
              ? `Cannot read the head commit of PR #${prNumber} from gh, so it cannot be compared with the work branch`
              : `PR #${prNumber}'s head ${short(head)} is not the latest commit of the work branch (${short(tip)}). Push or fetch so they match, then judge again`,
        );
      }
    }
  }

  // 検査（actions.test）。free は回さない。時間がかかるので、ほかの条件をすべて満たしたときだけ回す（空なら回さずに通すので、いつでも判定する）
  if (scope.check) {
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
    sha: head ?? null,
    passed: conditions.every((c) => c.ok),
    conditions,
  };
}

/** 見直しの条件（review・fix_rounds）を足す。見直しの Run と push の時刻（fetch を含む）はここでだけ読む */
async function judgeReview(
  ctx: CommandContext,
  ticket: Ticket,
  add: (id: GateConditionId, ok: boolean, detail: string) => void,
  warnings: string[],
): Promise<void> {
  // 見直し：リモートの先端を見直した最後の見直しが、閉じていて通っている
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const tip = ticket.branch
    ? await remoteTip(ctx.repo, ticket.branch, { fetch: true }).catch(() => undefined)
    : undefined;
  // フックが記録しなかった見直し（持ち主のない保留）も数える（dg next と同じ関数。orphan-review.ts）。コミットの時刻を読むので fetch の後
  const reviews = reviewRuns(ctx, ticket, [
    ...running,
    ...(await orphanReviewRuns(ctx, ticket, running)),
  ]);
  const unlinked = unlinkedReviewWarning(
    ctx.env ?? process.env,
    ticket.id,
    reviews,
    ticket.branch_at,
  );
  if (unlinked) warnings.push(unlinked);
  // リモートの先端と比べる（見直した SHA があれば SHA、なければ先端のコミットの時刻。reviewedTip）
  if (tip === undefined)
    add("review", false, "Cannot read the remote tip of the work branch (the last push)");
  else {
    const after = reviews.filter((r) => reviewedTip(r, tip));
    const latest = after.at(-1);
    if (!latest)
      add(
        "review",
        false,
        `No review of the last push (remote tip ${short(tip.sha)}, committed at ${tip.at})`,
      );
    else if (latest.finished_at === null)
      add("review", false, `Review ${latest.id} of the last push has not finished`);
    else if (latest.result !== "success")
      add("review", false, `Review ${latest.id} of the last push closed as ${latest.result}`);
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
    else add("review", true, `Review ${latest.id} of the last push passed`);
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
    "review (the latest review of the work branch's remote tip has closed with success, and the run review-result result passed. A review counts for the tip when the SHA it recorded (the local tip of the work branch when the review Run started, or when a held result was written) is the remote tip's SHA. A review with no recorded SHA (an earlier version's Run) counts when it started after the time of the remote tip's commit) · " +
    "(a review result held with no review Run, while the ticket has no open review Run and no running sub-agent, counts as a review closed when the result was written; when several are held after the same push, only the latest counts) · " +
    `fix_rounds (reviews that raised heavy findings on this branch are at most ${FIX_ROUNDS_LIMIT} times) · mergeable (with --for merge, gh's mergeable is MERGEABLE) · ` +
    "head (with --for merge at high and low, the PR's head commit (sha in the output, which dg pr merge pins with --match-head-commit) is the latest commit of the work branch, the commit that review and check judge) · " +
    "check (config's actions.test passes when run in a worktree with no uncommitted changes, checked out at the latest commit of the work branch (remote tip). When the last commit whose actions.test passed is an ancestor of the latest commit, no merge commit came after it, actions.test is unchanged, and every file changed since then falls under actions.light_paths, the lighter check actions.light_test runs instead (with no such record yet, the diff against base decides the same way). Otherwise actions.test runs. detail gives which one ran and why. When actions.test is empty, it passes without judging and detail says so. When it fails, detail gives the exit code and the tail of the output. A passing result is remembered per commit and per command in deguboard-local and is not rerun for the same commit (it still counts after the worktree is removed, e.g. after a merge. A failing result is not remembered; the next check reruns it). It takes time, so it runs only when all the other conditions are met). " +
    "A condition that gh or Git cannot read is treated as unmet. " +
    "Which conditions are judged depends on the ticket's gate level (TK-9; gate in the output; a ticket with no gate is high). " +
    "high judges all of them (--for merge: pr · acceptance · review · fix_rounds · mergeable · head · check; --for ready: pr · review · fix_rounds · check). " +
    "low leaves out review and fix_rounds (merge: pr · acceptance · mergeable · head · check; ready: pr · check). " +
    "free judges only pr and, with --for merge, mergeable (merge: pr · mergeable; ready: pr). At free, dg pr merge still pins the PR's head (sha), so a commit pushed after the judgment is not merged. Conditions that are not judged do not appear in conditions, and their inputs (review Runs, the push time and its fetch, the check) are not read. " +
    "Set the level with dg ticket create/import/update --gate; lowering it follows a person's instruction. " +
    "--only check judges only check, with the same judgment, on the HEAD of the work branch's worktree (a commit not pushed yet is fine; uncommitted changes refuse it), whatever the level. Run it before the push. With --only, --for is not judged (the view only echoes it). The result is remembered per commit and command, so dg pr ready and dg pr merge after the push reuse it for the same commit. " +
    "dg pr ready and dg pr merge make the same judgment before they call gh. Proceeding outside the conditions of the level is left to a person (a person runs gh). They do not write ticket data (they only record the results of passed checks in deguboard-local)",
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
