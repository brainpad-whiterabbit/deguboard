// claim に付く準備（ST-3）：Iteration への追加と開始、作業ブランチの worktree の作成と、その worktree での準備のコマンド（worktree.setup）。
// 親のエージェントが claim の前後に文で打っていた手を claim の中に入れ、規則を毎回同じに守る（ADR-030）。
// どれも claim の排他（push）の成否とは別の都合なので、できなくても claim は失敗させず warnings で伝える

import path from "node:path";
import { createBranchWorktree, defaultWorktreePath } from "../git/branch-worktree.js";
import { runGit, runProcess } from "../git/run.js";
import { findBranchWorktree } from "../git/worktree.js";
import { compareIds } from "../model/id.js";
import { otherActiveOf, type Iteration } from "../model/iteration.js";
import type { Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { CommandContext } from "./define.js";
import { localDate } from "./helpers.js";

/** agent に許されたコマンドか（actor.human_only）。人はいつでも許す */
function allowedFor(ctx: CommandContext, command: string): boolean {
  return ctx.actor.kind !== "agent" || !ctx.config.actor.human_only.includes(command);
}

/**
 * Iteration の空いたチケットを入れる先：Project の active の Iteration、なければ planned のうち start が最も早いもの
 * （start のないものは後ろ。並べば ID の小さいもの）。閉じた Iteration には入れない
 */
export function iterationTargetFor(
  iterations: Iterable<Doc<Iteration>>,
  project: string,
): Doc<Iteration> | undefined {
  const inProject = [...iterations].filter((i) => i.data.project === project);
  const active = inProject.find((i) => i.data.status === "active");
  if (active) return active;
  return inProject
    .filter((i) => i.data.status === "planned")
    .sort((a, b) => {
      const as = a.data.start;
      const bs = b.data.start;
      if (as !== bs) {
        if (as === undefined) return 1;
        if (bs === undefined) return -1;
        return as < bs ? -1 : 1;
      }
      return compareIds(a.id, b.id);
    })[0];
}

/**
 * claim の書き込みの中で、チケットの Iteration を決めて返し、planned なら開始する（lint.require_iteration・IT-1）。
 * require_iteration が false なら Iteration には入れないが、入っている Iteration の開始は行う。
 * 入れ先がない・agent に禁じられた・ほかの active があるときは、何もせず warnings に人への頼みを書く
 */
export async function prepareIterationForClaim(
  ctx: CommandContext,
  ticket: Doc<Ticket>,
  warnings: string[],
): Promise<Ticket["iteration"]> {
  let iterationId = ticket.data.iteration;
  if (!iterationId && ctx.config.lint.require_iteration) {
    const target = iterationTargetFor(ctx.store.iterations.values(), ticket.data.project);
    if (!target) {
      warnings.push(
        `${ticket.id} を入れる Iteration（active か planned）がない。人に Iteration を作って入れるよう頼む（入れずに進むと lint_iteration_missing）`,
      );
    } else if (!allowedFor(ctx, "iteration.add")) {
      warnings.push(
        `${ticket.id} を ${target.id} に入れられない（iteration.add は actor.human_only）。人に入れるよう頼む`,
      );
    } else {
      iterationId = target.id as NonNullable<Ticket["iteration"]>;
      warnings.push(`${ticket.id} を ${target.id} に入れた`);
    }
  }
  if (!iterationId) return iterationId;
  const it = ctx.store.iterations.get(iterationId);
  if (!it || it.data.status !== "planned") return iterationId;
  if (!allowedFor(ctx, "iteration.start")) {
    warnings.push(
      `${it.id} は planned のまま（iteration.start は actor.human_only）。人に開始を頼む`,
    );
    return iterationId;
  }
  const other = otherActiveOf(
    [...ctx.store.iterations.values()].map((i) => i.data),
    it.data,
  );
  if (other) {
    warnings.push(
      `${it.id} を開始できない（${other.id} が active）。人に ${it.id} の扱いを確かめる`,
    );
    return iterationId;
  }
  // 予定の開始日は実際とずれるので、始めた日に書き換える（iteration.start と同じ。IT-1）
  await ctx.store.update("iteration", it.id, { status: "active", start: localDate(ctx.now()) });
  warnings.push(`${it.id} を開始した（active）`);
  return iterationId;
}

/** 準備のコマンドの上限。pnpm install と build が入るので、普通の検査より長く待つ */
const SETUP_TIMEOUT_MS = 10 * 60_000;

/** 警告に添える stderr の末尾（空でない最後の 3 行を 1 行にまとめる） */
function stderrTail(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" / ");
}

/**
 * claim が作った worktree で config の worktree.setup を回す（t621）。空なら回さない。
 * 失敗（終了コード・起動できない・上限）は claim を失敗させず、warnings に失敗と手で回すコマンドを書く。
 * 準備は pnpm install などで長くかかるので、呼ぶ側は実装の Run を開いた後に回す（ticket.ts の claim）
 */
export async function runSetupInWorktree(
  ctx: CommandContext,
  dir: string,
  warnings: string[],
): Promise<void> {
  const [file, ...args] = ctx.config.worktree.setup;
  if (!file) return;
  // 手で回すときの書き方。引数に空白があってもそのまま読めるように、引数は引用せず並べる
  const command = ctx.config.worktree.setup.join(" ");
  try {
    const result = await runProcess(dir, file, args, {
      allowFailure: true,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    if (result.code === 0) return;
    const tail = stderrTail(result.stderr);
    warnings.push(
      `worktree の準備のコマンド（${command}）が終了コード ${result.code} で止まった${tail ? `（stderr の末尾: ${tail}）` : ""}。claim は済んでいるので、${dir} で ${command} を手で回す`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    warnings.push(
      `worktree の準備のコマンド（${command}）を回せなかった（${reason}）。claim は済んでいるので、${dir} で ${command} を手で回す`,
    );
  }
}

/**
 * claim したブランチの worktree を用意して場所を返す。既にそのブランチの worktree があればそれを返し、
 * ローカルにブランチだけ残っていれば（unclaim の後など）そのブランチを checkout する。作れなければ warnings に理由を書いて null。
 * created は今作ったかどうか（既存のものは false）。worktree.setup はここでは回さず、呼ぶ側が Run を開いた後に runSetupInWorktree で回す
 */
export async function prepareWorktreeForClaim(
  ctx: CommandContext,
  branch: string,
  requestedPath: string | undefined,
  warnings: string[],
): Promise<{ path: string; created: boolean } | null> {
  const repo = ctx.repo;
  // 作れなかったときの警告に場所を出すので、try の外で決める（依頼の path か既定の場所。t617）
  const dir = path.resolve(
    repo.topLevel,
    requestedPath ?? defaultWorktreePath(repo, ctx.config.worktree.root, branch),
  );
  let created: string;
  try {
    const existing = await findBranchWorktree(repo, branch);
    if (existing) return { path: existing, created: false };
    const local = await runGit(
      repo.topLevel,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (local.code === 0) {
      await runGit(repo.topLevel, ["worktree", "add", "--", dir, branch]);
      created = dir;
    } else {
      created = (
        await createBranchWorktree(repo.topLevel, repo, { branch, base: repo.baseBranch, dir })
      ).path;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    warnings.push(
      `ブランチ ${branch} の worktree を作れなかった（${reason}）。claim は済んでいるので、worktree を ${dir} に手で作って続ける`,
    );
    return null;
  }
  return { path: created, created: true };
}
