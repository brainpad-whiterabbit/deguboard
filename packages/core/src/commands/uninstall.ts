// dg uninstall：このクローンから deguboard を外す（CL-10）。dg が入れたものを、消す順序を守って 1 回で消す。
// 順序：フック → Skill → データの worktree → 手元のデータブランチ → マージドライバの登録 → deguboard-local。
// なぜこの順か：フックとマージドライバは dg を絶対パスで呼ぶ。dg（VS Code 拡張など）を先に消すと、フックは毎回失敗し、
// git は rebase のたびにないドライバを呼ぶ。dg が動くうちにここで外し、dg 本体を消すのは利用者が最後にする。
// リモートとチームで共有するものには触れない（リモートのデータブランチ・リモートの登録・コミットした agent の設定のディレクトリの
// .gitignore と追跡する設定のフック）。消すと戻せず、まだ使っているほかの人にも効くので、残すものと手で消すコマンドを結果に返すだけにする。
// 手元にしかないもの（送っていないデータ・dg の外の変更・作業中のチケットの worktree）があれば、何も消さずに止まる（force で越える）。
// 人だけが実行できる（workflow/resolve.ts の CORE_FIXED の uninstall）。フックを外す操作を含み（hooks_uninstall と同じ守り）、
// 手元のデータと個人の設定を消すので、エージェントが自分で打てないようにする。何も消さない dryRun は主体によらず通す（画面が消すものを見せる）。
// コマンドの一覧（registry.ts）には入れない（dg hooks・dg skill と同じく各自のマシンの操作で、MCP と HTTP には出さない。AG-4）。
// フックと Skill の消し方は uninstallHooks・uninstallSkill をそのまま呼ぶ（判定を 2 つ持たない）

import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentEnv } from "../agents/index.js";
import { OperationError } from "../errors.js";
import { withLock } from "../git/lock.js";
import { MERGE_DRIVER_NAME } from "../git/merge.js";
import { checkOutside, describeOutside, dirtyFiles } from "../git/outside.js";
import {
  DATA_REMOTE_NAME,
  dataRemoteRef,
  isInitialized,
  resolveRemote,
  resolveRepoPaths,
  type GitRepo,
  type RepoPaths,
} from "../git/repo.js";
import { runGit } from "../git/run.js";
import {
  findBranchWorktree,
  hasLocalDataBranch,
  hasWorktree,
  LOCAL_DATA_BRANCH,
} from "../git/worktree.js";
import type { ActorKind } from "../model/actor.js";
import { isTerminal } from "../model/common.js";
import { pathExists } from "../storage/exists.js";
import { readDataTarget } from "../storage/remote-name.js";
import { Store } from "../storage/store.js";
import { judgeDecision } from "../workflow/conditions.js";
import { CORE_FIXED } from "../workflow/resolve.js";
import { uninstallHooks } from "./hook-settings.js";
import { uninstallSkill } from "./skill-files.js";

/** 消すもの。removes の並びが消す順序 */
export interface UninstallItem {
  kind: "hooks" | "skills" | "data_worktree" | "data_branch" | "merge_driver" | "local_dir";
  /** repository はこのクローンの中、personal はホームディレクトリの下（--personal のときだけ） */
  scope: "repository" | "personal";
  /** 消す場所：設定のファイル・Skill のディレクトリ・worktree・deguboard-local の絶対パス、ブランチ名、git config の節 */
  target: string;
  /** kind が skills のとき、消す Skill の名前 */
  names?: string[];
}

/** 残すもの。commands は手で消すときのコマンド（順に）。コマンドだけでは消せないものは空で、reason に書く */
export interface UninstallKept {
  kind:
    | "remote_data_branch"
    | "data_remote"
    | "ignore_file"
    | "shared_hooks"
    | "edited_skills"
    | "personal_hooks"
    | "personal_skills";
  target: string;
  reason: string;
  commands: string[];
}

/** 止める理由。next は次にすること（コマンド） */
export interface UninstallBlocker {
  kind:
    | "unpushed"
    | "uncommitted"
    | "outside_changes"
    | "rebase"
    | "active_worktrees"
    | "unreadable";
  message: string;
  next: string[];
}

export interface UninstallResult {
  dryRun: boolean;
  personal: boolean;
  force: boolean;
  /** 消した（dryRun では、同じ引数で実行すれば消す）か。止める理由があって force でなければ false（dryRun だけ。実行はエラーで止まる） */
  proceeds: boolean;
  removes: UninstallItem[];
  keeps: UninstallKept[];
  /** 止める理由。force で越えたものも返す */
  blockers: UninstallBlocker[];
}

