// 品質ゲートの検査の条件（EX-6）：config の actions.test（か下の軽い検査）を、作業ブランチの worktree で回す。
// actions.test は run_tests の Action と同じく確認なしで実行する（config.yaml に書ける人の権限をシェルの許可と同等とみなす。ADR-033・AG-7）。
// 通った結果はコミットとコマンドごとに deguboard-local/checks/ に置き、同じコミットの ready の後の merge で回し直さない。Git には入れない。
// 通らなかった結果は覚えない（確率で落ちる検査を、コミットを足さずに回し直せるように）
// 最後に全体の検査（actions.test）が通ったコミットも別に覚える（full）。その後の差分が actions.light_paths に入るだけなら、
// 軽い検査（actions.light_test）を回す（t632・t741）。軽い検査が通っても full は消さない。
// 全体を回し直すのは、コードを変えた・祖先でない（rebase・force push）・merge を含む（main の取り込み）・コマンドを変えた、のとき（t741）
// dg gate --only check は、作業ブランチの worktree の HEAD（push の前のコミットも）を同じ判定で検査する（t741）

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runGit, runProcess } from "../git/run.js";
import { findBranchWorktree } from "../git/worktree.js";
import { ACTIONS_TEST_TIMEOUT_MS, type Config } from "../model/config.js";
import type { Ticket } from "../model/ticket.js";
import { writeFileAtomic } from "../storage/atomic.js";
import type { CommandContext } from "./define.js";

/** 通らなかったときに detail に出す出力の末尾の行数 */
const TAIL_LINES = 30;

const CHECKS_DIR = "checks";

interface StoredCheck {
  sha: string;
  command: string[];
  code: number;
  tail: string;
  at: string;
}

/** 最後に全体の検査（actions.test）が通ったコミットと、そのときのコマンド（t741） */
export interface FullCheck {
  sha: string;
  command: string[];
}

/** deguboard-local/checks/<チケット ID>.json の中身。results は通った結果（コミットとコマンドごと）、full は最後に全体の検査が通ったコミット */
interface CheckRecord {
  results: StoredCheck[];
  full?: FullCheck;
}

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

const short = (sha: string) => sha.slice(0, 8);

const sameCommand = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

function tailOf(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.trimEnd().split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

/** 書くときに残す、直近の通った結果の数。全体の検査の基準のコミットの結果は、これより古くても残す */
const KEEP_RESULTS = 5;

async function readRecord(file: string): Promise<CheckRecord> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CheckRecord>;
    const record: CheckRecord = { results: Array.isArray(parsed.results) ? parsed.results : [] };
    if (parsed.full) record.full = parsed.full;
    return record;
  } catch {
    // 読めない・旧形式（1 チケット 1 件のオブジェクト）は results が空になり、初回の検査だけ回し直す（t741）
    return { results: [] };
  }
}

/** 書くときに残す結果：直近 KEEP_RESULTS 件と、全体の検査の基準のコミットの結果（古い結果は捨てる） */
function prunedResults(record: CheckRecord): StoredCheck[] {
  const total = record.results.length;
  const full = record.full?.sha;
  return record.results.filter((r, i) => i >= total - KEEP_RESULTS || r.sha === full);
}

