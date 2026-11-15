// dg setup check：導入の項目（git の版・Git リポジトリ・ボード・Skill と hooks・agent の設定のディレクトリの .gitignore）を上から順に確かめ、
// 満たすか・状態の文・必須か推奨か・直すコマンドを返す。読むだけで、何も書かない（remote も ls-remote で見るだけで fetch しない）。
// 判定はここ（core）に置き、CLI（packages/cli/src/program.ts）は引数と結果を写すだけにする。VS Code 拡張も core から同じ checkSetup を呼ぶ（ADR-033）。
// コマンドの一覧（registry.ts）には入れない。一覧のコマンドは文脈（リポジトリかストア）を開いてから動くが、
// この確かめは git がない・リポジトリの外・dg init の前でも結果を返すので、文脈を開かずに cwd と env だけで動く（hook-settings.ts と同じ形）。
// 拡張でしか確かめられない項目（作業フォルダ・OS・PATH の dg）はここに入れず、拡張が足す

import { dirname, join, parse, relative } from "node:path";
import { DEFAULT_HOOK_AGENT } from "../agents/fast-hooks.js";
import { hooksOf, type AgentEnv } from "../agents/index.js";
import {
  GitError,
  hasLocalDataBranch,
  isInitialized,
  looksLikeRemoteUrl,
  probeRemoteBoard,
  resolveRemote,
  resolveRepoPaths,
  runGit,
  type RepoPaths,
} from "../git/index.js";
import { dataBranchProblem, DEFAULT_DATA_BRANCH, DEFAULT_REMOTE } from "../model/config.js";
import { pathExists } from "../storage/exists.js";
import { initCommandLine } from "./client.js";
import { hookInstallStateOf, type HookInstallState } from "./hook-settings.js";
import { skillInstallStateOf } from "./skill-files.js";

/** dg が要る git の版（README と requirements.md の必須ツールと同じ） */
const MIN_GIT = [2, 30] as const;

export type SetupItemId = "git" | "repository" | "board" | "skills_hooks" | "gitignore";

/**
 * ボードの項目の細かい状態。ready は init 済み。local_branch は手元に deguboard ブランチだけが残っている（init はリモートを見ずにそれを使う）。
 * remote_board・remote_no_board・remote_unreachable は init 前にデータのリモートを確かめた結果（届いてボードがある・届いてボードがない・届かない）。
 * no_remote は確かめるリモートがない（init は手元だけのボードを作る）。
 * data_branch_invalid・data_remote_missing は、渡したデータのブランチ名・データのリモートの名前を dg init が受け付けない（init は何も作らずに止まる）
 */
export type BoardState =
  | "ready"
  | "local_branch"
  | "remote_board"
  | "remote_no_board"
  | "remote_unreachable"
  | "no_remote"
  | "data_branch_invalid"
  | "data_remote_missing";

export interface SetupCheckItem {
  id: SetupItemId;
  /** 項目の名前（英語。CLI が行の頭に出す） */
  label: string;
  /** required を満たさないと、後の項目は確かめない */
  level: "required" | "recommended";
  /** ok は満たす、unmet は満たさない、pending は前の必須の項目を満たさないので確かめていない */
  status: "ok" | "unmet" | "pending";
  /** 状態の文 */
  message: string;
  /** 直すコマンド（上から順に打つ）。満たすとき・確かめていないとき・コマンドで直せないときは空 */
  fix: string[];
  /** ボードの項目だけに付く、細かい状態（確かめていないときは付かない） */
  state?: BoardState;
  /** 状態の根拠になった git の出力（remote に届かなかったときの標準エラーなど） */
  detail?: string;
}

export interface SetupCheckResult {
  /** 必須の項目をすべて満たす */
  ready: boolean;
  /** 確かめた順（上から） */
  items: SetupCheckItem[];
}