export interface UninstallOptions {
  cwd: string;
  env: AgentEnv;
  /** 呼んだ主体（入口が決める。CLI は --actor か DEGUBOARD_ACTOR） */
  actor: ActorKind;
  /** 個人の設定のフックとホームディレクトリの下の Skill も消す */
  personal?: boolean;
  /** 止める理由があっても消す */
  force?: boolean;
  /** 何も消さず、消すもの・残すもの・止める理由を返す */
  dryRun?: boolean;
}

const MERGE_SECTION = `merge.${MERGE_DRIVER_NAME}`;

/** 消すもの・残すもの・止める理由を調べる。何も書かない */
async function inspect(paths: RepoPaths, options: UninstallOptions): Promise<UninstallResult> {
  const { cwd, env } = options;
  const personal = options.personal ?? false;
  const removes: UninstallItem[] = [];
  const keeps: UninstallKept[] = [];
  const blockers: UninstallBlocker[] = [];
  const git = (args: string[]) => runGit(paths.topLevel, args, { allowFailure: true });

  // フックと Skill：dg hooks uninstall・dg skill uninstall の dryRun と同じ判定で、消すものがあるかを見る
  const hooksIn = (scope: "local" | "project" | "personal") =>
    uninstallHooks({ cwd, scope, env, actor: options.actor, dryRun: true });
  const skillsIn = (scope: "project" | "personal") =>
    uninstallSkill({ cwd, scope, env, force: false, dryRun: true });
  const localHooks = await hooksIn("local");
  const personalHooks = await hooksIn("personal");
  const skills = await skillsIn("project");
  const personalSkills = await skillsIn("personal");
  // リポジトリがホームディレクトリのときは、同じ Skill のディレクトリを 2 度数えない
  const personalSkillsApart = personalSkills.dir !== skills.dir;
  if (!localHooks.unchanged)
    removes.push({ kind: "hooks", scope: "repository", target: localHooks.file });
  if (personal && !personalHooks.unchanged)
    removes.push({ kind: "hooks", scope: "personal", target: personalHooks.file });
  if (skills.removed.length > 0)
    removes.push({
      kind: "skills",
      scope: "repository",
      target: skills.dir,
      names: skills.removed,
    });
  if (personal && personalSkillsApart && personalSkills.removed.length > 0)
    removes.push({
      kind: "skills",
      scope: "personal",
      target: personalSkills.dir,
      names: personalSkills.removed,
    });

  const initialized = await isInitialized(paths);
  const registered = await hasWorktree(paths);
  const branch = await hasLocalDataBranch(paths);
  if (registered || (await pathExists(paths.dataDir)))
    removes.push({ kind: "data_worktree", scope: "repository", target: paths.dataDir });
  if (branch) removes.push({ kind: "data_branch", scope: "repository", target: LOCAL_DATA_BRANCH });
  if (
    (await git(["config", "--local", "--get-regexp", `^merge\\.${MERGE_DRIVER_NAME}\\.`])).code ===
    0
  )
    removes.push({ kind: "merge_driver", scope: "repository", target: MERGE_SECTION });
  if (await pathExists(paths.localDir))
    removes.push({ kind: "local_dir", scope: "repository", target: paths.localDir });

  // データの置き場所（リモートの名前とブランチ名）。config が読めなくても既定で決まる
  const target = await readDataTarget(paths.dataDir, paths.localDir);
  const remote = await resolveRemote(paths, target.remote);
  const remoteRef = remote
    ? dataRemoteRef({ dataRemote: remote, dataBranch: target.branch })
    : undefined;
  const pushed =
    remoteRef !== undefined &&
    (await git(["show-ref", "--verify", "--quiet", remoteRef])).code === 0;

  // 止める理由：手元にしかないものがあるか
  let codeRemote: string | undefined;
  if (branch) {
    const counted = await git([
      "rev-list",
      "--count",
      `refs/heads/${LOCAL_DATA_BRANCH}`,
      ...(pushed ? ["--not", remoteRef!] : []),
    ]);
    const ahead = Number(counted.stdout.trim()) || 0;
    if (ahead > 0)
      blockers.push({
        kind: "unpushed",
        message: pushed
          ? `${ahead} commit(s) of the board data are not pushed to ${remote}/${target.branch}, and removing the local data branch loses them.`
          : `The board data is only in this clone (no copy on a data remote is known; ${ahead} commit(s)), and removing the local data branch loses the board.`,
        next: remote ? ["dg sync"] : [`git remote add ${target.remote} <URL>`, "dg sync"],
      });
  }
  if (initialized) {
    // outside.ts が読むのはデータの場所とデータのリモートだけ。コードのリモートと base は使わない
    const repo: GitRepo = {
      ...paths,
      dataRemote: remote,
      dataBranch: target.branch,
      codeRemote: null,
      baseBranch: "",
    };
    // 基準を書かないように、ロックを持つときの読み方（underLock）で確かめる。実行のときは書き込みのロックの中で呼ぶ。
    // ロックを持たない dryRun は、並べて動く dg の書きかけを外の変更と読むことがあるが、見せるだけで、実行のときに確かめ直す
    const outside = await checkOutside(repo, { underLock: true });
    if (outside.kind === "rebasing")
      blockers.push({
        kind: "rebase",
        message:
          "A rebase is in progress in the deguboard worktree, so what would be lost cannot be judged.",
        next: ["dg sync"],
      });
    else if (outside.kind === "found")
      blockers.push({
        kind: "outside_changes",
        message: `The data has changes made outside dg, which removing the worktree loses (${describeOutside(outside.changes)}).`,
        next: ["dg adopt", "dg sync"],
      });
    else if (Object.keys(await dirtyFiles(repo)).length > 0)
      blockers.push({
        kind: "uncommitted",
        message:
          "The data has changes that dg has not committed yet, which removing the worktree loses.",
        next: ["dg commit", "dg sync"],
      });
    try {
      const store = await Store.open(paths.dataDir, { localDir: paths.localDir });
      codeRemote = store.config.git.remote;
      const active: string[] = [];
      for (const t of store.tickets.values()) {
        if (!t.data.branch || isTerminal(t.data.status)) continue;
        const dir = await findBranchWorktree(paths, t.data.branch);
        if (dir) active.push(`${t.data.id} (${dir})`);
      }
      if (active.length > 0)
        blockers.push({
          kind: "active_worktrees",
          message: `Tickets not finished yet have worktrees in this clone: ${active.sort().join(", ")}. Without the board, dg no longer tracks or cleans them up. Finish the tickets, or remove the worktrees.`,
          // review のチケットの worktree も止める理由になるので、Status で絞らずに一覧を案内する
          next: ["dg ticket list", "git worktree list"],
        });
    } catch (error) {
      blockers.push({
        kind: "unreadable",
        message: `The board data cannot be read, so the tickets not finished yet cannot be checked (${error instanceof Error ? error.message : String(error)}).`,
        next: ["dg validate"],
      });
    }
  }

  // 残すもの：リモートとチームで共有するもの、手を加えた Skill、--personal を付けなかった個人のもの
  if (pushed)
    keeps.push({
      kind: "remote_data_branch",
      target: `${remote}/${target.branch}`,
      reason:
        "The board data stays on the remote: the team shares it, and deleting it cannot be undone. dg init takes it in again. Without dg it is still readable with git show",
      commands: [`git push ${remote} --delete ${target.branch}`],
    });
  // データ専用のリモート（コードのリモートと別の名前）と、dg init が足した deguboard-data
  const dedicated = new Set<string>();
  if (remote && codeRemote !== undefined && remote !== codeRemote) dedicated.add(remote);
  if (await resolveRemote(paths, DATA_REMOTE_NAME)) dedicated.add(DATA_REMOTE_NAME);
  for (const name of dedicated)
    keeps.push({
      kind: "data_remote",
      target: name,
      reason: "The registration of the data remote stays, so dg init can take the board in again",
      commands: [`git remote remove ${name}`],
    });
  const ignoreFile = path.join(path.dirname(localHooks.file), ".gitignore");
  if (await pathExists(ignoreFile))
    keeps.push({
      kind: "ignore_file",
      target: ignoreFile,
      reason:
        "The team commits this file, and the others still rely on its ignore lines. When the whole team stops using deguboard, delete dg's lines by hand and commit",
      commands: [],
    });
  const sharedHooks = await hooksIn("project");
  if (!sharedHooks.unchanged)
    keeps.push({
      kind: "shared_hooks",
      target: sharedHooks.file,
      reason:
        "The team commits this file, so its dg hooks stay. When the whole team stops using deguboard, remove them and commit",
      commands: ["dg hooks uninstall --shared"],
    });
  const edited = [
    ["", skills] as const,
    ...(personal && personalSkillsApart ? [[" --personal", personalSkills] as const] : []),
  ];
  for (const [flag, found] of edited)
    if (found.kept.length > 0)
      keeps.push({
        kind: "edited_skills",
        target: found.dir,
        reason: `These dg Skills were edited by hand, so they stay: ${found.kept.join(", ")}`,
        commands: [`dg skill uninstall${flag} --force`],
      });
  if (!personal) {
    const other =
      "Other repositories on this machine may use them. To remove them too, add --personal";
    if (!personalHooks.unchanged)
      keeps.push({
        kind: "personal_hooks",
        target: personalHooks.file,
        reason: other,
        commands: ["dg hooks uninstall --personal"],
      });
    if (personalSkillsApart && personalSkills.removed.length + personalSkills.kept.length > 0)
      keeps.push({
        kind: "personal_skills",
        target: personalSkills.dir,
        reason: other,
        commands: ["dg skill uninstall --personal"],
      });
  }

  const force = options.force ?? false;
  return {
    dryRun: options.dryRun ?? false,
    personal,
    force,
    proceeds: blockers.length === 0 || force,
    removes,
    keeps,
    blockers,
  };
}

