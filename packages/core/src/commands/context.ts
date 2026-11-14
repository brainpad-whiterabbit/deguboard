// 入口がコマンドを呼ぶための文脈を組み立てる

import path from "node:path";
import { OperationError } from "../errors.js";
import {
  defaultUser,
  ensureDataRemote,
  isInitialized,
  resolveRemote,
  resolveRepoPaths,
  type GitRepo,
} from "../git/repo.js";
import { ensureDeguboardWorktree, type WorktreeOrigin } from "../git/worktree.js";
import { actorIdOf } from "../model/actor.js";
import { dataBranchProblem, DEFAULT_DATA_BRANCH } from "../model/config.js";
import { STORE_CACHE_DIR } from "../storage/paths.js";
import { resolveConfigDataRemote } from "../storage/remote-name.js";
import { Store } from "../storage/store.js";
import type { ActorInfo, AnyCommand, CommandContext } from "./define.js";

export interface ContextOptions {
  cwd: string;
  /** 主体の種別とユーザ名。ID は 2 つから導く。user を渡して userSource を省けば flag とみなす */
  actor?: Partial<Pick<ActorInfo, "kind" | "user" | "userSource">> | undefined;
  now?: (() => Date) | undefined;
  hooks?: CommandContext["hooks"];
  /**
   * init のとき：worktree がなければ作る。リモート名は config（データの中にある）より先に要るので受け取る。
   * remote はコードのリモートの名前、dataRemote はデータのリモートの名前か URL（省けば remote と同じ。URL なら ensureDataRemote がリモートを足す）、
   * dataBranch はデータのリモートでのデータのブランチ名（省けば config の git.data_branch。初めての init では既定の deguboard）
   */
  initialize?:
    | {
        remote?: string | undefined;
        dataRemote?: string | undefined;
        dataBranch?: string | undefined;
      }
    | undefined;
  /** マージドライバとして登録する、dg を呼ぶ argv の前置。入口（CLI）が自分の呼び方を渡す */
  mergeDriver?: readonly string[] | undefined;
  /** 環境変数。今は入口（CLI・server・vscode・MCP）は渡さず process.env を使う。テストが HOME などを差し替えるためにある */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Workflow の steps に書ける Action の名前。commands は actions に依存しないので、入口が
   * core/actions の ACTION_NAMES を渡す（AG-6）。省略すると未知の Action を指摘しない
   */
  actions?: readonly string[] | undefined;
}

/**
 * コマンドを呼ぶための文脈。入力がコマンドの storeless を満たせば、ストアを開かずに場所だけの文脈を作り（storelessContext）、
 * そうでなければ openContext。入力の形の誤りは runCommand が報告するので、ここでは誤った入力を storeless にしない
 */
export async function openContextFor(
  def: AnyCommand,
  rawInput: unknown,
  opts: ContextOptions,
): Promise<CommandContext> {
  if (def.storeless) {
    const parsed = def.input.safeParse(rawInput);
    const env = opts.env ?? process.env;
    if (parsed.success && def.storeless(parsed.data, env))
      return storelessContext(opts, def.storelessRemote?.(parsed.data, env) === true);
  }
  return openContext(opts);
}

/**
 * ストアを開かない文脈（CommandContext の storeless）。git で場所だけを解決し、チケット・Plan・Epic・Iteration・config の
 * ファイルを読まない。初期化の有無は openContext と同じく確かめ（データのリポジトリの .git の有無だけを見る）、初期化していなければ
 * NOT_INITIALIZED（deguboard を使っていないリポジトリでフックが何かを拒まないように）。読めない項目は読んだときに例外を投げる（使う側の誤りを隠さない）。
 * withRemote のときは config のデータのリモートの名前とデータのブランチ名だけを読み、repo.dataRemote・repo.dataBranch を解決する
 * （t770。残りの config と repo.codeRemote は読めない）
 */
