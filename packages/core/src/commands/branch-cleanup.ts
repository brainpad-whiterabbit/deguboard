// マージの後の片付け（作業ブランチの worktree・ローカルとリモートのブランチを消す）。
// dg pr merge（pr.ts。gh の --delete-branch の前後）と、照合がチケットを done にしたとき（setup.ts の sync）が使う。
// エージェントが git を直接呼んで片付けないように、消すのも、消せない理由と消し方を伝えるのも dg が行う（t849）

import path from "node:path";
import { baseTip, localTip } from "../git/facts.js";
import { runGit } from "../git/run.js";
import { findBranchWorktree } from "../git/worktree.js";
import type { CommandContext } from "./define.js";

/** 消したもの。消さなかった・もともとなかったものは null */
export interface RemovedWork {
  /** 消した worktree のパス */
  worktree: string | null;
  /** 消したローカルのブランチの名前 */
  local_branch: string | null;
  /** 消したリモートのブランチ（`<remote>/<branch>`） */
  remote_branch: string | null;
}

/** 照合が done にしたチケットの、片付けの対象 */
export interface MergedWork {
  id: string;
  branch: string;
  /** マージされた PR の先端のコミット（gh の headRefOid）。PR がない・読めないときは undefined（base に入っているかだけで判定する） */
  mergedHead?: string | undefined;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/**
 * 作業ブランチを checkout した worktree を消す（gh がローカルのブランチを消せるように）。消したパスを返す（消さなかったら null）。
 * 呼んだ作業ツリーそのもの・未コミットの変更がある worktree は消さずに warnings に出す（作業を失わない。gh がローカルのブランチを
 * 消せなければ gh の警告になる）
 */
export async function removeBranchWorktree(
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
      `Could not delete worktree ${dir} (${firstLine(removed.stderr)}). Move anything you need out, then delete it`,
    );
    return null;
  }
  return dir;
}

/**
 * リモートにある作業ブランチの先端の SHA（追跡 ref は古いことがあるので ls-remote で読む）。
 * ブランチがなければ null、リモートがない・読めないときは undefined（不明）
 */
async function remoteBranchTip(
  ctx: CommandContext,
  branch: string,
): Promise<string | null | undefined> {
  if (!ctx.repo.codeRemote) return undefined;
  const listed = await runGit(
    ctx.repo.topLevel,
    ["ls-remote", "--heads", ctx.repo.codeRemote, `refs/heads/${branch}`],
    { allowFailure: true, timeoutMs: 30_000 },
  );
  if (listed.code !== 0) return undefined;
  const sha = listed.stdout.trim().split(/\s+/)[0];
  return sha ? sha : null;
}

/** 作業ブランチの今の先端（ローカルとリモート）。dg pr merge が gh の前後で比べて、消えたものを結果に出す */
export interface BranchTips {
  local: string | undefined;
  remote: string | null | undefined;
}

export async function branchTips(ctx: CommandContext, branch: string): Promise<BranchTips> {
  return {
    local: await localTip(ctx.repo, branch),
    remote: await remoteBranchTip(ctx, branch),
  };
}

/** gh pr merge --delete-branch の前後の先端から、消えたブランチを求める（worktree は removeBranchWorktree が消したパス） */
export function removedByMerge(
  ctx: CommandContext,
  branch: string,
  worktree: string | null,
  before: BranchTips,
  after: BranchTips,
): RemovedWork {
  return {
    worktree,
    local_branch: before.local !== undefined && after.local === undefined ? branch : null,
    remote_branch:
      typeof before.remote === "string" && after.remote === null
        ? `${ctx.repo.codeRemote}/${branch}`
        : null,
  };
}

/**
 * 照合が done にしたチケットの、残っている worktree・ローカルとリモートのブランチを消す（config の merge.delete_branch が true のとき。ST-4）。
 * 人が GitHub の画面でマージしたときや、dg pr merge が消せなかったときの残りを拾う。消したものを返す。
 * 作業を失わないよう、次のどれかに当たれば何も消さず、理由と手で消すコマンドを warnings に出す：
 *   - 呼んだ作業ツリーがそのブランチの worktree
 *   - worktree にコミットしていない変更がある（追跡していないファイルを含む。無視されたファイルは見ない）
 *   - ローカルかリモートの先端が、マージされた PR の先端と違い、base にも入っていない（マージされていないコミットがある）
 * 書き込みのロックの外で呼ぶ（リモートを待つ間、ほかの書き込みを止めない）
 */