/** 調べた結果（plan.removes）を、並びの順に消す */
async function remove(paths: RepoPaths, options: UninstallOptions, plan: UninstallResult) {
  const { cwd, env, actor } = options;
  const git = (args: string[]) => runGit(paths.topLevel, args);
  for (const item of plan.removes) {
    const scope = item.scope === "personal" ? "personal" : undefined;
    if (item.kind === "hooks") await uninstallHooks({ cwd, scope: scope ?? "local", env, actor });
    else if (item.kind === "skills")
      await uninstallSkill({ cwd, scope: scope ?? "project", env, force: false });
    else if (item.kind === "data_worktree") {
      // 止める理由は確かめた後なので、無視したファイルや（force で越えた）変更が残っていても消す。登録だけ・ディレクトリだけの残骸も片付ける
      if (await hasWorktree(paths)) await git(["worktree", "remove", "--force", paths.dataDir]);
      await rm(paths.dataDir, { recursive: true, force: true });
      await git(["worktree", "prune"]);
    } else if (item.kind === "data_branch") await git(["branch", "-D", LOCAL_DATA_BRANCH]);
    else if (item.kind === "merge_driver")
      await git(["config", "--local", "--remove-section", MERGE_SECTION]);
  }
}

/**
 * dg uninstall。dryRun は何も消さずに調べた結果を返す。実行は、止める理由があって force でなければ何も消さずに REJECTED で止まり
 * （理由と次にすることを detail に 1 行ずつ）、なければ removes の順に消して同じ形の結果を返す。
 * 調べてから消すまでは書き込みのロックを持ち、並べて動く dg が調べた後に書いた変更を消さない。deguboard-local はロックの置き場所なので、放してから消す
 */