export interface SetupCheckOptions {
  cwd: string;
  /** 環境変数。個人の設定と Skill の置き場所（HOME）を引く */
  env: AgentEnv;
  /** コードのリモートの名前。省けば origin。dg init の --remote と同じ値を渡す（dataRemote を省くと、init 前のボードもここで確かめる） */
  remote?: string | undefined;
  /** init 前に確かめるデータのリモート（名前か URL）。省けばコードのリモート。dg init の --data-remote と同じ値を渡す */
  dataRemote?: string | undefined;
  /** init 前に確かめるデータのブランチ名。省けば deguboard。dg init の --data-branch と同じ値を渡す */
  dataBranch?: string | undefined;
}

type Checked = Omit<SetupCheckItem, "id" | "label" | "level">;

const ok = (message: string, extra: Partial<Checked> = {}): Checked => ({
  status: "ok",
  message,
  fix: [],
  ...extra,
});
const unmet = (message: string, fix: string[], extra: Partial<Checked> = {}): Checked => ({
  status: "unmet",
  message,
  fix,
  ...extra,
});

const HOOKS_CHECK_NOTE =
  "This item only looks at whether they are installed. To see whether the hooks work, run dg hooks check";

/** `git --version` の出力から版を読み、MIN_GIT 以上かを見る */
async function checkGit(): Promise<Checked> {
  const need = `${MIN_GIT[0]}.${MIN_GIT[1]}`;
  let out: string;
  try {
    // 動かす場所は dg を呼んだプロセスの作業ディレクトリ（cwd がないフォルダでも git の有無を取り違えない）
    out = (await runGit(process.cwd(), ["--version"], { timeoutMs: 15_000 })).stdout.trim();
  } catch (error) {
    if (error instanceof GitError && error.kind === "missing")
      return unmet(`git was not found on PATH. Install git ${need} or later`, []);
    return unmet(
      `git --version failed, so the version of git is unknown. Install git ${need} or later`,
      [],
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  if (!m)
    return unmet(`Cannot read the version of git from "${out}". dg needs git ${need} or later`, []);
  const version = m[0];
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1]))
    return unmet(`git ${version} is older than ${need}. Install git ${need} or later`, []);
  return ok(`git ${version}`);
}

/**
 * ボードがあるか（init 済みか）。まだなら、dg init がすることを先に確かめる：手元に deguboard ブランチがあればそれを使い、
 * なければデータのリモートを ls-remote で見る（init と同じ probeRemoteBoard。t1005）。
 * 確かめる先は init と同じ決め方にする（openContext の initialize）：データのブランチ名とデータのリモートの名前を先に確かめ、
 * データのリモートを省けばコードのリモート（省けば origin）を見る。init が受け付けない値は、直すコマンドが失敗するので別の状態で返す
 */
