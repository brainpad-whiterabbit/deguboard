// チケットの作業の段階と次の 1 手（EX-3、ADR-011）。Run・PR・ブランチの事実と Plan の待ちから都度求め、保存しない（Plan の進捗と同じ考え）。
// 段階を返すだけで、エージェントを起動も監視もしない（ADR-004）。親は dg next の 1 手を行い、終えたらもう一度 dg next を呼ぶ

import { z } from "zod";
import { lastPushedAt } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import { readRunningRuns } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { FIX_ROUNDS_LIMIT, heavyReviewRounds } from "./gate.js";
import { openPlanOf, ticketRef } from "./helpers.js";
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
  /** 今実行中のこの手の Run（続ける）。なければ null */
  running_run: string | null;
  pr: number | null;
  /** Plan の段階・範囲・方針（開いた Plan に入っていれば） */
  plan: { id: string; tier: string | null; scope: string | null; approach: string | null } | null;
  /** この手で、親かエージェントが呼ぶ dg・gh のコマンド（順に） */
  commands: string[];
  /** 人に伝えて答えを待つこと（wait_human・wait_merge）。なければ null */
  ask_human: string | null;
}

/** 段階を求める材料（事実）。テストは事実を直に渡して求め方を確かめる */
export interface StageFacts {
  ticket: Pick<Ticket, "id" | "status" | "pr" | "branch" | "branch_at">;
  /** Plan の待ち（after）と依存先の終わっていないもの */
  waiting: readonly string[];
  /** このチケットの Run（閉じたものと実行中のもの） */
  runs: readonly Run[];
  /** 実装の step（Workflow の opens_on: claim） */
  implementStep: string;
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
  if (ticket.status === "done") return stage("merged", n, fixes, "チケットが done");
  if (ticket.status === "abandoned") return stage("closed", n, fixes, "チケットが abandoned");
  const waitingRun = runs.find((r) => r.finished_at === null && r.waiting_since !== null);
  if (waitingRun)
    return stage(
      "waiting_human",
      n,
      fixes,
      `${waitingRun.step} の Run ${waitingRun.id} が止まって待っている（${waitingRun.waiting_since} から）`,
    );
  if (ticket.status === "todo")
    return facts.waiting.length > 0
      ? stage("blocked", n, fixes, `${facts.waiting.join("・")} を待っている`)
      : stage("todo", n, fixes, "着手できる");
  if (ticket.pr === undefined) return stage("claimed", n, fixes, "PR がまだない");
  const latest = reviews.at(-1);
  if (latest && latest.finished_at === null)
    return stage("reviewing", n, fixes, `見直しの Run ${latest.id} が実行中`);
  // 最後の push を読めない（追跡 ref がない・fetch しない ticket show）ときは、最後の見直しを今の見直しとみなす。
  // dg gate は読めない条件を満たさないとするので、ここで ready でも gate が止めることがある
  const pushedAt = facts.pushedAt;
  const current =
    latest && (pushedAt === undefined || latest.started_at >= pushedAt) ? latest : undefined;
  if (!current)
    return n === 0
      ? stage("implemented", n, fixes, `PR #${ticket.pr} があり、見直しがまだない`)
      : stage("fixed", n, fixes, "最後の見直しの後に push があり、見直し直しがまだない");
  if (current.review === null || current.result !== "success")
    return stage(
      "fixed",
      n,
      fixes,
      `最後の見直し ${current.id} の結果がない（${current.result ?? "未完了"}）ので、見直し直す`,
    );
  // 上限を超えたら、最後の見直しが通っていても人を待つ（dg gate の fix_rounds が通さない）
  if (fixes > FIX_ROUNDS_LIMIT)
    return stage(
      "waiting_human",
      n,
      fixes,
      `重い指摘が出た見直しが ${fixes} 回で、上限 ${FIX_ROUNDS_LIMIT} を超えた`,
      current.review.passed,
    );
  if (!current.review.passed)
    return stage(
      "reviewed",
      n,
      fixes,
      `見直し ${current.id} で重い指摘 ${current.review.heavy} 件`,
    );
  return ticket.status === "in_progress"
    ? stage("reviewed", n, fixes, `見直し ${current.id} が通った（PR は draft）`, true)
    : stage("ready", n, fixes, `見直しが通り、PR #${ticket.pr} を出した`, true);
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
    pushedAt,
  };
}

