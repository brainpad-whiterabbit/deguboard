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
import { setupFailureIn } from "./claim-setup.js";
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
      `${ticket.id} does not meet the quality gate (dg gate ${ticket.id} --for ${stage}), so gh pr ${stage} is not called`,
      `${failed.join("\n")}\n満たさないまま進める（見直し役を起動できない・修正ループの上限を超えた・版上げの PR・人が回数を指示した）のは人の判断なので、人に gh pr ${stage} を打ってもらう（dg guide review）`,
    );
  }
  return { ticket, gate, pr: gate.pr };
}

/**
 * 作業ブランチを checkout した worktree を消す（gh がローカルのブランチを消せるように）。消したパスを返す（消さなかったら null）。
 * 呼んだ作業ツリーそのもの・未コミットの変更がある worktree は消さずに warnings に出す（作業を失わない。gh がローカルのブランチを
 * 消せなければ gh の警告になる）
 */
async function removeBranchWorktree(
  ctx: CommandContext,
  branch: string,
  warnings: string[],
): Promise<string | null> {
  const dir = await findBranchWorktree(ctx.repo, branch);
  if (!dir) return null;
  if (path.resolve(dir) === path.resolve(ctx.repo.topLevel)) {
    warnings.push(
      `Called from the worktree of branch ${branch}, so the worktree is not deleted (the local branch remains. Call it from the main worktree)`,
    );
    return null;
  }
  const removed = await runGit(ctx.repo.topLevel, ["worktree", "remove", "--", dir], {
    allowFailure: true,
  });
  if (removed.code !== 0) {
    warnings.push(
      `Could not delete worktree ${dir} (${removed.stderr.trim().split("\n")[0] ?? ""}). Move anything you need out, then delete it`,
    );
    return null;
  }
  return dir;
}

/**
 * マージに失敗したとき、removeBranchWorktree で消した worktree を同じパスに戻す（作業を続けられるように）。
 * 消すと無視されたファイル（node_modules など）も消えるので、戻したら config の worktree.setup も回す（t643）。
 * 戻したか・準備が回ったかを、エラーの detail に出す文として返す（戻せなかったとき・準備が止まったときは手で回す手順を添える）
 */
async function restoreBranchWorktree(
  ctx: CommandContext,
  branch: string,
  dir: string,
): Promise<string> {
  const setup = ctx.config.worktree.setup;
  const command = setup.join(" ");
  const back = await runGit(ctx.repo.topLevel, ["worktree", "add", dir, branch], {
    allowFailure: true,
  });
  if (back.code !== 0) {
    const reason = back.stderr.trim().split("\n")[0] ?? "";
    const then = setup.length > 0 ? ` and run ${command} in ${dir}` : "";
    return `The merge failed and the deleted worktree ${dir} could not be restored (${reason}). Restore it with git worktree add ${dir} ${branch}${then}`;
  }
  const head = `The merge failed, so the deleted worktree ${dir} was restored (you can continue working)`;
  if (setup.length === 0) return head;
  const failure = await setupFailureIn(ctx, dir);
  if (failure === null) return `${head}. The setup command (${command}) was also run again`;
  return `${head}. However, ${failure}, so run ${command} by hand in ${dir} before continuing work`;
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
      `Could not append to the body of PR #${pr} (${what} failed), so it was not made ready (the unfixed light findings must be added)`,
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
    throw failed("reading the body", e);
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
      throw failed("writing the body", e);
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
    "Take a ticket's PR out of draft with gh pr ready, only when it meets the quality gate (dg gate <ticket> --for ready). If it does not, it returns GATE_FAILED with the unmet conditions and their reasons, and does not call gh. This is the right way for an agent to open a PR; gh pr ready run outside dg is rejected by the hook. Opening it while conditions are unmet is a person's decision, and a person runs gh pr ready. Before opening, it adds to the PR body the light findings in the review record that were not passed to the fix (including differences from the reference section) (the original body is kept; the count is in noted). It does not write ticket data (moving to review happens at the next sync)",
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
    "Merge a ticket's PR with gh pr merge (squash by default), only when it meets the quality gate (dg gate <ticket> --for merge). If it does not, it returns GATE_FAILED with the unmet conditions and their reasons, and does not call gh. This is the right way for an agent to merge (the steps decide whether a merge is allowed; dg guide all). gh pr merge run outside dg is rejected by the hook. Merging while conditions are unmet is a person's decision, and a person runs gh pr merge. It does not write ticket data (moving to done happens at the next sync)",
  input: z.object({
    ticket: ticketRef,
    method: z
      .enum(PR_MERGE_METHODS)
      .optional()
      .describe("Merge method. When omitted, config's merge.method (squash by default)"),
    delete_branch: z
      .boolean()
      .optional()
      .describe(
        "Also delete the remote and local work branch (gh pr merge --delete-branch). When omitted, config's merge.delete_branch applies (not deleted by default). When deleting, after the quality gate (including its checks) passes and before gh is called, the worktree that has the branch checked out is removed (gh cannot delete the local branch while it remains). If the merge fails, the removed worktree is restored at the same path and worktree.setup is run again, and the error's detail gives what was done. Do not remove the worktree first; call from outside it (the main worktree). This flag only adds deletion: when config is true there is no CLI flag to skip deletion for this one merge (to keep the branch, set config's merge.delete_branch to false)",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "merge");
    // 省いた方法とブランチの扱いはリポジトリの config で決める（LLM が規約から読み取って選ばない。EX-6）
    const method = input.method ?? ctx.config.merge.method;
    const deleteBranch = input.delete_branch ?? ctx.config.merge.delete_branch;
    const warnings: string[] = [];
    // 検査（actions.test）は作業ブランチの worktree で回すので、worktree は品質ゲートを通した後に消す（先に消すと検査を回せない）
    const removedDir =
      deleteBranch && ticket.branch
        ? await removeBranchWorktree(ctx, ticket.branch, warnings)
        : null;
    const args = ["pr", "merge", String(pr), `--${method}`];
    if (deleteBranch) args.push("--delete-branch");
    try {
      await runGh(ctx.repo.topLevel, args, { timeoutMs: 120_000 });
    } catch (e) {
      // マージに失敗したら消した worktree を戻し、その扱いを detail に出す（ブランチとデータを残して作業を続けられるように）
      if (removedDir === null || !ticket.branch) throw e;
      const kept = await restoreBranchWorktree(ctx, ticket.branch, removedDir);
      throw new OperationError(
        "GIT_ERROR",
        `The merge of PR #${pr} failed (gh pr merge)`,
        `${e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e)}\n${kept}`,
      );
    }
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
