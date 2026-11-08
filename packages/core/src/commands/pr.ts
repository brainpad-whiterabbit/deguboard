// PR を進めるコマンド（EX-3・AG-9、ADR-026）。品質ゲート（gate.ts の judgeGate）を満たすときだけ gh を呼ぶ。
// エージェントが PR を ready にする・マージする正しい道で、フックは dg を経由しない gh pr ready・merge を拒む（hook.ts）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { runGh } from "../git/run.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { judgeGate, type GateStage, type GateView } from "./gate.js";
import { ticketRef } from "./helpers.js";

/** gh pr merge のマージの方法（actions の merge_pr と同じ。Core の汎用部分は actions に依存しないので別に持つ） */
export const PR_MERGE_METHODS = ["squash", "merge", "rebase"] as const;

export interface PrAdvanceView {
  ticket: string;
  pr: number;
  /** ready は gh pr ready、merge は gh pr merge を呼んだ */
  action: GateStage;
  /** 呼ぶ前に判定した品質ゲート（いつも passed） */
  gate: GateView;
  /** マージの方法（merge のときだけ） */
  method?: (typeof PR_MERGE_METHODS)[number];
}

/** ゲートを判定し、満たさなければ満たさない条件と理由を GATE_FAILED で返す（gh を呼ばない） */
async function passGate(ctx: CommandContext, ticketId: string, stage: GateStage) {
  const ticket = ctx.store.require("ticket", ticketId).data;
  const gate = await judgeGate(ctx, ticket, stage);
  if (!gate.passed || gate.pr === null) {
    const failed = gate.conditions.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
    throw new OperationError(
      "GATE_FAILED",
      `${ticket.id} の品質ゲート（dg gate ${ticket.id} --for ${stage}）を満たさないので、gh pr ${stage} を呼ばない`,
      `${failed.join("\n")}\n満たさないまま進める（見直し役を起動できない・修正ループの上限を超えた・版上げの PR・人が回数を指示した）のは人の判断なので、人に gh pr ${stage} を打ってもらう（dg guide review）`,
    );
  }
  return { ticket, gate, pr: gate.pr };
}

export const prReady = defineCommand({
  name: "pr.ready",
  positionals: ["ticket"],
  group: "pr",
  summary:
    "チケットの PR を、品質ゲート（dg gate <ticket> --for ready）を満たすときだけ gh pr ready で draft から出す。" +
    "満たさなければ GATE_FAILED で満たさない条件と理由を返し、gh を呼ばない。エージェントが PR を出す正しい道で、" +
    "dg を経由しない gh pr ready はフックが拒む。満たさないまま出すのは人の判断で、人が gh pr ready を打つ。チケットのデータは書かない（review への前進は次の sync）",
  input: z.object({ ticket: ticketRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "ready");
    await runGh(ctx.repo.topLevel, ["pr", "ready", String(pr)], { timeoutMs: 60_000 });
    const view: PrAdvanceView = { ticket: ticket.id, pr, action: "ready", gate };
    return ok(view);
  },
});

export const prMerge = defineCommand({
  name: "pr.merge",
  positionals: ["ticket"],
  group: "pr",
  summary:
    "チケットの PR を、品質ゲート（dg gate <ticket> --for merge）を満たすときだけ gh pr merge でマージする（既定は squash）。" +
    "満たさなければ GATE_FAILED で満たさない条件と理由を返し、gh を呼ばない。エージェントがマージする正しい道で（マージしてよいかは手順が決める。dg guide all）、" +
    "dg を経由しない gh pr merge はフックが拒む。満たさないままマージするのは人の判断で、人が gh pr merge を打つ。チケットのデータは書かない（done への前進は次の sync）",
  input: z.object({
    ticket: ticketRef,
    method: z.enum(PR_MERGE_METHODS).default("squash").describe("マージの方法"),
    delete_branch: z
      .boolean()
      .default(false)
      .describe(
        "リモートとローカルの作業ブランチも消すか（gh pr merge --delete-branch）。ブランチを checkout した worktree が残っていると gh がローカルのブランチを消せないので、先に worktree を消して main の worktree から呼ぶ",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "merge");
    const args = ["pr", "merge", String(pr), `--${input.method}`];
    if (input.delete_branch) args.push("--delete-branch");
    await runGh(ctx.repo.topLevel, args, { timeoutMs: 120_000 });
    const view: PrAdvanceView = {
      ticket: ticket.id,
      pr,
      action: "merge",
      gate,
      method: input.method,
    };
    return ok(view);
  },
});

export const prCommands = [prReady, prMerge];
