// PR を進めるコマンド（EX-6・AG-10、ADR-026）。品質ゲート（gate.ts の judgeGate）を満たすときだけ gh を呼ぶ。
// エージェントが PR を ready にする・マージする正しい道で、フックは dg を経由しない gh pr ready・merge を拒む（hook.ts）

import { APPROVAL_OVERRIDES, NEVER_OVERRIDDEN } from "./pr-approval.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { OperationError } from "../errors.js";
import path from "node:path";
import { checkOutside } from "../git/outside.js";
import { runGh, runGit } from "../git/run.js";
import { isForward } from "../model/common.js";
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
import { judgeGate, type GateConditionId, type GateStage, type GateView } from "./gate.js";
import { ticketRef } from "./helpers.js";
import {
  approverOf,
  permissionFields,
  rejectAgentOverride,
  requirePermission,
  type Granted,
  type PermissionInput,
} from "./permission.js";
import { operationPolicy } from "../workflow/resolve.js";
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
  /** 呼ぶ前に判定した品質ゲート（passed。人の承認で条件を越えたマージだけは passed が false で、越えた条件は overridden） */
  gate: GateView;
  /** 人の承認で越えた、満たさない条件（merge のときだけ。越えなければ空。pr-approval.ts の APPROVAL_OVERRIDES の条件だけ） */
  overridden?: GateConditionId[];
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
 * PR を進める操作に当てる Workflow の方針（WF-1）。ready は in_progress → review、merge は review → done の境目を越える操作で、
 * 今の Status から飛ばすときは間の境目もすべて越える。今の Status が行き先より手前にないとき（照合の前など）は、行き先の手前の境目だけを見る。
 * 越える条件（requires）は見ない：これらは事実を作る操作で、Status を進めるのは事実を見た照合。
 * 品質ゲートを通した後に呼ぶ（満たさない PR には、承認を求める前に、満たさない条件と進め方を GATE_FAILED で返す）
 */
function requirePrPermission(
  ctx: CommandContext,
  ticketId: string,
  stage: GateStage,
  input: PermissionInput,
): Granted {
  const ticket = ctx.store.require("ticket", ticketId).data;
  const to = stage === "ready" ? "review" : "done";
  const before = stage === "ready" ? "in_progress" : "review";
  const policy = operationPolicy(ctx.store.requireWorkflow().resolved, {
    command: `pr.${stage}`,
    move: { from: isForward(ticket.status, to) ? ticket.status : before, to },
  });
  const what =
    stage === "ready"
      ? `taking the PR of ${ticket.id} out of draft`
      : `merging the PR of ${ticket.id}`;
  // 聞かずに進める流れ（--auto）かを dg は知らないので、マージだけ、config の auto.merge を聞かずに進めてよい印に読む
  return requirePermission(ctx, policy, input, what, {
    auto: stage === "merge" && ctx.config.auto.merge,
  });
}

/**
 * 誰の承認で（または誰が強制して）PR を進めたかを PR のコメントに残す（t883）。gh を呼んだ後に書くので、書けなくても取り消さず、警告にする。
 * gh pr comment でなく REST（gh api の issues の comments）で書く（本文の読み書きと同じ理由。noteUnfixedLight）
 */
async function noteGranted(
  ctx: CommandContext,
  pr: number,
  stage: GateStage,
  granted: Granted,
  overridden: readonly GateConditionId[],
  warnings: string[],
): Promise<void> {
  if (granted.approver === null && granted.override === null) return;
  // 越えた条件も残す（どの条件を満たさないまま、誰の承認でマージしたかを後から確かめられるように。t884）
  const over =
    overridden.length > 0
      ? ` The approval overrode these unmet quality gate conditions: ${overridden.join(", ")}.`
      : "";
  const approved =
    granted.approver !== null ? `, after ${granted.approver} approved the ${stage}` : "";
  const forced =
    granted.override !== null
      ? ` ${ctx.actor.id} forced it with --override: ${granted.override.replace(/\s+/g, " ").trim()}`
      : "";
  const done = stage === "merge" ? "Merged" : "Made ready";
  const record = granted.approver ?? ctx.actor.id;
  const body = `${done} with \`dg pr ${stage}\` by ${ctx.actor.id}${approved}.${over}${forced}`;
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
      stage === "merge"
        ? `PR #${pr} is merged, but the approver (${record}) could not be recorded as a comment on the PR (${message}). Tell a human, and do not merge again`
        : `PR #${pr} is ready, but the approver (${record}) could not be recorded as a comment on the PR (${message}). Tell a human`,
    );
  }
}

