// チケットの作業の段階と次の 1 手（EX-3・EX-5、ADR-011）。Run・PR・ブランチの事実と Plan の待ちから都度求め、保存しない（Plan の進捗と同じ考え）。
// 段階を返すだけで、エージェントを起動も監視もしない（EX-1）。親は dg next の 1 手を行い、終えたらもう一度 dg next を呼ぶ

import { z } from "zod";
import { lastPushedAt } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import { DEFAULT_GATE_LEVEL, type Ticket } from "../model/ticket.js";
import type { Config } from "../model/config.js";
import type { PlanTier } from "../model/plan.js";
import { readRunningRuns } from "../run/record.js";
import { briefOf, type BriefRole } from "./brief.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { FIX_ROUNDS_LIMIT, heavyReviewRounds } from "./gate.js";
import { agentDg as dg, openPlanOf, ticketRef } from "./helpers.js";
import { planReadiness } from "./plan.js";
import { openedStepOf } from "./run.js";

/** 段階の名前。claimed → implemented → reviewed(n) → fixed(n) → ready → merged と、todo・blocked・reviewing・waiting_human・closed */
export const STAGES = [
  "todo",
  "blocked",
  "claimed",
  "implemented",
  "reviewing",
  "reviewed",
  "fixed",
  "ready",
  "merged",
  "waiting_human",
  "closed",
] as const;
export type StageName = (typeof STAGES)[number];

export interface Stage {
  name: StageName;
  /** このブランチで閉じた見直しの回数（reviewed(n) の n） */
  reviews: number;
  /** 重い指摘が出た見直しの回数（fixed(n) の n。修正ループの回数。dg gate の fix_rounds と同じ数え方） */
  fixes: number;
  /** 最後の push より後の見直しが通っているか（reviewed で ready と fix を分ける） */
  review_passed: boolean;
  /** 段階を決めた事実（1 文） */
  reason: string;
}

/** 次の 1 手の種類 */
export const NEXT_KINDS = [
  "implement",
  "review",
  "fix",
  "ready",
  "wait_merge",
  "wait_deps",
  "wait_human",
  "done",
] as const;
export type NextKind = (typeof NEXT_KINDS)[number];

export interface NextStep {
  ticket: string;
  stage: Stage;
  kind: NextKind;
  /** この手で開く Run の step（implement・review・fix。開かない手は null） */
  step: string | null;
  /** 今実行中の Run。この手の Run（続ける）か、待つべき実装・手直しの Run（待つ手だけ）。なければ null */
  running_run: string | null;
  pr: number | null;
  /** Plan の段階・範囲・方針（開いた Plan に入っていれば） */
  plan: { id: string; tier: string | null; scope: string | null; approach: string | null } | null;
  /** サブエージェントを起動するモデル（implement・fix の手。plan.tier を config の models.* に対応させ、空なら null は親のモデル）。ほかの手は null */
  model: string | null;
  /** この手で、親かエージェントが呼ぶ dg・gh のコマンド（順に） */
  commands: string[];
  /** 人に伝えて答えを待つこと（wait_human・wait_merge）。なければ null */
  ask_human: string | null;
  /** この手をサブエージェントに頼む文（implement・review・fix の手。dg brief と同じ）。実行中の Run を待つ手と、ほかの手は null */
  brief: string | null;
}

/** 手の種類のうち、サブエージェントに頼む文（brief）の役 */
const BRIEF_ROLE_OF: Partial<Record<NextKind, BriefRole>> = {
  implement: "implement",
  review: "review",
  fix: "fix",
};

/**
 * モデルを決める手。review は親のモデルで起動する（見直し役は品質ゲートを弱めない）。
 * 直す手（fix）は実装と同じモデル（the "Fix loop (parent)" section of `dg guide review`）
 */
const MODEL_KINDS: readonly NextKind[] = ["implement", "fix"];

/**
 * plan.tier を config の models.* のモデル名に対応させる。tier を省いた段階は standard（guide-plan の `--tier` と同じ）。
 * 対応の値が空なら null（親のモデル）
 */
export function modelOf(
  tier: PlanTier | null | undefined,
  models: Config["models"],
): string | null {
  return models[tier ?? "standard"] || null;
}

