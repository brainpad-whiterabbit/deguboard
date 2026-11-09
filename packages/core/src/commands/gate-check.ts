// 品質ゲートの検査の条件（EX-6）：config の actions.test（か下の軽い検査）を、作業ブランチの最新のコミットを checkout した worktree で回す。
// actions.test は run_tests の Action と同じく確認なしで実行する（config.yaml に書ける人の権限をシェルの許可と同等とみなす。ADR-033・AG-7）。
// 通った結果はコミットとコマンドごとに deguboard-local/checks/ に置き、同じコミットの ready の後の merge で回し直さない。Git には入れない。
// 通らなかった結果は覚えない（確率で落ちる検査を、コミットを足さずに回し直せるように）
// base との差分のファイルがすべて actions.light_paths に入るときは、actions.light_test（軽い検査）を回す（t632）。
// 結果はコマンドごとに覚えるので、ready で軽い検査が通れば、同じコミットの merge も同じ差分から軽い検査を選び、回し直さない

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

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

const short = (sha: string) => sha.slice(0, 8);

function tailOf(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.trimEnd().split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

async function readStored(file: string, sha: string, command: string[]) {
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as StoredCheck;
    // 同じコミットでも、検査のコマンドを変えたら回し直す
    return stored.sha === sha && JSON.stringify(stored.command) === JSON.stringify(command)
      ? stored
      : undefined;
  } catch {
    return undefined;
  }
}

/** 作業ブランチの最新のコミット（リモートがあればリモートの先端、なければローカルの先端）。読めなければ undefined */
async function latestCommit(ctx: CommandContext, branch: string): Promise<string | undefined> {
  const ref = ctx.repo.remote
    ? `refs/remotes/${ctx.repo.remote}/${branch}`
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
 * 差分のファイルから回す検査を選ぶ。軽い検査とその対象のパスがどちらも設定してあり、差分のファイルが 1 つ以上あってすべて
 * 対象のパスに入るときだけ軽い検査。差分を読めない・空のときは actions.test（軽く済ませてよいと確かめられないため）
 */
export function chooseCheck(
  actions: Pick<Config["actions"], "test" | "light_test" | "light_paths">,
  files: readonly string[] | undefined,
): CheckChoice {
  const full = (why: string): CheckChoice => ({ command: actions.test, light: false, why });
  if (actions.light_test.length === 0 || actions.light_paths.length === 0) return full("");
  if (!files) return full("base との差分のファイルを読めないので actions.test を回した");
  if (files.length === 0) return full("base との差分のファイルがないので actions.test を回した");
  const outside = files.filter((f) => !matchesAnyGlob(f, actions.light_paths));
  if (outside.length > 0) {
    const shown = outside.slice(0, 3).join("・") + (outside.length > 3 ? " ほか" : "");
    return full(
      `差分に actions.light_paths の外のファイル（${shown}。${outside.length} 件）があるので actions.test を回した`,
    );
  }
  return {
    command: actions.light_test,
    light: true,
    why: `差分のファイル ${files.length} 件がすべて actions.light_paths に入るので軽い検査を回した`,
  };
}

/** base（リモートがあればリモートの base_branch）と sha の分岐点からの差分のファイル。改名は元と先の両方を数える。読めなければ undefined */
async function changedFiles(ctx: CommandContext, sha: string): Promise<string[] | undefined> {
  const base = ctx.repo.remote
    ? `refs/remotes/${ctx.repo.remote}/${ctx.repo.baseBranch}`
    : `refs/heads/${ctx.repo.baseBranch}`;
  const out = await runGit(
    ctx.repo.topLevel,
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${sha}`],
    { allowFailure: true },
  );
  return out.code === 0 ? out.stdout.split("\0").filter(Boolean) : undefined;
}

/**
 * 検査の条件を判定する。actions.test が空なら判定しない（通す）。最新のコミットを checkout した、未コミットの変更のない
 * 作業ブランチの worktree でだけ回す（ほかのコミットや手元の変更で通っても、PR の中身が通ったことにならないため）
 */
export async function judgeCheck(ctx: CommandContext, ticket: Ticket): Promise<CheckOutcome> {
  if (ctx.config.actions.test.length === 0)
    return {
      ok: true,
      detail: "actions.test が空なので、検査は判定しない（リポジトリの規約の検査で確かめる）",
    };
  if (!ticket.branch) return { ok: false, detail: "作業ブランチがないので、検査を回せない" };
  const sha = await latestCommit(ctx, ticket.branch);
  if (!sha)
    return { ok: false, detail: `作業ブランチ ${ticket.branch} の最新のコミットを読めない` };
  const configured =
    ctx.config.actions.light_test.length > 0 && ctx.config.actions.light_paths.length > 0;
  const choice = chooseCheck(
    ctx.config.actions,
    configured ? await changedFiles(ctx, sha) : undefined,
  );
  const command = choice.command;
  // detail には、どちらの検査を回したか（actions.test か actions.light_test か）と、選んだ理由を出す
  const shown = `${choice.light ? "軽い検査 actions.light_test" : "actions.test"}: ${command.join(" ")}`;
  const why = choice.why ? `（${choice.why}）` : "";
  const file = path.join(ctx.repo.localDir, CHECKS_DIR, `${ticket.id}.json`);
  const stored = await readStored(file, sha, command);
  let result: { code: number; tail: string };
  if (stored) result = stored;
  else {
    const dir = await findBranchWorktree(ctx.repo, ticket.branch);
    if (!dir)
      return {
        ok: false,
        detail: `作業ブランチ ${ticket.branch} の worktree がなく、最新のコミット ${short(sha)} の検査の結果もないので、検査を回せない（worktree は claim が作る。dg pr merge は検査を通した後に worktree を消すので、先に消さない）`,
      };
    const head = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== sha)
      return {
        ok: false,
        detail: `worktree の HEAD（${short(head)}）が作業ブランチの最新のコミット（${short(sha)}）でない。push か pull でそろえてから`,
      };
    const dirty = (await runGit(dir, ["status", "--porcelain"])).stdout.trim();
    if (dirty)
      return {
        ok: false,
        detail: `worktree ${dir} に未コミットの変更があるので、検査を回さない（コミットして push してから）`,
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
      return { ok: false, detail: `検査（${shown}）を回せない: ${reason}` };
    }
    if (result.code === 0) {
      const record: StoredCheck = {
        sha,
        command,
        code: result.code,
        tail: result.tail,
        at: new Date(ctx.now()).toISOString(),
      };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    }
  }
  return result.code === 0
    ? { ok: true, detail: `検査（${shown}）が最新のコミット ${short(sha)} で通った${why}` }
    : {
        ok: false,
        detail: `検査（${shown}）が最新のコミット ${short(sha)} で通らない（exit ${result.code}）${why}。出力の末尾:\n${result.tail}`,
      };
}