/**
 * GATE_FAILED の detail の、満たさないまま進める道の案内。ready は人が gh を打つ。merge は人に聞き、承認されたら agent が
 * --approved-by でマージする（越えられるのは APPROVAL_OVERRIDES の条件。t884）。
 * blocking は、承認があっても越えられない満たさない条件
 */
function proceedHint(ticketId: string, stage: GateStage, blocking: readonly string[]): string {
  if (stage === "ready")
    return "Proceeding without meeting it (the review cannot be started, the fix loop went past its limit, or a human set the count) is a human decision, so ask a human to run gh pr ready (dg guide review)";
  if (blocking.length > 0)
    return `A person's approval does not override ${blocking.join(", ")} (${NEVER_OVERRIDDEN}), so resolve them first. Do not ask a person to run gh pr merge`;
  return `Merging without meeting it is a human decision, and it always needs a person's approval (fixed in Core; neither the config nor workflow.yaml changes it, and a flow that goes ahead without asking does not skip it): show a person these unmet conditions and ask whether to merge anyway. Only when the person approves, run dg pr merge ${ticketId} --approved-by human (the approval overrides ${APPROVAL_OVERRIDES.join(", ")}). Do not ask a person to run gh pr merge, and never pass --approved-by without a person's approval`;
}

/**
 * ゲートを判定し、満たさなければ満たさない条件と理由を GATE_FAILED で返す（gh を呼ばない）。
 * 品質ゲートを満たさない PR のマージは Core に固定で、主体によらずいつも人の承認が要る（workflow/resolve.ts の CORE_FIXED の
 * merge_over_gate。人が呼ぶときも承認者を渡し、PR に残す）。承認者（approver。merge だけ）があれば APPROVAL_OVERRIDES の条件を
 * 満たさなくても通し、越えた条件を overridden に返す。承認がなければ何も越えない（auto.merge でも越えない）。
 * PR（pr）・衝突（mergeable）・先端（head と sha）は、承認があっても越えない（t884）
 */
