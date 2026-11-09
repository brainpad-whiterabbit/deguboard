// チケットの作業の段階と次の 1 手（EX-3・EX-5、ADR-011）。Run・PR・ブランチの事実と Plan の待ちから都度求め、保存しない（Plan の進捗と同じ考え）。
// 段階を返すだけで、エージェントを起動も監視もしない（ADR-028）。親は dg next の 1 手を行い、終えたらもう一度 dg next を呼ぶ

import { z } from "zod";
import { lastPushedAt } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import type { Config } from "../model/config.js";
import type { PlanTier } from "../model/plan.js";
import { readRunningRuns } from "../run/record.js";
import { ASK_LANGUAGES } from "./ask.js";
import { briefOf, type BriefRole } from "./brief.js";
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
 * 直す手（fix）は実装と同じモデル（guide-review の「指摘を直す」）
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
  ticket: Pick<Ticket, "id" | "status" | "pr" | "branch" | "branch_at">;
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
  // 最後の見直しより後に閉じた手直しが failure か interrupted なら、人を待つ（guide-review の「終わり方」）
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
      `手直しの Run ${failedFix.id} が ${failedFix.result} で閉じた`,
    );
  // 上限を超えたら、その後の push や見直しの結果によらず人を待つ（dg gate の fix_rounds が通さない）
  if (fixes > FIX_ROUNDS_LIMIT)
    return stage(
      "waiting_human",
      n,
      fixes,
      `重い指摘が出た見直しが ${fixes} 回で、上限 ${FIX_ROUNDS_LIMIT} を超えた`,
      latest?.review?.passed === true,
    );
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
      commands: awaited ? [`実行中の Run ${awaited} の終わりを待つ（新しく起動しない）`] : commands,
      model: MODEL_KINDS.includes(kind) ? modelOf(details?.tier, ctx.config.models) : null,
      ask_human: ask,
      brief: null,
    };
  };
  const dg = (args: string) => `dg --json --actor agent ${args}`;
  // フックがサブエージェントの Run を開け閉めする印（ADR-025）。委譲する親は claim に --no-run を付け、印で頼む
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
            `止まって待っているサブエージェントに続きを送る。質問で止まったなら人に伝えて答えを送り、push なしで返ったなら続けて直させるか、人に聞く（${st.reason}）`,
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
        // 文は claim の前に組むので、ブランチと worktree が空欄。claim の後に組み直して渡す
        `claim の後に ${dg(`brief ${id} --role implement`)} で文を組み直し、その文を渡す（ブランチと worktree が入る）`,
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
        ? // dg pr ready が品質ゲートを判定してから gh pr ready を呼ぶ（t545）
          make("ready", null, [dg(`pr ready ${id}`), dg("sync")])
        : // 手直しの Run も印でフックが開く。理由は直すエージェントが run retry-reason で書き足す（ADR-025）
          make("fix", fixStep, [
            marker(fixStep),
            `直すエージェント（実装と同じモデル）が最初に ${dg(`run retry-reason ${id} --reason <直す指摘の要約>`)}`,
            "同じブランチで直して push する",
          ]);
    case "ready":
      // マージは人を待つ手にする。自動でマージするのは auto.merge が true で品質ゲートを通った PR だけ（EX-7）
      return make(
        "wait_merge",
        null,
        [dg(`gate ${id} --for merge`)],
        `PR #${facts.ticket.pr} のレビューとマージを人に頼む（auto.merge が true なら dg pr merge ${id} が dg gate --for merge を満たした PR をマージする）`,
      );
  }
}

export const next = defineCommand({
  name: "next",
  positionals: ["ticket"],
  group: "next",
  summary:
    "チケットの次の 1 手を返す（EX-3・EX-5）。段階（stage。ticket show と同じ）は、todo（着手できる）・blocked（Plan の待ちか依存先がある）・" +
    "claimed（PR がない）・implemented（PR があり見直しがない）・reviewing（見直しが実行中）・reviewed（最後の push より後の見直しが閉じた。review_passed で通ったか）・" +
    "fixed（見直しの後に push があるか、最後の見直しの結果がない）・ready（見直しが通り PR を出した）・merged（done）・closed（abandoned）・" +
    `waiting_human（止まって待っている Run がある、最後の見直しの後の手直しが failure か interrupted で閉じた、か、重い指摘が出た見直しが ${FIX_ROUNDS_LIMIT} 回を超えた）。PR が draft かは status で見る（in_progress で PR があれば draft）。` +
    "段階を Run（実装・見直し・手直しとその結果、止まって待っている印）・PR・作業ブランチの事実・Plan の待ちから求め、" +
    "手の種類（kind：implement・review・fix・ready・wait_merge・wait_deps・wait_human・done）と、開く step・実行中の Run・Plan の段階と範囲と方針・呼ぶコマンド（commands。サブエージェントに委譲する形。モデルが親と同じで自分で進めるなら、implement の claim は --no-run を外し印を使わない。implement・review・fix・ready の手は、その手の Run か、このブランチで実行中の実装の Run・開始より後に push がない手直しの Run が実行中なら、起動せずに終わりを待つ）・人に聞くこと（ask_human）を返す。" +
    "implement・review・fix の手には、サブエージェントに貼る文（brief。dg brief と同じ。language で定型の文の言語）を入れる。" +
    "implement・fix の手には、起動するモデル（model）を入れる（Plan の tier を config の models.* に対応させ、tier のないチケットは standard。対応が空・review・ほかの手は null で、null は親のモデル）。" +
    "waiting_human の段階のチケットは wait_human。作業ブランチを取り込んでから読む。何も書かない",
  input: z.object({
    ticket: ticketRef,
    language: z
      .enum(ASK_LANGUAGES)
      .optional()
      .describe("brief の定型の文の言語。省けば ja。チケットの中身は変えない"),
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
    const brief = await briefOf(ctx, ticket, role, { language: input.language });
    return ok({ ...step, brief: brief.text });
  },
});

export const nextCommands = [next];