/** 実行中の Run を待つ（新しく起動しない）手。ほかの手（done・wait_deps・wait_merge など）は待たない */
const WAITABLE: readonly NextKind[] = ["implement", "review", "fix", "ready"];

/** 段階を求める材料（事実）。テストは事実を直に渡して求め方を確かめる */
export interface StageFacts {
  ticket: Pick<Ticket, "id" | "status" | "pr" | "branch" | "branch_at" | "gate">;
  /** Plan の待ち（after）と依存先の終わっていないもの */
  waiting: readonly string[];
  /** このチケットの Run（閉じたものと実行中のもの） */
  runs: readonly Run[];
  /** 実装の step（Workflow の opens_on: claim） */
  implementStep: string;
  /** 手直しの step（Workflow の opens_on: reclaim） */
  fixStep: string;
  /** 作業ブランチのリモートの先端のコミットの時刻。分からなければ undefined */
  pushedAt: string | undefined;
}

const stage = (
  name: StageName,
  reviews: number,
  fixes: number,
  reason: string,
  reviewPassed = false,
): Stage => ({ name, reviews, fixes, review_passed: reviewPassed, reason });

/**
 * 事実から段階を求める（純粋関数）。PR が draft かは status で見る：照合は draft でない PR が開いたときに review に進めるので、
 * in_progress のまま PR があれば draft とみなす（gh を呼ばない）
 */
export function stageOf(facts: StageFacts): Stage {
  const { ticket, runs } = facts;
  const since = ticket.branch_at ?? "";
  const reviews = runs
    .filter((r) => r.step === REVIEW_STEP && r.started_at >= since)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  const closedReviews = reviews.filter((r) => r.finished_at !== null);
  const fixes = heavyReviewRounds(reviews, ticket.branch_at);
  const n = closedReviews.length;
  if (ticket.status === "done") return stage("merged", n, fixes, "The ticket is done");
  if (ticket.status === "abandoned") return stage("closed", n, fixes, "The ticket is abandoned");
  const waitingRun = runs.find((r) => r.finished_at === null && r.waiting_since !== null);
  if (waitingRun)
    return stage(
      "waiting_human",
      n,
      fixes,
      `The ${waitingRun.step} Run ${waitingRun.id} has stopped and is waiting (since ${waitingRun.waiting_since})`,
    );
  if (ticket.status === "todo")
    return facts.waiting.length > 0
      ? stage("blocked", n, fixes, `Waiting on ${facts.waiting.join(", ")}`)
      : stage("todo", n, fixes, "Can be started");
  if (ticket.pr === undefined) return stage("claimed", n, fixes, "No PR yet");
  // low・free の段は見直しを判定しない（TK-9）ので、見直しと手直しの往復を飛ばす。
  // draft なら見直しが通ったものとして ready の手（dg pr ready）に、draft でなければマージを待つ
  const level = ticket.gate ?? DEFAULT_GATE_LEVEL;
  if (level !== "high")
    return ticket.status === "in_progress"
      ? stage(
          "reviewed",
          n,
          fixes,
          `The gate level is ${level}, so the review is skipped (the PR is a draft)`,
          true,
        )
      : stage(
          "ready",
          n,
          fixes,
          `The gate level is ${level}, so the review is skipped, and PR #${ticket.pr} was marked ready`,
          true,
        );
  const latest = reviews.at(-1);
  // 最後の見直しより後に閉じた手直しが failure か interrupted なら、人を待つ（the "How to finish" section of `dg guide review`）
  // 一番新しい手直しの Run だけを見る（人が続けると決めて開き直した手直しが成功していれば、前の失敗は見ない）
  const lastFix = runs
    .filter(
      (r) =>
        r.step === facts.fixStep &&
        r.started_at >= since &&
        (latest === undefined || r.started_at >= latest.started_at),
    )
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id))
    .at(-1);
  const failedFix =
    lastFix && (lastFix.result === "failure" || lastFix.result === "interrupted")
      ? lastFix
      : undefined;
  if (failedFix)
    return stage(
      "waiting_human",
      n,
      fixes,
      `The fix Run ${failedFix.id} closed with ${failedFix.result}`,
    );
  // 上限を超えたら、その後の push や見直しの結果によらず人を待つ（dg gate の fix_rounds が通さない）
  if (fixes > FIX_ROUNDS_LIMIT)
    return stage(
      "waiting_human",
      n,
      fixes,
      `Reviews with heavy findings happened ${fixes} times, over the limit of ${FIX_ROUNDS_LIMIT}`,
      latest?.review?.passed === true,
    );
  if (latest && latest.finished_at === null)
    return stage("reviewing", n, fixes, `The review Run ${latest.id} is running`);
  // 最後の push を読めない（追跡 ref がない・fetch しない ticket show）ときは、最後の見直しを今の見直しとみなす。
  // dg gate は読めない条件を満たさないとするので、ここで ready でも gate が止めることがある
  const pushedAt = facts.pushedAt;
  const current =
    latest && (pushedAt === undefined || latest.started_at >= pushedAt) ? latest : undefined;
  if (!current)
    return n === 0
      ? stage("implemented", n, fixes, `PR #${ticket.pr} exists and has no review yet`)
      : stage("fixed", n, fixes, "There is a push after the last review, and no new review yet");
  if (current.review === null || current.result !== "success")
    return stage(
      "fixed",
      n,
      fixes,
      `The last review ${current.id} has no result (${current.result ?? "not finished"}), so review again`,
    );
  if (!current.review.passed)
    return stage(
      "reviewed",
      n,
      fixes,
      `The review ${current.id} has ${current.review.heavy} heavy findings`,
    );
  return ticket.status === "in_progress"
    ? stage("reviewed", n, fixes, `The review ${current.id} passed (the PR is a draft)`, true)
    : stage("ready", n, fixes, `The review passed and PR #${ticket.pr} was marked ready`, true);
}

