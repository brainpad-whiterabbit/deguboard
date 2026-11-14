// PR を進めるコマンド（EX-6・AG-10、ADR-026）。品質ゲート（gate.ts の judgeGate）を満たすときだけ gh を呼ぶ。
// エージェントが PR を ready にする・マージする正しい道で、フックは dg を経由しない gh pr ready・merge を拒む（hook.ts）

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { OperationError } from "../errors.js";
import path from "node:path";
import { checkOutside } from "../git/outside.js";
import { runGh, runGit } from "../git/run.js";
import { isAgentActorId, resolveActorRef } from "../model/actor.js";
import { PR_MERGE_METHODS } from "../model/config.js";
import type { Ticket } from "../model/ticket.js";
import { unfixedLightLines, withUnfixedLight } from "../run/findings.js";
import { readReviewFindings, readRunningRuns } from "../run/record.js";
import { withWrite, type WriteOutcome } from "../git/write.js";
import type { RunId } from "../model/run.js";
import {
  branchTips,
  removeBranchWorktree,
  removedByMerge,
  type RemovedWork,
} from "./branch-cleanup.js";
import { setupFailureIn } from "./claim-setup.js";
import { defineCommand, ok, outsideWarning, rebaseWarning, type CommandContext } from "./define.js";
import { judgeGate, type GateStage, type GateView } from "./gate.js";
import { ticketRef } from "./helpers.js";
import {
  linkOrphanRounds,
  orphanReviewRuns,
  recordOrphanReviews,
  type RecordedOrphanReviews,
} from "./orphan-review.js";

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
  /** 持ち主のない保留から書いた見直しの記録の Run（ready のときだけ。orphan-review.ts） */
  reviews_recorded?: RunId[];
  /** 消した worktree とブランチ（merge で作業ブランチも消すときだけ。消さなかった・なかったものは null） */
  removed?: RemovedWork;
  /** マージを承認した人（merge のときだけ。--approved-by で渡された人。聞かずにマージしたときは null） */
  approved_by?: string | null;
}

/**
 * --approved-by の値を人の ID に直す（human は自分のユーザ本人）。承認するのは人なので、agent の ID は拒む
 * （聞かずにマージした --auto のマージに承認者を残さないように）
 */
function approverOf(ctx: CommandContext, ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const id = resolveActorRef(ctx.actor, ref);
  if (isAgentActorId(id)) {
    throw new OperationError(
      "VALIDATION_FAILED",
      `--approved-by takes the person who approved the merge, and ${id} is an agent`,
      "Pass human (yourself, the user) or a user name only when a person approved this merge. For a merge made without asking (--auto of dg guide all with auto.merge true), leave --approved-by out",
    );
  }
  return id;
}

/**
 * 誰が承認してマージしたかを PR のコメントに残す（t883）。マージの後に書くので、書けなくてもマージは取り消さず、警告にする。
 * gh pr comment でなく REST（gh api の issues の comments）で書く（本文の読み書きと同じ理由。noteUnfixedLight）
 */
