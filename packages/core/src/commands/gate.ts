// 品質ゲート（EX-3、ADR-011）。guide-review の品質ゲートのうち、記録と Git・PR の事実で判定できるものをコードで判定する。
// 判定は保存せず、呼ぶたびに事実から求める。PreToolUse のフックが gh pr merge・gh pr ready の前に呼ぶ（hook.ts）

import { z } from "zod";
import { fetchPrGateFacts, lastPushedAt } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import { parseAcceptance, type Ticket } from "../model/ticket.js";
import { readRunningRuns } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { ticketRef } from "./helpers.js";

/** 重い指摘を直す回数の上限（見直しは最初を含めて 3 回まで。guide-review の「上限」） */
export const FIX_ROUNDS_LIMIT = 2;

export const GATE_STAGES = ["ready", "merge"] as const;
export type GateStage = (typeof GATE_STAGES)[number];

export const GATE_CONDITIONS = ["pr", "acceptance", "review", "fix_rounds", "mergeable"] as const;
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
  if (pushedAt === undefined) add("review", false, "作業ブランチの最後の push の時刻を読めない");
  else {
    const after = reviews.filter((r) => r.started_at >= pushedAt);
    const latest = after.at(-1);
    if (!latest) add("review", false, `最後の push（${pushedAt}）より後の見直しがない`);
    else if (latest.finished_at === null)
      add("review", false, `最後の push より後の見直し ${latest.id} が終わっていない`);
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

  // 修正ループの回数：このブランチでの見直しのうち、重い指摘が出た回
  const since = ticket.branch_at ?? "";
  const rounds = reviews.filter(
    (r) => r.started_at >= since && r.review !== null && r.review.heavy > 0,
  ).length;
  add(
    "fix_rounds",
    rounds <= FIX_ROUNDS_LIMIT,
    rounds <= FIX_ROUNDS_LIMIT
      ? `重い指摘を直した回数 ${rounds}（上限 ${FIX_ROUNDS_LIMIT}）`
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
    "review（作業ブランチの最後の push より後に始めた見直しの Run が閉じていて、run review-result の結果が通っている）・" +
    `fix_rounds（このブランチで重い指摘が出た見直しが ${FIX_ROUNDS_LIMIT} 回以内）・mergeable（--for merge のとき gh の mergeable が MERGEABLE）。` +
    "gh・Git が読めない条件は満たさないとする。検査（lint・テスト）が通るかは判定しない（リポジトリの規約で確かめる）。何も書かない",
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