/** チケットの段階の事実を集める。fetch を渡せば作業ブランチを取り込んでから最後の push を読む */
export async function stageFactsOf(
  ctx: CommandContext,
  ticket: Ticket,
  opts: { fetch?: boolean } = {},
): Promise<StageFacts> {
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const runs = [...[...ctx.store.runs.values()].map((d) => d.data), ...running].filter(
    (r) => r.ticket === ticket.id,
  );
  const plan = openPlanOf(ctx.store, ticket.id);
  // Plan の待ち（after と依存先）。Plan がなければ依存先だけ（下で足す）
  const planWaits = plan
    ? (planReadiness(plan.data, (id) => ctx.store.tickets.get(id as Ticket["id"])?.data).waiting[
        ticket.id
      ] ?? [])
    : [];
  const pushedAt =
    ticket.branch && ticket.pr !== undefined
      ? await lastPushedAt(ctx.repo, ticket.branch, { fetch: opts.fetch ?? false }).catch(
          () => undefined,
        )
      : undefined;
  return {
    ticket,
    waiting: [...new Set([...planWaits, ...ctx.store.pendingDeps(ticket)])],
    runs,
    implementStep: openedStepOf(ctx, ticket, "claim"),
    fixStep: openedStepOf(ctx, ticket, "reclaim"),
    pushedAt,
  };
}

