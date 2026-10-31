// 入口がコマンドを呼ぶための文脈を組み立てる

import { OperationError } from "../errors.js";
import {
  defaultUser,
  isInitialized,
  resolveRemote,
  resolveRepoPaths,
  type GitRepo,
} from "../git/repo.js";
import { ensureDeguboardWorktree, type WorktreeOrigin } from "../git/worktree.js";
import { actorIdOf } from "../model/actor.js";
import { Store } from "../storage/store.js";
import type { ActorInfo, CommandContext } from "./define.js";

export interface ContextOptions {
  cwd: string;
  /** 主体の種別とユーザ名。ID は 2 つから導く */
  actor?: Partial<Pick<ActorInfo, "kind" | "user">> | undefined;
  now?: (() => Date) | undefined;
  hooks?: CommandContext["hooks"];
  /** init のとき：worktree がなければ作る。リモート名は config より先に要るので受け取る */
  initialize?: { remote?: string | undefined } | undefined;
}

export async function openContext(opts: ContextOptions): Promise<CommandContext> {
  const paths = await resolveRepoPaths(opts.cwd);
  let worktree: WorktreeOrigin | undefined;
  if (!(await isInitialized(paths))) {
    if (!opts.initialize) {
      throw new OperationError(
        "NOT_INITIALIZED",
        "deguboard が初期化されていない。dg init を実行する",
      );
    }
    const remote = await resolveRemote(paths, opts.initialize.remote ?? "origin");
    worktree = await ensureDeguboardWorktree(paths, remote);
  }
  const store = await Store.open(paths.dataDir);
  const remoteName = opts.initialize?.remote ?? store.config.git.remote;
  const repo: GitRepo = {
    ...paths,
    remote: await resolveRemote(paths, remoteName),
    baseBranch: store.config.git.base_branch,
  };
  const kind = opts.actor?.kind ?? "human";
  const user = opts.actor?.user ?? (await defaultUser(repo));
  const actor: ActorInfo = { kind, user, id: actorIdOf(user, kind) };
  return {
    repo,
    store,
    config: store.config,
    actor,
    now: opts.now ?? (() => new Date()),
    hooks: opts.hooks,
    worktree,
  };
}