/** 段階から次の 1 手を求める */
export function nextOf(ctx: CommandContext, ticket: Ticket, facts: StageFacts): NextStep {
  const st = stageOf(facts);
  const id = ticket.id;
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
  const runningOf = (step: string) =>
    facts.runs.find((r) => r.step === step && r.finished_at === null)?.id ?? null;
  const fixStep = openedStepOf(ctx, ticket, "reclaim");
  const make = (
    kind: NextKind,
    step: string | null,
    commands: string[],
    ask: string | null = null,
    running: string | null = step ? runningOf(step) : null,
  ): NextStep => ({ ...base, kind, step, running_run: running, commands, ask_human: ask });
  const dg = (args: string) => `dg --json --actor agent ${args}`;
  // フックがサブエージェントの Run を開け閉めする印（ADR-012）。委譲する親は claim に --no-run を付け、印で頼む
  const marker = (step: string) =>
    `サブエージェントに頼む文の最初の行に deguboard: ticket=${id} step=${step}`;
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
            `止まって待っているサブエージェントの質問を人に伝え、答えを続きとして送る（${st.reason}）`,
            waiting.id,
          )
        : make(
            "wait_human",
            null,
            [],
            `${st.reason}。続けて直すか・ready にするか（人に gh pr ready を打ってもらう）・やめるかを人に聞く`,
          );
    }
    case "todo":
      return make("implement", facts.implementStep, [
        dg(`ticket claim ${id} --branch <種類>/<内容> --no-run`),
        marker(facts.implementStep),
        dg(`ticket update ${id} --pr <番号>`),
      ]);
    case "claimed":
      return make("implement", facts.implementStep, [
        marker(facts.implementStep),
        dg(`ticket update ${id} --pr <番号>`),
      ]);
    case "implemented":
    case "fixed":
    case "reviewing":
      return make("review", REVIEW_STEP, [
        marker(REVIEW_STEP),
        dg(`run review-result ${id} --heavy <数> --light <数> [--passed]`),
      ]);
    case "reviewed":
      return facts.ticket.status === "in_progress" && st.review_passed
        ? make("ready", null, [
            dg(`gate ${id} --for ready`),
            `gh pr ready ${facts.ticket.pr}`,
            dg("sync"),
          ])
        : // 手直しの Run は直すエージェント自身のもう一度の claim が開く（guide-review）。親が印で頼むと Run が重なるので、印は付けない
          make("fix", fixStep, [
            `直すエージェント（実装と同じモデル）が最初に ${dg(`ticket claim ${id} --retry-reason <直す指摘の要約>`)}`,
            "同じブランチで直して push する",
          ]);
    case "ready":
      return make(
        "wait_merge",
        null,
        [dg(`gate ${id} --for merge`)],
        `PR #${facts.ticket.pr} のレビューとマージを人に頼む（auto.merge が true なら dg gate --for merge を満たした PR をマージする）`,
      );
  }
}

export const next = defineCommand({
  name: "next",
  positionals: ["ticket"],
  group: "next",
  summary:
    "チケットの次の 1 手を返す（EX-3）。段階（stage。ticket show と同じ）は、todo（着手できる）・blocked（Plan の待ちか依存先がある）・" +
    "claimed（PR がない）・implemented（PR があり見直しがない）・reviewing（見直しが実行中）・reviewed（最後の push より後の見直しが閉じた。review_passed で通ったか）・" +
    "fixed（見直しの後に push があるか、最後の見直しの結果がない）・ready（見直しが通り PR を出した）・merged（done）・closed（abandoned）・" +
    `waiting_human（止まって待っている Run がある、か、重い指摘が出た見直しが ${FIX_ROUNDS_LIMIT} 回を超えた）。PR が draft かは status で見る（in_progress で PR があれば draft）。` +
    "段階を Run（実装・見直し・手直しとその結果、止まって待っている印）・PR・作業ブランチの事実・Plan の待ちから求め、" +
    "手の種類（kind：implement・review・fix・ready・wait_merge・wait_deps・wait_human・done）と、開く step・実行中の Run・Plan の段階と範囲と方針・呼ぶコマンド（commands）・人に聞くこと（ask_human）を返す。" +
    `重い指摘が出た見直しが ${FIX_ROUNDS_LIMIT} 回を超えたチケットと、止まって待っている Run のあるチケットは wait_human。作業ブランチを取り込んでから読む。何も書かない`,
  input: z.object({ ticket: ticketRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    const facts = await stageFactsOf(ctx, ticket, { fetch: true });
    return ok(nextOf(ctx, ticket, facts));
  },
});

export const nextCommands = [next];