/** 段階から次の 1 手を求める */
export function nextOf(ctx: CommandContext, facts: StageFacts): NextStep {
  const st = stageOf(facts);
  const id = facts.ticket.id;
  const plan = openPlanOf(ctx.store, id);
  const details = plan?.data.details?.[id];
  const base = {
    ticket: id,
    stage: st,
    pr: facts.ticket.pr ?? null,
    plan: plan
      ? {
          id: plan.id,
          tier: details?.tier ?? null,
          scope: details?.scope ?? null,
          approach: details?.approach ?? null,
        }
      : null,
  };
  const fixStep = facts.fixStep;
  // このブランチで始まって実行中の Run（branch_at より前は使い回したブランチの前の作業）
  const since = facts.ticket.branch_at ?? "";
  const openRuns = facts.runs.filter((r) => r.finished_at === null && r.started_at >= since);
  // 手直しは、開始より後に push があれば直し終えたとみなす（見直しの開始がその Run を閉じる）
  const pushedAfterStart = (r: Run) =>
    facts.pushedAt !== undefined && facts.pushedAt >= r.started_at;
  // 最後の見直しより前に始まった手直しは、その見直しの前の作業（見直しが今の状態を見ている）
  const lastReviewAt = facts.runs
    .filter((r) => r.step === REVIEW_STEP && r.started_at >= since)
    .reduce((max, r) => (r.started_at > max ? r.started_at : max), "");
  // 待つべき手直しの Run：開始より後に push がなく、最後の見直しより後に始まったもの
  const liveFix = (r: Run) =>
    r.step === fixStep && !pushedAfterStart(r) && r.started_at >= lastReviewAt;
  const runningOf = (step: string) =>
    openRuns.find((r) => r.step === step && (step !== fixStep || liveFix(r)))?.id ?? null;
  // 待つべき実行中の Run：実装（ticket update --pr が閉じる）と、待つべき手直し。
  // 作業の途中で push が出ても、直し終えたか区別できないので、ここでは見直しを起動しない（guide-review）
  const working = openRuns.find((r) => r.step === facts.implementStep || liveFix(r))?.id ?? null;
  const make = (
    kind: NextKind,
    step: string | null,
    commands: string[],
    ask: string | null = null,
    running: string | null = step ? runningOf(step) : null,
  ): NextStep => {
    // その手の Run か待つべき Run が実行中なら、新しく起動せずに終わりを待つ（Run を重ねない）
    const awaited = WAITABLE.includes(kind) ? (running ?? working) : null;
    return {
      ...base,
      kind,
      step,
      running_run: running ?? awaited,
      // 印で頼んだサブエージェントの Run はフックが閉じる。親が先に閉じると、その後の作業と見直しの結果を失う（t638）
      commands: awaited
        ? [
            `Wait for the running Run ${awaited} to end (do not start another. For a sub-agent asked with the mark, wait for its completion notice. The hook closes the Run, so do not close it with run finish)`,
          ]
        : commands,
      model: MODEL_KINDS.includes(kind) ? modelOf(details?.tier, ctx.config.models) : null,
      ask_human: ask,
      brief: null,
    };
  };
  // フックがサブエージェントの Run を開け閉めする印（RN-7）。委譲する親は claim に --no-run を付け、印で頼む
  const marker = (step: string) =>
    `Put deguboard: ticket=${id} step=${step} on the first line of the text you give the sub-agent`;
  switch (st.name) {
    case "merged":
    case "closed":
      return make("done", null, []);
    case "blocked":
      return make("wait_deps", null, []);
    case "waiting_human": {
      const waiting = facts.runs.find((r) => r.finished_at === null && r.waiting_since !== null);
      return waiting
        ? make(
            "wait_human",
            waiting.step,
            [],
            `Send the stopped, waiting sub-agent a follow-up. If it stopped with a question, pass it to a person and send the answer. If it returned without a push, have it keep fixing or ask a person (${st.reason})`,
            waiting.id,
          )
        : make(
            "wait_human",
            null,
            [],
            `${st.reason}. Ask a person whether to keep fixing, mark it ready (a person runs gh pr ready), or stop`,
          );
    }
    case "todo":
      return make("implement", facts.implementStep, [
        dg(`ticket claim ${id} --branch <type>/<content> --no-run`),
        marker(facts.implementStep),
        // 文は claim の前に組むので、ブランチと worktree が空欄。claim の後に組み直して渡す
        `After claim, rebuild the text with ${dg(`brief ${id} --role implement`)} and pass that text (it then has the branch and worktree)`,
        dg(`ticket update ${id} --pr <number>`),
      ]);
    case "claimed":
      return make("implement", facts.implementStep, [
        marker(facts.implementStep),
        dg(`ticket update ${id} --pr <number>`),
      ]);
    case "implemented":
    case "fixed":
    case "reviewing":
      return make("review", REVIEW_STEP, [
        marker(REVIEW_STEP),
        dg(`run review-result ${id} --findings-file <file>`),
      ]);
    case "reviewed":
      return facts.ticket.status === "in_progress" && st.review_passed
        ? // dg pr ready が品質ゲートを判定してから gh pr ready を呼ぶ（t545）。
          // このブランチの見直しの Run が開いたままなら、ready にせず終わりを待つ（t664）。見直しの途中で段を low・free に
          // 下げたときに当たる。見直しの Run はフックが閉じるので、置いて進むと、ready・マージの後まで開いた Run が残り、ほかの手と重なる。
          // 終われば段が見直しを判定しないので、結果によらず ready の手になる
          make("ready", null, [dg(`pr ready ${id}`), dg("sync")], null, runningOf(REVIEW_STEP))
        : // 手直しの Run も印でフックが開く。理由は直すエージェントが run retry-reason で書き足す（RN-8）
          make("fix", fixStep, [
            marker(fixStep),
            `The fixing agent (the same model as the implementation) first runs ${dg(`run retry-reason ${id} --reason <summary of the finding to fix>`)}`,
            "Fix on the same branch and push",
          ]);
    case "ready":
      // マージは人を待つ手にする。自動でマージするのは auto.merge が true で品質ゲートを通った PR だけ（EX-7）
      return make(
        "wait_merge",
        null,
        [dg(`gate ${id} --for merge`)],
        `Ask a person to review and merge PR #${facts.ticket.pr} (if auto.merge is true, dg pr merge ${id} merges a PR that meets dg gate --for merge)`,
      );
  }
}