/** 作業ブランチの最新のコミット（リモートがあればリモートの先端、なければローカルの先端）。読めなければ undefined */
export async function latestCommit(
  ctx: CommandContext,
  branch: string,
): Promise<string | undefined> {
  const ref = ctx.repo.codeRemote
    ? `refs/remotes/${ctx.repo.codeRemote}/${branch}`
    : `refs/heads/${branch}`;
  const out = await runGit(ctx.repo.topLevel, ["rev-parse", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  return out.code === 0 ? out.stdout.trim() : undefined;
}

/**
 * glob を正規表現にする。* と ? は / をまたがず、** は階層をまたぐ（`docs/**` は docs の下のすべて、`**\/*.md` はどの階層の md も）。
 * ほかの文字はそのまま比べる（括弧や ! の記法は持たない。対象のパスを足すだけで足りるため）
 */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** ファイル（リポジトリの最上位からの相対パス）が glob のどれかに入るか */
export function matchesAnyGlob(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** 回す検査。light は軽い検査（actions.light_test）か。why は選んだ理由（軽い検査を設定していないときは空） */
export interface CheckChoice {
  command: string[];
  light: boolean;
  why: string;
}

/**
 * base との差分のファイルから回す検査を選ぶ（前回の全体の検査がないとき）。軽い検査とその対象のパスがどちらも設定してあり、
 * 差分のファイルが 1 つ以上あってすべて対象のパスに入るときだけ軽い検査。差分を読めない・空のときは actions.test
 */
export function chooseCheck(
  actions: Pick<Config["actions"], "test" | "light_test" | "light_paths">,
  files: readonly string[] | undefined,
): CheckChoice {
  const full = (why: string): CheckChoice => ({ command: actions.test, light: false, why });
  if (actions.light_test.length === 0 || actions.light_paths.length === 0) return full("");
  if (!files) return full("Ran actions.test because the files changed from base could not be read");
  if (files.length === 0)
    return full("Ran actions.test because there are no files changed from base");
  const outside = files.filter((f) => !matchesAnyGlob(f, actions.light_paths));
  if (outside.length > 0) {
    const shown = outside.slice(0, 3).join(", ") + (outside.length > 3 ? " and others" : "");
    return full(
      `Ran actions.test because the diff has files outside actions.light_paths (${shown}; ${outside.length} files)`,
    );
  }
  return {
    command: actions.light_test,
    light: true,
    why: `Ran the light check because all ${files.length} changed files are in actions.light_paths`,
  };
}

/** 前回の全体の検査のコミットから今のコミットまでの変化（Git の事実） */
export interface ChangesSince {
  /** 前回のコミットが今のコミットの祖先か（rebase・force push で false） */
  ancestor: boolean;
  /** 前回から今までに merge のコミットがあるか（main を取り込んだ） */
  merged: boolean;
  /** 前回から今までに変わったファイル。読めなければ undefined */
  files: readonly string[] | undefined;
}

/**
 * 前回の全体の検査（full）からの変化で回す検査を選ぶ（t741）。軽い検査は、コマンドが変わらず、祖先のまま merge がなく、
 * 前回から今までの差分のファイルがすべて actions.light_paths に入るときだけ。ほかは全体（actions.test）を回す
 */
export function chooseCheckSince(
  actions: Pick<Config["actions"], "test" | "light_test" | "light_paths">,
  full: FullCheck,
  since: ChangesSince,
): CheckChoice {
  const at = short(full.sha);
  const whole = (why: string): CheckChoice => ({ command: actions.test, light: false, why });
  if (!sameCommand(full.command, actions.test))
    return whole(
      `Ran actions.test because actions.test changed since commit ${at}, the last commit whose actions.test passed`,
    );
  if (!since.ancestor)
    return whole(
      `Ran actions.test because commit ${at}, the last commit whose actions.test passed, is not an ancestor of the latest commit (rebased or force-pushed)`,
    );
  if (since.merged)
    return whole(
      `Ran actions.test because a merge commit came after commit ${at}, the last commit whose actions.test passed (for example, main was merged in)`,
    );
  if (!since.files)
    return whole(`Ran actions.test because the files changed since commit ${at} could not be read`);
  if (since.files.length === 0)
    return whole(
      `Ran actions.test because there are no files changed since commit ${at}, the last commit whose actions.test passed`,
    );
  const outside = since.files.filter((f) => !matchesAnyGlob(f, actions.light_paths));
  if (outside.length > 0) {
    const shown = outside.slice(0, 3).join(", ") + (outside.length > 3 ? " and others" : "");
    return whole(
      `Ran actions.test because the changes since commit ${at} include files outside actions.light_paths (${shown}; ${outside.length} files)`,
    );
  }
  return {
    command: actions.light_test,
    light: true,
    why: `Ran the light check because all ${since.files.length} changed files since commit ${at}, the last commit whose actions.test passed, are in actions.light_paths`,
  };
}

/** base（リモートがあればリモートの base_branch）と sha の分岐点からの差分のファイル。改名は元と先の両方を数える。読めなければ undefined */
async function changedFiles(ctx: CommandContext, sha: string): Promise<string[] | undefined> {
  const base = ctx.repo.codeRemote
    ? `refs/remotes/${ctx.repo.codeRemote}/${ctx.repo.baseBranch}`
    : `refs/heads/${ctx.repo.baseBranch}`;
  const out = await runGit(
    ctx.repo.topLevel,
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${sha}`],
    { allowFailure: true },
  );
  return out.code === 0 ? out.stdout.split("\0").filter(Boolean) : undefined;
}

/** 前回の全体の検査のコミット（from）から sha までの変化。祖先でない・読めないものは、ほかの条件を見ずに全体へ回すように false・undefined にする */
async function changesSince(ctx: CommandContext, from: string, sha: string): Promise<ChangesSince> {
  const top = ctx.repo.topLevel;
  const ancestor =
    (await runGit(top, ["merge-base", "--is-ancestor", from, sha], { allowFailure: true })).code ===
    0;
  if (!ancestor) return { ancestor, merged: false, files: undefined };
  // merge のコミットを数える（読めなければ merge があったものとして全体を回す）
  const merges = await runGit(top, ["rev-list", "--merges", "--count", `${from}..${sha}`], {
    allowFailure: true,
  });
  const merged = merges.code !== 0 || Number(merges.stdout.trim()) > 0;
  const diff = await runGit(top, ["diff", "--name-only", "--no-renames", "-z", from, sha], {
    allowFailure: true,
  });
  return {
    ancestor,
    merged,
    files: diff.code === 0 ? diff.stdout.split("\0").filter(Boolean) : undefined,
  };
}

/** 回す検査を選ぶ。前回の全体の検査（full）があれば、そこからの変化で選ぶ（t741）。なければ base との差分で選ぶ（t632） */
async function chooseFor(
  ctx: CommandContext,
  sha: string,
  full: FullCheck | undefined,
): Promise<CheckChoice> {
  const { actions } = ctx.config;
  if (actions.light_test.length === 0 || actions.light_paths.length === 0)
    return { command: actions.test, light: false, why: "" };
  if (full) return chooseCheckSince(actions, full, await changesSince(ctx, full.sha, sha));
  return chooseCheck(actions, await changedFiles(ctx, sha));
}

async function hasUncommittedChanges(dir: string): Promise<boolean> {
  return (await runGit(dir, ["status", "--porcelain"])).stdout.trim() !== "";
}

/**
 * 検査の条件を判定する。actions.test が空なら判定しない（通す）。既定では、作業ブランチの最新のコミット（リモートの先端）を
 * checkout した、未コミットの変更のない作業ブランチの worktree で回す。local（dg gate --only check）は worktree の HEAD を、
 * 未コミットの変更がないことを確かめて検査する（push の前でもよい）。どちらも結果はコミットとコマンドごとに覚える
 */
export async function judgeCheck(
  ctx: CommandContext,
  ticket: Ticket,
  options: { local?: boolean } = {},
): Promise<CheckOutcome> {
  if (ctx.config.actions.test.length === 0)
    return {
      ok: true,
      detail:
        "actions.test is empty, so the check is not judged (confirm it with the repository's check)",
    };
  if (!ticket.branch)
    return { ok: false, detail: "There is no work branch, so the check cannot be run" };
  let dir: string | undefined;
  let sha: string | undefined;
  if (options.local) {
    dir = (await findBranchWorktree(ctx.repo, ticket.branch)) ?? undefined;
    if (!dir)
      return {
        ok: false,
        detail: `Work branch ${ticket.branch} has no worktree, so the check cannot be run (claim creates the worktree)`,
      };
    if (await hasUncommittedChanges(dir))
      return {
        ok: false,
        detail: `Worktree ${dir} has uncommitted changes, so the check is not run (commit first)`,
      };
    sha = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
  } else {
    sha = await latestCommit(ctx, ticket.branch);
    if (!sha)
      return { ok: false, detail: `Cannot read the latest commit of work branch ${ticket.branch}` };
  }
  const file = path.join(ctx.repo.localDir, CHECKS_DIR, `${ticket.id}.json`);
  const record = await readRecord(file);
  const choice = await chooseFor(ctx, sha, record.full);
  const command = choice.command;
  // detail には、どちらの検査を回したか（actions.test か actions.light_test か）と、選んだ理由を出す
  const shown = `${choice.light ? "light check actions.light_test" : "actions.test"}: ${command.join(" ")}`;
  const why = choice.why ? ` (${choice.why})` : "";
  const found = record.results.find((r) => r.sha === sha && sameCommand(r.command, command));
  let result: { code: number; tail: string };
  if (found) result = found;
  else {
    dir ??= (await findBranchWorktree(ctx.repo, ticket.branch)) ?? undefined;
    if (!dir)
      return {
        ok: false,
        detail: `Work branch ${ticket.branch} has no worktree and no check result for the latest commit ${short(sha)}, so the check cannot be run (claim creates the worktree. dg pr merge deletes the worktree after the check passes, so do not delete it earlier)`,
      };
    const head = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== sha)
      return {
        ok: false,
        detail: `The worktree HEAD (${short(head)}) is not the latest commit of the work branch (${short(sha)}). Align them with push or pull first`,
      };
    if (await hasUncommittedChanges(dir))
      return {
        ok: false,
        detail: `Worktree ${dir} has uncommitted changes, so the check is not run (commit and push first)`,
      };
    const [file0, ...args] = command;
    try {
      const out = await runProcess(dir, file0!, args, {
        allowFailure: true,
        timeoutMs: ACTIONS_TEST_TIMEOUT_MS,
      });
      result = { code: out.code, tail: tailOf(out.stdout, out.stderr) };
    } catch (error) {
      // コマンドが見つからない・時間内に終わらない。どちらも回し直せば変わりうるので覚えない
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: `Cannot run the check (${shown}): ${reason}` };
    }
    if (result.code === 0) {
      record.results.push({
        sha,
        command,
        code: result.code,
        tail: result.tail,
        at: new Date(ctx.now()).toISOString(),
      });
      // 全体の検査が通ったときだけ、その基準のコミットを動かす。軽い検査では消さない（t741）
      if (!choice.light) record.full = { sha, command };
      record.results = prunedResults(record);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    }
  }
  return result.code === 0
    ? {
        ok: true,
        detail: `The check (${shown}) passed on the latest commit ${short(sha)}${why}${found ? " (reused the remembered result for this commit)" : ""}`,
      }
    : {
        ok: false,
        detail: `The check (${shown}) failed on the latest commit ${short(sha)} (exit ${result.code})${why}. End of output:\n${result.tail}`,
      };
}