async function passGate(
  ctx: CommandContext,
  ticketId: string,
  stage: GateStage,
  approver: string | null = null,
) {
  const ticket = ctx.store.require("ticket", ticketId).data;
  const waived = new Set<GateConditionId>(
    stage === "merge" && approver !== null ? APPROVAL_OVERRIDES : [],
  );
  const gate = await judgeGate(ctx, ticket, stage, [], waived);
  const unmet = gate.conditions.filter((c) => !c.ok);
  const overridden = unmet.filter((c) => waived.has(c.id)).map((c) => c.id);
  // マージは判定した先端に固定するので、先端が読めなければ通さない（ready は固定しないので先端は要らない。t750）
  if (
    overridden.length < unmet.length ||
    gate.pr === null ||
    (stage === "merge" && gate.sha === null)
  ) {
    const failed = unmet.map((c) => `${c.id}: ${c.detail}`);
    // 承認があっても越えられない条件（承認がないときは、承認を得ても残る条件を案内に出す）
    const overridable = new Set<GateConditionId>(APPROVAL_OVERRIDES);
    const blocking: string[] = unmet.filter((c) => !overridable.has(c.id)).map((c) => c.id);
    // free は head の条件を判定しないので、先端が読めなかったときは理由を足す（落とした理由が空にならないように）
    if (stage === "merge" && gate.sha === null && !gate.conditions.some((c) => c.id === "head")) {
      failed.push(
        "head: cannot read the PR head commit from gh, so the merge cannot be pinned to the judged commit",
      );
      blocking.push("head");
    }
    throw new OperationError(
      "GATE_FAILED",
      `${ticket.id} does not meet the quality gate (dg gate ${ticket.id} --for ${stage}), so gh pr ${stage} is not called`,
      `${failed.join("\n")}\n${proceedHint(ticket.id, stage, blocking)}. If the level of the ticket does not fit the change, a person changes it with dg ticket update ${ticket.id} --gate <level> (only a person can lower it; an agent's call is rejected), then run dg pr ${stage} again`,
    );
  }
  return { ticket, gate, pr: gate.pr, sha: gate.sha, overridden };
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
    "Take a ticket's PR out of draft with gh pr ready, only when it meets the quality gate (dg gate <ticket> --for ready). The conditions follow the ticket's gate level (a ticket with no gate is high; see dg gate --help). If it does not, it returns GATE_FAILED with the unmet conditions and their reasons, and does not call gh. This is the right way for an agent to open a PR; gh pr ready run outside dg is rejected by the hook. Opening it outside the conditions of the level is a person's decision, and a person runs gh pr ready. Before opening, it adds to the PR body the light findings in the review record that were not passed to the fix (including differences from the reference section) (the original body is kept; the count is in noted). A review result held with no Run that the gate counted as a review is first written as a closed review Run marked capture: none, as dg sync does (data.reviews_recorded); changes made outside dg stop it with OUTSIDE_CHANGES only when it writes such a record, and otherwise are a warning. It does not write ticket data (moving to review happens at the next sync). After the gate passes, the decide value of the Workflow's in_progress → review boundary judges the call (anyone by default; see dg ticket move --help for the values): when it asks for a person's approval, an agent passes --approved-by, and a person passes a value of agent_only with --override; either is recorded as a comment on the PR. The boundary's requires are not judged here (reconcile moves the ticket)",
  input: z.object({ ticket: ticketRef, ...permissionFields }),
  // 持ち主のない保留を見直しの記録として書く（orphan-review.ts）。dg の外の変更は、書くときだけ withWrite のロックの中の検査で止め、
  // 書く保留がなければ読むだけのコマンドと同じく警告で済ませる（書く前は警告だけで PR を開けた）
  write: true,
  ownsOutsideCheck: true,
  needs: "store",
  async run(ctx, input) {
    // gh を呼ぶ前に確かめる（進めた後に引数の誤りで止めない）
    rejectAgentOverride(ctx, input);
    approverOf(ctx, input.approved_by, "taking the PR out of draft");
    const { ticket, gate, pr } = await passGate(ctx, input.ticket, "ready");
    const granted = requirePrPermission(ctx, input.ticket, "ready", input);
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
    await noteGranted(ctx, pr, "ready", granted, [], warnings);
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
    "Merge a ticket's PR with gh pr merge (squash by default), only when it meets the quality gate (dg gate <ticket> --for merge). It pins the merge to the commit the gate judged (sha in the gate's output, passed as --match-head-commit), so a commit pushed after the judgment is not merged. The conditions follow the ticket's gate level (a ticket with no gate is high; see dg gate --help). If it does not, it returns GATE_FAILED with the unmet conditions and their reasons, and does not call gh. This is the right way for an agent to merge. After the gate passes, the decide value of the Workflow's review → done boundary judges the call (ask_unless_auto by default; see dg ticket move --help for the values; the boundary's requires are not judged here, because the merge makes the fact and reconcile moves the ticket): when it asks for a person's approval, an agent merges after a person approved the merge, with --approved-by, which records the approver as a comment on the PR after the merge (data.approved_by; if the comment cannot be written, the merge stands and warnings say so), and without --approved-by the call returns TRANSITION_REJECTED and does not call gh. An agent merges without asking and without --approved-by only when the value is ask_unless_auto and config's auto.merge is true (the merge of --auto of dg guide all; data.approved_by is null and nothing is recorded), or when the value is anyone or agent_only. A value of human_only rejects an agent, and a person passes a value of agent_only with --override (the reason is recorded in the comment). gh pr merge run outside dg is rejected by the hook. Merging outside the conditions of the level is a person's decision, fixed in Core (neither the config nor workflow.yaml changes it): it always needs --approved-by, from a person's call too, and config's auto.merge does not skip it. Ask a person, and only when approved, pass --approved-by, which lets the merge go ahead with unmet check, review, fix_rounds, and acceptance (data.overridden gives the ones overridden, and the comment on the PR records them with the approver). " +
    NEVER_OVERRIDDEN +
    ", so they stay GATE_FAILED even with --approved-by (the merge is always pinned to the judged commit). Without --approved-by nothing is overridden. When the other unmet conditions are all overridden, the check still runs, so that its result is a fact. When it also deletes the work branch, data.removed shows what was deleted (worktree, local_branch, remote_branch; null for what was not deleted or did not exist), so do not delete them again. It does not write ticket data (moving to done happens at the next sync, which also deletes what remains when merge.delete_branch is true)",
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
        "The person who approved this merge: human (yourself, the user) or a user name. Pass it only when a person approved the merge of this PR; an agent's ID is rejected. With it, unmet check, review, fix_rounds, and acceptance do not stop the merge. Leave it out for a merge made without asking (--auto of dg guide all with auto.merge true), so that no approver is recorded",
      ),
    override: permissionFields.override,
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // gh を呼ぶ前に確かめる（マージした後に引数の誤りで止めない）
    rejectAgentOverride(ctx, input);
    const approver = approverOf(ctx, input.approved_by, "the merge");
    const { ticket, gate, pr, sha, overridden } = await passGate(
      ctx,
      input.ticket,
      "merge",
      approver,
    );
    const granted = requirePrPermission(ctx, input.ticket, "merge", input);
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
    // 承認者と強制の理由はマージできたときだけ残す（聞かずにマージしたときは残さない）
    await noteGranted(ctx, pr, "merge", granted, overridden, warnings);
    const view: PrAdvanceView = {
      ticket: ticket.id,
      pr,
      action: "merge",
      gate,
      overridden,
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