export async function removeMergedWork(
  ctx: CommandContext,
  work: MergedWork,
  warnings: string[],
): Promise<RemovedWork> {
  const { id, branch } = work;
  const remote = ctx.repo.codeRemote;
  const removed: RemovedWork = { worktree: null, local_branch: null, remote_branch: null };
  const dir = await findBranchWorktree(ctx.repo, branch);
  const tips = await branchTips(ctx, branch);
  const remoteTip = typeof tips.remote === "string" ? tips.remote : undefined;
  // リモートを読めなかったときは、残っているかもしれないことを伝える（リモートのないリポジトリでは言わない）。手元の分は続けて片付ける
  if (remote && tips.remote === undefined) {
    warnings.push(
      `${id}: could not read the remote to see whether work branch ${branch} remains. If it does, delete it with git push ${remote} --delete ${branch}`,
    );
  }
  if (dir === null && tips.local === undefined && remoteTip === undefined) return removed;

  // 手で消すコマンド（残っているものだけ）
  const byHand = [
    ...(dir !== null ? [`git worktree remove --force ${dir}`] : []),
    ...(tips.local !== undefined ? [`git branch -D ${branch}`] : []),
    ...(remoteTip !== undefined && remote ? [`git push ${remote} --delete ${branch}`] : []),
  ].join(", ");

  const base = await baseTip(ctx.repo);
  /** 先端がマージ済みか（マージされた PR の先端と同じか、base に入っている）。消しても失うコミットがない */
  const merged = async (tip: string): Promise<boolean> => {
    if (work.mergedHead !== undefined && tip === work.mergedHead) return true;
    if (base === undefined) return false;
    const r = await runGit(ctx.repo.topLevel, ["merge-base", "--is-ancestor", tip, base], {
      allowFailure: true,
    });
    return r.code === 0;
  };
  const unmerged = (where: string, tip: string) =>
    work.mergedHead !== undefined
      ? `the tip of the ${where} branch (${tip.slice(0, 7)}) differs from the head of the merged PR (${work.mergedHead.slice(0, 7)})`
      : `the tip of the ${where} branch (${tip.slice(0, 7)}) is not in ${ctx.repo.baseBranch}`;

  const reasons: string[] = [];
  if (dir !== null && path.resolve(dir) === path.resolve(ctx.repo.topLevel)) {
    reasons.push(`it was called from the worktree of the branch (${dir})`);
  } else if (dir !== null) {
    const status = await runGit(dir, ["status", "--porcelain"], { allowFailure: true });
    if (status.code !== 0) reasons.push(`the state of worktree ${dir} could not be read`);
    else if (status.stdout.trim() !== "") reasons.push(`worktree ${dir} has uncommitted changes`);
  }
  if (tips.local !== undefined && !(await merged(tips.local)))
    reasons.push(unmerged("local", tips.local));
  if (remoteTip !== undefined && !(await merged(remoteTip)))
    reasons.push(unmerged("remote", remoteTip));
  if (reasons.length > 0) {
    warnings.push(
      `${id}: the worktree and work branch ${branch} were not deleted, because ${reasons.join(", and ")}. Move anything you need out, then delete them by hand: ${byHand}`,
    );
    return removed;
  }

  if (dir !== null) {
    const r = await runGit(ctx.repo.topLevel, ["worktree", "remove", "--", dir], {
      allowFailure: true,
    });
    if (r.code !== 0) {
      // worktree が残るとローカルのブランチは消せないので、ここで止める
      warnings.push(
        `${id}: could not delete worktree ${dir} (${firstLine(r.stderr)}), so work branch ${branch} was not deleted either. Delete them by hand: ${byHand}`,
      );
      return removed;
    }
    removed.worktree = dir;
  }
  if (tips.local !== undefined) {
    // squash マージの先端は base の祖先でないので -D で消す（マージ済みかは上で確かめた）
    const r = await runGit(ctx.repo.topLevel, ["branch", "-D", "--", branch], {
      allowFailure: true,
    });
    if (r.code === 0) removed.local_branch = branch;
    else
      warnings.push(
        `${id}: could not delete local branch ${branch} (${firstLine(r.stderr)}). Delete it by hand: git branch -D ${branch}`,
      );
  }
  if (remoteTip !== undefined && remote) {
    // 確かめた先端のままのときだけ消す（確かめた後に push されたコミットを失わない）。消すだけなので pre-push のフックは回さない
    const r = await runGit(
      ctx.repo.topLevel,
      [
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/${branch}:${remoteTip}`,
        remote,
        `:refs/heads/${branch}`,
      ],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    if (r.code === 0) removed.remote_branch = `${remote}/${branch}`;
    else
      warnings.push(
        `${id}: could not delete remote branch ${remote}/${branch} (${firstLine(r.stderr)}). Delete it by hand: git push ${remote} --delete ${branch}`,
      );
  }
  return removed;
}