async function checkBoard(paths: RepoPaths, options: SetupCheckOptions): Promise<Checked> {
  if (await isInitialized(paths))
    return ok(`The board is set up in this clone (${paths.dataDir})`, { state: "ready" });
  const branchProblem =
    options.dataBranch === undefined ? undefined : dataBranchProblem(options.dataBranch);
  if (branchProblem)
    return unmet(`${branchProblem}. dg init rejects this name, so nothing was checked`, [], {
      state: "data_branch_invalid",
    });
  // 名前のリモートがあればそのまま、URL（かパス）ならそこを直接見る（init は足すが、ここは何も書かない）。ない名前は init がエラーにする
  const dataRemote = options.dataRemote;
  if (
    dataRemote !== undefined &&
    !(await resolveRemote(paths, dataRemote)) &&
    !looksLikeRemoteUrl(dataRemote)
  )
    return unmet(
      `This clone has no remote named ${dataRemote} (the value of --data-remote), so dg init would stop without creating a board. Add it with git remote add ${dataRemote} <URL of the data repository>, or pass the URL itself to --data-remote, and check again`,
      [],
      { state: "data_remote_missing" },
    );
  const init = initCommandLine(options);
  if (await hasLocalDataBranch(paths))
    return unmet(
      "This clone has a deguboard branch but no worktree for it. dg init sets up the worktree from that branch",
      [init],
      { state: "local_branch" },
    );
  const codeRemote = options.remote ?? DEFAULT_REMOTE;
  const remote = dataRemote ?? (await resolveRemote(paths, codeRemote)) ?? undefined;
  const branch = options.dataBranch ?? DEFAULT_DATA_BRANCH;
  if (remote === undefined)
    return unmet(
      `This repository has no remote named ${codeRemote}, so there is no team board to take in. dg init creates a board that stays on this machine. If the code's remote has another name, pass it with --remote <name>. If the team's board is in another repository, pass it with dg init --data-remote <name or URL>`,
      [init],
      { state: "no_remote" },
    );
  const found = await probeRemoteBoard(paths.topLevel, remote, branch);
  if (found.state === "board")
    return unmet(
      `${remote} has the team's board (the ${branch} branch), and this clone has not taken it in yet. dg init takes it in`,
      [init],
      { state: "remote_board" },
    );
  if (found.state === "no_board")
    return unmet(
      `${remote} has no board (no ${branch} branch). dg init creates a new board and pushes it. If the team's board is in another repository, pass it with dg init --data-remote <name or URL>`,
      [init],
      { state: "remote_no_board" },
    );
  // 届かないときは直すコマンドを返さない：直すのは接続で、dg init --new-board はチームのボードと別のボードを作りうるので、人が選んだときだけにする（SY-1）
  return unmet(
    `Cannot reach ${remote}, so whether the team has a board is unknown, and no board was created. Fix the connection (network, credentials, or the remote's URL) and check again. Only if you know the team has no board, ${initCommandLine({ ...options, newBoard: true })} starts one on this machine`,
    [],
    { state: "remote_unreachable", ...(found.detail ? { detail: found.detail } : {}) },
  );
}

/**
 * フックを持つ agent の製品名と、その設定のディレクトリの .gitignore（リポジトリの最上位からの相対パス）。
 * 製品の名前と置き場所は Adapter が決めるので、ここには書かない（AG-5）
 */
function agentSettings(): { product: string; ignoreFile: string } {
  const hooks = hooksOf(DEFAULT_HOOK_AGENT);
  if (!hooks) throw new Error(`agent ${DEFAULT_HOOK_AGENT} has no hooks`);
  const root = parse(process.cwd()).root;
  return {
    product: hooks.product,
    ignoreFile: join(relative(root, dirname(hooks.settings.local(root))), ".gitignore"),
  };
}

/**
 * Skill と hooks が入っているか：どれかの設定（リポジトリの local・project、個人）にすべてのイベントの dg のフックがあり、
 * どれかの置き場所に dg の Skill があって、古い版の dg が書いたものがない。動くか（ハンドラ・届いた記録）は見ず、dg hooks check に任せる
 */
async function checkSkillsAndHooks(
  hookStates: readonly HookInstallState[],
  topLevel: string,
  env: AgentEnv,
  product: string,
): Promise<Checked> {
  const problems: string[] = [];
  const fix: string[] = [];
  const hooksIn = hookStates.filter((s) => s.installed);
  if (hooksIn.length === 0) {
    problems.push(`The dg hooks are not in the ${product} settings`);
    fix.push("dg hooks install");
  }
  const skills = await skillInstallStateOf({ topLevel, env });
  if (skills.installed.length === 0) {
    problems.push("The dg Skills are not installed");
    fix.push("dg skill install");
  }
  for (const place of skills.stale) {
    const install = `dg skill install${place.scope === "personal" ? " --personal" : ""}`;
    if (place.stale.length > 0) {
      problems.push(
        `These dg Skills in ${place.dir} are older than this dg: ${place.stale.join(", ")}`,
      );
      fix.push(install);
    }
    if (place.edited.length > 0) {
      problems.push(
        `These dg Skills in ${place.dir} are older than this dg and were edited by hand (${install} keeps them, and --force overwrites the edits): ${place.edited.join(", ")}`,
      );
      fix.push(`${install} --force`);
    }
  }
  if (problems.length > 0) return unmet(`${problems.join(". ")}. ${HOOKS_CHECK_NOTE}`, fix);
  return ok(
    `The dg hooks are in ${hooksIn.map((s) => s.file).join(", ")}, and the dg Skills are in ${skills.installed.map((p) => p.dir).join(", ")}. ${HOOKS_CHECK_NOTE}`,
  );
}

