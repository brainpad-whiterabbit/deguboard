// PR を進めるコマンド（EX-6・AG-10、ADR-026）。品質ゲート（gate.ts の judgeGate）を満たすときだけ gh を呼ぶ。
// エージェントが PR を ready にする・マージする正しい道で、フックは dg を経由しない gh pr ready・merge を拒む（hook.ts）

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { OperationError } from "../errors.js";
import path from "node:path";
import { runGh, runGit } from "../git/run.js";
import { findBranchWorktree } from "../git/worktree.js";
import { PR_MERGE_METHODS } from "../model/config.js";
import type { Ticket } from "../model/ticket.js";
import { unfixedLightLines, withUnfixedLight } from "../run/findings.js";
import { readReviewFindings } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { judgeGate, type GateStage, type GateView } from "./gate.js";
import { ticketRef } from "./helpers.js";

export interface PrAdvanceView {
  ticket: string;
  pr: number;
  /** ready は gh pr ready、merge は gh pr merge を呼んだ */
  action: GateStage;
  /** 呼ぶ前に判定した品質ゲート（いつも passed） */
  gate: GateView;
  /** マージの方法（merge のときだけ） */
  method?: (typeof PR_MERGE_METHODS)[number];
  /** PR の本文の「直さなかった軽い指摘」に載せた件数（ready のときだけ。見直しの記録がなければ 0） */
  noted?: number;
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

/**
 * 作業ブランチを checkout した worktree を消す（gh がローカルのブランチを消せるように）。呼んだ作業ツリーそのもの・未コミットの変更が
 * ある worktree は消さずに warnings に出す（作業を失わない。gh がローカルのブランチを消せなければ gh の警告になる）
 */
async function removeBranchWorktree(
  ctx: CommandContext,
  branch: string,
  warnings: string[],
): Promise<void> {
  const dir = await findBranchWorktree(ctx.repo, branch);
  if (!dir) return;
  if (path.resolve(dir) === path.resolve(ctx.repo.topLevel)) {
    warnings.push(
      `ブランチ ${branch} の worktree から呼んだので、worktree を消さない（ローカルのブランチが残る。main の worktree から呼ぶ）`,
    );
    return;
  }
  const removed = await runGit(ctx.repo.topLevel, ["worktree", "remove", "--", dir], {
    allowFailure: true,
  });
  if (removed.code !== 0)
    warnings.push(
      `worktree ${dir} を消せなかった（${removed.stderr.trim().split("\n")[0] ?? ""}）。要るものを退避してから消す`,
    );
}

/**
 * 直さなかった軽い指摘を PR の本文に書き足す（t600）。作業ブランチ（branch_at 以降）の見直しの回ごとの一覧から、手直しに渡さなかった
 * 軽い指摘を回の順に集め（同じ文は 1 つ）、もとの本文は残して節を書き足す（前に書いた節は入れ替える）。本文が変わるときだけ書き込む。
 * 書いた件数を返す。gh の失敗は本文を書き足せなかったと OperationError で返し、ready は呼ばない（呼び出し側）
 */
async function noteUnfixedLight(ctx: CommandContext, ticket: Ticket, pr: number): Promise<number> {
  const stored = await readReviewFindings(ctx.repo, ticket.id);
  if (!stored) return 0;
  const lines = unfixedLightLines(
    stored.rounds,
    ticket.branch_at,
    ctx.config.review.heavy_categories,
  );
  const failed = (what: string, e: unknown) =>
    new OperationError(
      "GIT_ERROR",
      `PR #${pr} の本文を書き足せず（${what}に失敗）、ready にしていない（直さなかった軽い指摘を載せるため）`,
      e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e),
    );
  // 本文の読み書きは REST（gh api の pulls）で行う。gh pr view・gh pr edit は GraphQL で PR の projectCards も引き、
  // Projects (classic) の廃止でエラーになって ready まで止まる（t637）。{owner}/{repo} は gh が作業ツリーのリポジトリで埋める
  const endpoint = `repos/{owner}/{repo}/pulls/${pr}`;
  let current: string;
  try {
    const view = await runGh(ctx.repo.topLevel, ["api", endpoint], { timeoutMs: 60_000 });
    current = (JSON.parse(view.stdout) as { body?: string | null }).body ?? "";
  } catch (e) {
    throw failed("本文の読み取り", e);
  }
  const next = withUnfixedLight(current, lines);
  if (next !== current) {
    // 本文は引数の配列で渡せない長さ・改行を含むので、一時ファイルの JSON から --input で渡す
    const dir = await mkdtemp(path.join(os.tmpdir(), "dg-pr-body-"));
    try {
      const file = path.join(dir, "body.json");
      await writeFile(file, JSON.stringify({ body: next }));
      await runGh(
        ctx.repo.topLevel,
        ["api", "--method", "PATCH", endpoint, "--input", file, "--silent"],
        { timeoutMs: 60_000 },
      );
    } catch (e) {
      throw failed("本文の書き込み", e);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return lines.length;
}

export const prReady = defineCommand({
  name: "pr.ready",
  positionals: ["ticket"],
  group: "pr",
  summary:
    "チケットの PR を、品質ゲート（dg gate <ticket> --for ready）を満たすときだけ gh pr ready で draft から出す。" +
    "満たさなければ GATE_FAILED で満たさない条件と理由を返し、gh を呼ばない。エージェントが PR を出す正しい道で、" +
    "dg を経由しない gh pr ready はフックが拒む。満たさないまま出すのは人の判断で、人が gh pr ready を打つ。" +
    "出す前に、見直しの記録にある軽い指摘のうち手直しに渡さなかったもの（参考節との食い違いを含む）を PR の本文に書き足す（もとの本文は残す。noted に件数）。" +
    "チケットのデータは書かない（review への前進は次の sync）",
  input: z.object({ ticket: ticketRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "ready");
    const noted = await noteUnfixedLight(ctx, ticket, pr);
    await runGh(ctx.repo.topLevel, ["pr", "ready", String(pr)], { timeoutMs: 60_000 });
    const view: PrAdvanceView = { ticket: ticket.id, pr, action: "ready", gate, noted };
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
    method: z
      .enum(PR_MERGE_METHODS)
      .optional()
      .describe("マージの方法。省けば config の merge.method（既定は squash）"),
    delete_branch: z
      .boolean()
      .optional()
      .describe(
        "リモートとローカルの作業ブランチも消すか（gh pr merge --delete-branch）。省けば config の merge.delete_branch（既定は消さない）。消すときは、品質ゲート（検査を含む）を通した後、gh を呼ぶ前にブランチを checkout した worktree を消す（残っていると gh がローカルのブランチを消せない）。worktree は先に消さず、その worktree の外（main の worktree）から呼ぶ。この旗は付けるだけで、config が true のときに今回だけ消さない手段は CLI の旗にない（消したくないときは config の merge.delete_branch を false にする）",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "merge");
    // 省いた方法とブランチの扱いはリポジトリの config で決める（LLM が規約から読み取って選ばない。EX-3）
    const method = input.method ?? ctx.config.merge.method;
    const deleteBranch = input.delete_branch ?? ctx.config.merge.delete_branch;
    const warnings: string[] = [];
    // 検査（actions.test）は作業ブランチの worktree で回すので、worktree は品質ゲートを通した後に消す（先に消すと検査を回せない）
    if (deleteBranch && ticket.branch) await removeBranchWorktree(ctx, ticket.branch, warnings);
    const args = ["pr", "merge", String(pr), `--${method}`];
    if (deleteBranch) args.push("--delete-branch");
    await runGh(ctx.repo.topLevel, args, { timeoutMs: 120_000 });
    const view: PrAdvanceView = {
      ticket: ticket.id,
      pr,
      action: "merge",
      gate,
      method,
    };
    return ok(view, undefined, warnings);
  },
});

export const prCommands = [prReady, prMerge];
