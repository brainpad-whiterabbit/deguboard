// 品質ゲート（EX-3、ADR-011）。guide-review の品質ゲートのうち、記録と Git・PR の事実で判定できるものをコードで判定する。
// 判定は保存せず、呼ぶたびに事実から求める。dg pr ready・dg pr merge が gh を呼ぶ前に呼ぶ（pr.ts。ADR-026）

import { z } from "zod";
import { fetchPrGateFacts, lastPushedAt } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import { parseAcceptance, type Ticket } from "../model/ticket.js";
import { readRunningRuns } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { judgeCheck } from "./gate-check.js";
import { ticketRef } from "./helpers.js";

/** 重い指摘を直す回数の上限（見直しは最初を含めて 3 回まで。guide-review の「上限」） */
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

/** チケットの品質ゲートを判定する。gh・Git が読めない条件は満たさないとする（判定できないものを通さない） */
export async function judgeGate(
  ctx: CommandContext,
  ticket: Ticket,
  stage: GateStage,
): Promise<GateView> {
  const conditions: GateCondition[] = [];
  const add = (id: GateConditionId, ok: boolean, detail: string) =>
    conditions.push({ id, ok, detail });

  // PR
  const selector = ticket.pr !== undefined ? String(ticket.pr) : ticket.branch;
  let prNumber: number | null = ticket.pr ?? null;
  let mergeable: string | undefined;
  if (!selector) add("pr", false, "チケットに PR も作業ブランチもない");
  else {
    const facts = await fetchPrGateFacts(ctx.repo, selector);
    if ("reason" in facts) add("pr", false, `PR を確かめられない: ${facts.reason}`);
    else if ("missing" in facts) add("pr", false, `PR がない（${selector}）`);
    else {
      prNumber = facts.pr.number;
      mergeable = facts.pr.mergeable;
      if (facts.pr.state !== "OPEN")
        add("pr", false, `PR #${prNumber} が開いていない（${facts.pr.state}）`);
      else if (stage === "merge" && facts.pr.isDraft)
        add("pr", false, `PR #${prNumber} が draft のまま`);
      else add("pr", true, `PR #${prNumber} が開いている${facts.pr.isDraft ? "（draft）" : ""}`);
    }
  }

  // 受け入れ条件。PR を出す前は、付けられない項目の理由を PR の本文に書けばよいので見ない
  if (stage === "merge") {
    const items = parseAcceptance(ctx.store.tickets.get(ticket.id)?.body ?? "") ?? [];
    const unchecked = items.filter((i) => !i.checked).map((i) => i.index);
    add(
      "acceptance",
      unchecked.length === 0,
      unchecked.length === 0
        ? `受け入れ条件 ${items.length} 項目すべてに印がある`
        : `受け入れ条件 ${unchecked.join("・")} に印がない`,
    );
  }

  // 見直し：最後の push より後に始めた見直しが、閉じていて通っている
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const reviews = reviewRuns(ctx, ticket, running);
  const pushedAt = ticket.branch
    ? await lastPushedAt(ctx.repo, ticket.branch, { fetch: true }).catch(() => undefined)
    : undefined;
  // 比べるのはリモートの先端のコミットの時刻（push した時刻ではない。facts.ts の lastPushedAt）
  if (pushedAt === undefined) add("review", false, "作業ブランチの最後の push の時刻を読めない");
  else {
    const after = reviews.filter((r) => r.started_at >= pushedAt);
    const latest = after.at(-1);
    if (!latest) add("review", false, `最後の push（${pushedAt}）より後の見直しがない`);
    else if (latest.finished_at === null)
      add("review", false, `最後の push より後の見直し ${latest.id} が終わっていない`);
    else if (latest.result !== "success")
      add("review", false, `最後の push より後の見直し ${latest.id} が ${latest.result} で閉じた`);
    else if (latest.review === null)
      add("review", false, `見直し ${latest.id} の結果が記録されていない（dg run review-result）`);
    else if (!latest.review.passed)
      add(
        "review",
        false,
        `見直し ${latest.id} が通っていない（重い指摘 ${latest.review.heavy} 件）`,
      );
    else add("review", true, `最後の push より後の見直し ${latest.id} が通っている`);
  }

  const rounds = heavyReviewRounds(reviews, ticket.branch_at);
  add(
    "fix_rounds",
    rounds <= FIX_ROUNDS_LIMIT,
    rounds <= FIX_ROUNDS_LIMIT
      ? `重い指摘が出た見直し ${rounds} 回（上限 ${FIX_ROUNDS_LIMIT}）`
      : `重い指摘が出た見直しが ${rounds} 回で、上限 ${FIX_ROUNDS_LIMIT} を超えた。続けるかは人に聞く`,
  );

  // base と衝突しない（マージの前だけ）
  if (stage === "merge") {
    if (mergeable === undefined) add("mergeable", false, "PR を読めないので衝突を確かめられない");
    else
      add(
        "mergeable",
        mergeable === "MERGEABLE",
        mergeable === "MERGEABLE"
          ? "base と衝突しない"
          : `mergeable が ${mergeable}（衝突しているか、まだ計算中。少し待って確かめ直す）`,
      );
  }

  // 検査（actions.test）。時間がかかるので、ほかの条件をすべて満たしたときだけ回す（空なら回さずに通すので、いつでも判定する）
  if (ctx.config.actions.test.length === 0 || conditions.every((c) => c.ok)) {
    const check = await judgeCheck(ctx, ticket);
    add("check", check.ok, check.detail);
  } else add("check", false, "ほかの条件を満たさないので、検査（actions.test）は回していない");

  return {
    ticket: ticket.id,
    for: stage,
    pr: prNumber,
    passed: conditions.every((c) => c.ok),
    conditions,
  };
}

export const gate = defineCommand({
  name: "gate",
  positionals: ["ticket"],
  group: "gate",
  summary:
    "品質ゲートを記録と Git・PR の事実で判定し、条件ごとの結果（conditions）と満たさない理由を返す（EX-3）。条件は " +
    "pr（PR が開いている。--for merge なら draft でない）・acceptance（--for merge のとき受け入れ条件すべてに印）・" +
    "review（作業ブランチのリモートの先端のコミットの時刻より後に始めた見直しの Run が success で閉じていて、run review-result の結果が通っている）・" +
    `fix_rounds（このブランチで重い指摘が出た見直しが ${FIX_ROUNDS_LIMIT} 回以内）・mergeable（--for merge のとき gh の mergeable が MERGEABLE）・` +
    "check（config の actions.test を、作業ブランチの最新のコミット（リモートの先端）を checkout した未コミットの変更のない worktree で回して通る。actions.test が空なら判定せずに通し、そう detail に出す。通らなければ detail に終了コードと出力の末尾を出す。結果はコミットとコマンドごとに deguboard-local に覚え、同じコミットでは回し直さない。時間がかかるので、ほかの条件をすべて満たしたときだけ回す）。" +
    "gh・Git が読めない条件は満たさないとする。" +
    "dg pr ready・dg pr merge が gh を呼ぶ前に同じ判定をする。見直しを省く・上限を超えて進めるなどの例外は持たず、人の判断に任せる（人に gh を打ってもらう）。何も書かない",
  input: z.object({
    ticket: ticketRef,
    for: z
      .enum(GATE_STAGES)
      .optional()
      .describe(
        "ready は PR を出す前（gh pr ready）、merge はマージの前（gh pr merge）。省けば merge",
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