/**
 * agent の設定のディレクトリの .gitignore（dg hooks install と dg skill install が無視の行を足すファイル）がコミット済みか。
 * コミットされていないと、ほかの人のクローンで各自の設定と Skill が追跡の候補に出る。dg はコミットせず、コマンドを返すだけにする
 * （作業ブランチに勝手にコミットしない）。ファイルがない（どちらも入れていない）ときと、git が無視しているときは満たすとする
 */
async function checkGitignore(topLevel: string, shown: string): Promise<Checked> {
  if (!(await pathExists(join(topLevel, shown))))
    return ok(`${shown} does not exist yet (dg hooks install and dg skill install write it)`);
  const status = await runGit(topLevel, ["status", "--porcelain", "--", shown]);
  if (status.stdout.trim() === "") return ok(`${shown} is committed`);
  return unmet(
    `${shown} has uncommitted changes. It keeps each person's settings and dg Skills out of git, so commit it to share it. Run the commands at the repository root (${topLevel})`,
    [`git add ${shown}`, `git commit -m "Ignore the files dg installs on each machine" ${shown}`],
  );
}

/**
 * 導入の項目を上から順に確かめる。必須の項目を満たさなければ、その後の項目は確かめずに pending で返す
 * （リポジトリがなければボードは確かめられない）。推奨の項目は満たさなくても次へ進む
 */
export async function checkSetup(options: SetupCheckOptions): Promise<SetupCheckResult> {
  let paths: RepoPaths | undefined;
  const topLevel = () => paths!.topLevel;
  const agent = agentSettings();
  const steps: Array<
    Pick<SetupCheckItem, "id" | "label" | "level"> & { check(): Promise<Checked> }
  > = [
    { id: "git", label: "git", level: "required", check: checkGit },
    {
      id: "repository",
      label: "Git repository",
      level: "required",
      async check() {
        try {
          paths = await resolveRepoPaths(options.cwd);
        } catch {
          return unmet(
            `${options.cwd} is not inside a Git repository. dg keeps the board in a Git repository: create one with git init, or move into an existing one`,
            ["git init"],
          );
        }
        return ok(`Inside the Git repository ${paths.topLevel}`);
      },
    },
    {
      id: "board",
      label: "Board",
      level: "required",
      check: () => checkBoard(paths!, options),
    },
    {
      id: "skills_hooks",
      label: "Skills and hooks",
      level: "recommended",
      check: async () =>
        checkSkillsAndHooks(
          await hookInstallStateOf({ topLevel: topLevel(), env: options.env }),
          topLevel(),
          options.env,
          agent.product,
        ),
    },
    {
      id: "gitignore",
      label: agent.ignoreFile,
      level: "recommended",
      check: () => checkGitignore(topLevel(), agent.ignoreFile),
    },
  ];
  const items: SetupCheckItem[] = [];
  let blocked = false;
  for (const { check, ...head } of steps) {
    const checked: Checked = blocked
      ? { status: "pending", message: "Checked after the required items above are met", fix: [] }
      : await check();
    items.push({ ...head, ...checked });
    if (head.level === "required" && checked.status !== "ok") blocked = true;
  }
  return { ready: !blocked, items };
}