async function noteApprover(
  ctx: CommandContext,
  pr: number,
  approver: string,
  warnings: string[],
): Promise<void> {
  const body = `Merged with \`dg pr merge\` by ${ctx.actor.id}, after ${approver} approved the merge.`;
  try {
    await runGh(
      ctx.repo.topLevel,
      [
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/issues/${pr}/comments`,
        "-f",
        `body=${body}`,
        "--silent",
      ],
      { timeoutMs: 60_000 },
    );
  } catch (e) {
    const message = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    warnings.push(
      `PR #${pr} is merged, but the approver (${approver}) could not be recorded as a comment on the PR (${message}). Tell a human, and do not merge again`,
    );
  }
}

/** ゲートを判定し、満たさなければ満たさない条件と理由を GATE_FAILED で返す（gh を呼ばない） */
async function passGate(ctx: CommandContext, ticketId: string, stage: GateStage) {
  const ticket = ctx.store.require("ticket", ticketId).data;
  const gate = await judgeGate(ctx, ticket, stage);
  // マージは判定した先端に固定するので、先端が読めなければ通さない（ready は固定しないので先端は要らない。t750）
  if (!gate.passed || gate.pr === null || (stage === "merge" && gate.sha === null)) {
    const failed = gate.conditions.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
    // free は head の条件を判定しないので、先端が読めなかったときは理由を足す（落とした理由が空にならないように）
    if (stage === "merge" && gate.sha === null && !gate.conditions.some((c) => c.id === "head")) {
      failed.push(
        "head: cannot read the PR head commit from gh, so the merge cannot be pinned to the judged commit",
      );
    }
    throw new OperationError(
      "GATE_FAILED",
      `${ticket.id} does not meet the quality gate (dg gate ${ticket.id} --for ${stage}), so gh pr ${stage} is not called`,
      `${failed.join("\n")}\nProceeding without meeting it (the review cannot be started, the fix loop went past its limit, or a human set the count) is a human decision, so ask a human to run gh pr ${stage} (dg guide review). If the level of the ticket does not fit the change, change it with dg ticket update ${ticket.id} --gate <level> (lowering it is a human's instruction), then run dg pr ${stage} again`,
    );
  }
  return { ticket, gate, pr: gate.pr, sha: gate.sha };
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
 * PR がマージ済みか（gh pr view の state が MERGED か）。読めなければ false にして、呼び出し側は失敗として扱う（t686）
 */
async function isMerged(ctx: CommandContext, pr: number): Promise<boolean> {
  try {
    const view = await runGh(ctx.repo.topLevel, ["pr", "view", String(pr), "--json", "state"], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (view.code !== 0) return false;
    return (JSON.parse(view.stdout) as { state?: string }).state === "MERGED";
  } catch {
    return false;
  }
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
    "Take a ticket's PR out of draft with gh pr ready, only when it meets the quality gate (dg gate <ticket> --for ready). The conditions follow the ticket's gate level (a ticket with no gate is high; see dg gate --help). If it does not, it returns GATE_FAILED with the unmet conditions and their reasons, and does not call gh. This is the right way for an agent to open a PR; gh pr ready run outside dg is rejected by the hook. Opening it outside the conditions of the level is a person's decision, and a person runs gh pr ready. Before opening, it adds to the PR body the light findings in the review record that were not passed to the fix (including differences from the reference section) (the original body is kept; the count is in noted). A review result held with no Run that the gate counted as a review is first written as a closed review Run marked capture: none, as dg sync does (data.reviews_recorded); changes made outside dg stop it with OUTSIDE_CHANGES only when it writes such a record, and otherwise are a warning. It does not write ticket data (moving to review happens at the next sync)",
  input: z.object({ ticket: ticketRef }),
  // 持ち主のない保留を見直しの記録として書く（orphan-review.ts）。dg の外の変更は、書くときだけ withWrite のロックの中の検査で止め、
  // 書く保留がなければ読むだけのコマンドと同じく警告で済ませる（書く前は警告だけで PR を開けた）
  write: true,
  ownsOutsideCheck: true,
  needs: "store",
  async run(ctx, input) {
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "ready");
    // ゲートが数えた保留を、ほかの clone の gate も数えられるように Git に書く（RN-9。t700）。ゲートの後なので判定は変わらない
    // 保留がなければ書き込みを始めない（まとめ待ちの変更のコミットや fetch を起こさない）
    const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
    let recorded: RecordedOrphanReviews = { written: [], linked: [] };
    let write: WriteOutcome | undefined;
    const warnings: string[] = [];
    if ((await orphanReviewRuns(ctx, ticket, running)).length === 0) {
      const check = await checkOutside(ctx.repo);
      if (check.kind === "found") warnings.push(outsideWarning(check.changes));
      // 読むだけのコマンドと同じく、rebase の途中も警告にする（runCommand と揃える。t753）
      if (check.kind === "rebasing") warnings.push(rebaseWarning(check.byDg));
    } else {
      // cas を付けないので、push を拒まれても mutate はやり直さない（自分のコミットを残して rebase し直す）。written は 1 回目に書いた Run
      const result = await withWrite(ctx, () => recordOrphanReviews(ctx, ticket, running), {
        message: (r) =>
          `Record held review results: ${ticket.id}: ${r.written.map((w) => w.id).join(", ")}`,
      });
      ({ value: recorded, write } = result);
      await linkOrphanRounds(ctx, ticket, recorded);
    }
    const noted = await noteUnfixedLight(ctx, ticket, pr);
    await runGh(ctx.repo.topLevel, ["pr", "ready", String(pr)], { timeoutMs: 60_000 });
    const view: PrAdvanceView = {
      ticket: ticket.id,
      pr,
      action: "ready",
      gate,
      noted,
      reviews_recorded: recorded.written.map((w) => w.id),
    };
    return ok(view, write, warnings);
  },
});

export const prMerge = defineCommand({
  name: "pr.merge",
  positionals: ["ticket"],
  group: "pr",
  summary:
    "Merge a ticket's PR with gh pr merge (squash by default), only when it meets the quality gate (dg gate <ticket> --for merge). It pins the merge to the commit the gate judged (sha in the gate's output, passed as --match-head-commit), so a commit pushed after the judgment is not merged. The conditions follow the ticket's gate level (a ticket with no gate is high; see dg gate --help). If it does not, it returns GATE_FAILED with the unmet conditions and their reasons, and does not call gh. This is the right way for an agent to merge (the steps decide whether a merge is allowed; dg guide all): after a person approved the merge, with --approved-by, which records the approver as a comment on the PR after the merge (data.approved_by; if the comment cannot be written, the merge stands and warnings say so); or without asking and without --approved-by, only under --auto of dg guide all with auto.merge true (data.approved_by is null and nothing is recorded). gh pr merge run outside dg is rejected by the hook. Merging outside the conditions of the level is a person's decision, and a person runs gh pr merge. When it also deletes the work branch, data.removed shows what was deleted (worktree, local_branch, remote_branch; null for what was not deleted or did not exist), so do not delete them again. It does not write ticket data (moving to done happens at the next sync, which also deletes what remains when merge.delete_branch is true)",
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
        "Also delete the remote and local work branch (gh pr merge --delete-branch). When omitted, config's merge.delete_branch applies (not deleted by default). When deleting, after the quality gate (including its checks) passes and before gh is called, the worktree that has the branch checked out is removed (gh cannot delete the local branch while it remains). If the merge fails and the PR is not merged, the removed worktree is restored at the same path and worktree.setup is run again, and the error's detail gives what was done. If the PR is already merged (gh failed after the merge, e.g. the local branch could not be deleted), the call succeeds, the worktree is not restored, and the failure is in warnings. Do not remove the worktree first; call from outside it (the main worktree). This flag only adds deletion: when config is true there is no CLI flag to skip deletion for this one merge (to keep the branch, set config's merge.delete_branch to false)",
      ),
    approved_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The person who approved this merge: human (yourself, the user) or a user name. Pass it only when a person approved the merge of this PR; an agent's ID is rejected. Leave it out for a merge made without asking (--auto of dg guide all with auto.merge true), so that no approver is recorded",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // gh を呼ぶ前に確かめる（マージした後に引数の誤りで止めない）
    const approver = approverOf(ctx, input.approved_by);
    const { ticket, gate, pr, sha } = await passGate(ctx, input.ticket, "merge");
    // passGate が merge で先端を要求するので、ここで null になることはない（型を絞るための確認）
    if (sha === null) throw new Error(`The gate for ${ticket.id} judged no head commit`);
    // 省いた方法とブランチの扱いはリポジトリの config で決める（LLM が規約から読み取って選ばない。EX-6）
    const method = input.method ?? ctx.config.merge.method;
    const deleteBranch = input.delete_branch ?? ctx.config.merge.delete_branch;
    const warnings: string[] = [];
    // 検査（actions.test）は作業ブランチの worktree で回すので、worktree は品質ゲートを通した後に消す（先に消すと検査を回せない）
    const branch = deleteBranch ? ticket.branch : undefined;
    // gh が消す前の先端。後の先端と比べて、消えたブランチを結果に出す（エージェントが消し直さないように。t849）
    const before = branch ? await branchTips(ctx, branch) : undefined;
    const removedDir = branch ? await removeBranchWorktree(ctx, branch, warnings) : null;
    // ゲートが判定した先端のコミットに固定する。判定の後に push されて先端が変わっていれば gh が拒むので、判定していないものはマージされない（t750）
    const args = ["pr", "merge", String(pr), `--${method}`, "--match-head-commit", sha];
    if (deleteBranch) args.push("--delete-branch");
    try {
      await runGh(ctx.repo.topLevel, args, { timeoutMs: 120_000 });
    } catch (e) {
      const message = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
      // gh はマージを済ませたあとでローカルのブランチの削除に失敗すると、非 0 で終わる。PR が MERGED ならマージは済んでいるので成功にし、
      // 失敗を warnings に出す。worktree は戻さず、準備のコマンドも回さない（作業は終わっている。t686）
      if (await isMerged(ctx, pr)) {
        warnings.push(
          deleteBranch
            ? `PR #${pr} is merged, but gh could not delete the work branch (${message}). Delete the branch by hand if it remains`
            : `PR #${pr} is merged, but gh reported an error (${message})`,
        );
      } else {
        // マージに失敗したら消した worktree を戻し、その扱いを detail に出す（ブランチとデータを残して作業を続けられるように）
        if (removedDir === null || !branch) throw e;
        const kept = await restoreBranchWorktree(ctx, branch, removedDir);
        throw new OperationError(
          "GIT_ERROR",
          `The merge of PR #${pr} failed (gh pr merge)`,
          `${message}\n${kept}`,
        );
      }
    }
    // 承認者はマージできたときだけ残す（聞かずにマージしたときは残さない）
    if (approver !== null) await noteApprover(ctx, pr, approver, warnings);
    const view: PrAdvanceView = {
      ticket: ticket.id,
      pr,
      action: "merge",
      gate,
      method,
      approved_by: approver,
      ...(branch && before
        ? {
            removed: removedByMerge(ctx, branch, removedDir, before, await branchTips(ctx, branch)),
          }
        : {}),
    };
    return ok(view, undefined, warnings);
  },
});

export const prCommands = [prReady, prMerge];