export const next = defineCommand({
  name: "next",
  positionals: ["ticket"],
  group: "next",
  summary:
    "Return the next step for a ticket (EX-3, EX-5). The stage (same as ticket show) is one of: todo (can be started), blocked (waiting on a Plan or on unfinished dependencies), " +
    "claimed (no PR), implemented (PR exists, no review), reviewing (a review is running), reviewed (the review after the last push has closed; review_passed says whether it passed), " +
    "fixed (a push after the last review, or the last review has no result), ready (the review passed and a PR was opened), merged (done), closed (abandoned), " +
    `waiting_human (a Run is waiting for a person, the fix after the last review closed with failure or interrupted, or reviews that raised heavy findings went past ${FIX_ROUNDS_LIMIT} times). Whether the PR is a draft is seen in status (a PR with in_progress is a draft). ` +
    "For a ticket whose gate level is low or free (TK-9), a PR skips the review: a draft is reviewed with review_passed (the ready step), otherwise ready (wait_merge). " +
    "The stage is derived from the facts of Runs (implementation, review, and fix Runs and their results, and the mark of waiting for a person), the PR, the work branch, and Plan waits. " +
    "It returns the kind of step (kind: implement, review, fix, ready, wait_merge, wait_deps, wait_human, done), the step to open, the Run in progress, the Plan's tier, scope, and approach, the commands to call (commands; delegate to a sub-agent. If the model is the same as the parent's and it proceeds on its own, the implement claim drops --no-run and does not use the mark. For implement, review, fix, and ready steps, if that step's Run is already running, or an implementation Run or a fix Run on this branch that has no push since it started is running (for the ready step, also a review Run on this branch, such as one left open when the gate level was lowered), it waits for that to end instead of starting another), and the questions to ask a person (ask_human). " +
    "For implement, review, and fix steps it includes the text to paste into a sub-agent (brief, the same as dg brief). " +
    "For implement and fix steps it includes the model to launch (model) (the Plan's tier maps to config's models.*; a ticket with no tier is standard. When the mapping is empty, and for review and other steps, it is null, meaning the parent's model). " +
    "A ticket in the waiting_human stage is wait_human. Read it after bringing in the work branch. It writes nothing",
  input: z.object({
    ticket: ticketRef,
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    const facts = await stageFactsOf(ctx, ticket, { fetch: true });
    const step = nextOf(ctx, facts);
    const role = BRIEF_ROLE_OF[step.kind];
    // 実行中の Run を待つ手には文を出さない（貼ると Run が重なる）。running_run が入るのは待つ手だけ
    if (!role || step.running_run !== null) return ok(step);
    const { brief, warnings } = await briefOf(ctx, ticket, role);
    return ok({ ...step, brief: brief.text }, undefined, warnings);
  },
});

export const nextCommands = [next];