async function storelessContext(
  opts: ContextOptions,
  withRemote: boolean,
): Promise<CommandContext> {
  const paths = await resolveRepoPaths(opts.cwd);
  if (!(await isInitialized(paths)))
    throw new OperationError("NOT_INITIALIZED", "deguboard is not initialized. Run dg init");
  const unread = (name: string) => ({
    get(): never {
      throw new Error(`${name} was read in a context without an open store (storeless)`);
    },
  });
  const target = withRemote ? await resolveConfigDataRemote(paths) : undefined;
  const repo = Object.defineProperties(
    { ...paths },
    {
      dataRemote: target
        ? { value: target.dataRemote, enumerable: true }
        : unread("repo.dataRemote"),
      dataBranch: target
        ? { value: target.dataBranch, enumerable: true }
        : unread("repo.dataBranch"),
      codeRemote: unread("repo.codeRemote"),
      baseBranch: unread("repo.baseBranch"),
    },
  ) as GitRepo;
  const ctx = {
    repo,
    now: opts.now ?? (() => new Date()),
    hooks: opts.hooks,
    mergeDriver: opts.mergeDriver,
    env: opts.env,
    storeless: true,
  };
  return Object.defineProperties(ctx, {
    store: unread("store"),
    config: unread("config"),
    actor: unread("actor"),
  }) as unknown as CommandContext;
}

export async function openContext(opts: ContextOptions): Promise<CommandContext> {
  const paths = await resolveRepoPaths(opts.cwd);
  let worktree: WorktreeOrigin | undefined;
  const initDataBranch = opts.initialize?.dataBranch;
  const branchProblem =
    initDataBranch === undefined ? undefined : dataBranchProblem(initDataBranch);
  if (branchProblem) throw new OperationError("VALIDATION_FAILED", branchProblem);
  // init が受けたデータのリモート（名前か URL）。URL ならリモートを足し、ない名前ならエラー（黙って同期なしにしない）
  const initDataRemote = opts.initialize?.dataRemote
    ? await ensureDataRemote(paths, opts.initialize.dataRemote)
    : undefined;
  if (!(await isInitialized(paths))) {
    if (!opts.initialize) {
      throw new OperationError("NOT_INITIALIZED", "deguboard is not initialized. Run dg init");
    }
    const remote =
      initDataRemote ?? (await resolveRemote(paths, opts.initialize.remote ?? "origin"));
    worktree = await ensureDeguboardWorktree(paths, remote, initDataBranch ?? DEFAULT_DATA_BRANCH);
  }
  // 個人の設定（deguboard-local/config.yaml）もここで重ねるので、CLI・HTTP・VS Code 拡張は同じ値を読む。
  // 読みの結果は deguboard-local/store-cache/ に残し、次の呼び出し（CLI は毎回別のプロセス）は変わったファイルだけを読む
  const store = await Store.open(paths.dataDir, {
    actions: opts.actions,
    localDir: paths.localDir,
    cacheDir: path.join(paths.localDir, STORE_CACHE_DIR),
  });
  // データのリモートは、init が受けた値 > config の git.data_remote > コードのリモートと同じ、の順に決める
  const codeName = opts.initialize?.remote ?? store.config.git.remote;
  const dataName = initDataRemote ?? (store.config.git.data_remote || codeName);
  const codeRemote = await resolveRemote(paths, codeName);
  const repo: GitRepo = {
    ...paths,
    codeRemote,
    dataRemote: dataName === codeName ? codeRemote : await resolveRemote(paths, dataName),
    // データのブランチ名も、init が受けた値 > config の git.data_branch（省けば deguboard）の順に決める
    dataBranch: initDataBranch ?? store.config.git.data_branch,
    baseBranch: store.config.git.base_branch,
  };
  const kind = opts.actor?.kind ?? "human";
  const { user, source: userSource } = opts.actor?.user
    ? { user: opts.actor.user, source: opts.actor.userSource ?? "flag" }
    : await defaultUser(repo);
  const actor: ActorInfo = { kind, user, userSource, id: actorIdOf(user, kind) };
  return {
    repo,
    store,
    config: store.config,
    actor,
    now: opts.now ?? (() => new Date()),
    hooks: opts.hooks,
    worktree,
    mergeDriver: opts.mergeDriver,
    env: opts.env,
  };
}