export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  if (!options.dryRun && judgeDecision(CORE_FIXED.uninstall, options.actor) === "reject")
    throw new OperationError(
      "TRANSITION_REJECTED",
      `dg limits removing deguboard from a clone to a person (fixed in Core, uninstall: ${CORE_FIXED.uninstall})`,
      "It removes the hooks that stop writes to the data and PR operations that do not go through dg, and deletes the local data and personal settings, so an agent cannot run it. Ask a person to run dg uninstall (without --actor agent). To see what it would remove, run dg uninstall --dry-run. workflow.yaml cannot change this value",
    );
  const paths = await resolveRepoPaths(options.cwd);
  if (paths.topLevel === paths.dataDir)
    throw new OperationError(
      "REJECTED",
      "dg uninstall cannot run from inside the deguboard worktree, which it removes. Run it from the repository's working tree",
    );
  if (options.dryRun) return inspect(paths, options);
  const run = async () => {
    const plan = await inspect(paths, options);
    if (!plan.proceeds)
      throw new OperationError(
        "REJECTED",
        "dg uninstall removed nothing, because something exists only in this clone. Do what each reason says and run it again (dg uninstall --dry-run shows what would be removed), or add --force to remove anyway",
        plan.blockers.map((b) => `${b.message} Next: ${b.next.join(", ")}`).join("\n"),
      );
    await remove(paths, options, plan);
    return plan;
  };
  const plan = (await pathExists(path.join(paths.localDir, "locks")))
    ? await withLock(paths.localDir, "write", run)
    : await run();
  await rm(paths.localDir, { recursive: true, force: true });
  return plan;
}
