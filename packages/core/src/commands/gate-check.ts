// 品質ゲートの検査の条件（EX-6）：config の actions.test を、作業ブランチの最新のコミットを checkout した worktree で回す。
// actions.test は run_tests の Action と同じく確認なしで実行する（config.yaml に書ける人の権限をシェルの許可と同等とみなす。ADR-007・AG-7）。
// 結果はコミットとコマンドごとに deguboard-local/checks/ に置き、同じコミットの ready の後の merge で回し直さない。Git には入れない

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runGit, runProcess } from "../git/run.js";
import { findBranchWorktree } from "../git/worktree.js";
import type { Ticket } from "../model/ticket.js";
import { writeFileAtomic } from "../storage/atomic.js";
import type { CommandContext } from "./define.js";

/** 検査の時間の上限。リポジトリの検査の全体（テストを含む）を回すので長めにとる */
export const CHECK_TIMEOUT_MS = 30 * 60_000;

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
 * 検査の条件を判定する。actions.test が空なら判定しない（通す）。最新のコミットを checkout した、未コミットの変更のない
 * 作業ブランチの worktree でだけ回す（ほかのコミットや手元の変更で通っても、PR の中身が通ったことにならないため）
 */
export async function judgeCheck(ctx: CommandContext, ticket: Ticket): Promise<CheckOutcome> {
  const command = ctx.config.actions.test;
  if (command.length === 0)
    return {
      ok: true,
      detail: "actions.test が空なので、検査は判定しない（リポジトリの規約の検査で確かめる）",
    };
  const shown = command.join(" ");
  if (!ticket.branch) return { ok: false, detail: "作業ブランチがないので、検査を回せない" };
  const sha = await latestCommit(ctx, ticket.branch);
  if (!sha)
    return { ok: false, detail: `作業ブランチ ${ticket.branch} の最新のコミットを読めない` };
  const file = path.join(ctx.repo.localDir, CHECKS_DIR, `${ticket.id}.json`);
  const stored = await readStored(file, sha, command);
  let result: { code: number; tail: string };
  if (stored) result = stored;
  else {
    const dir = await findBranchWorktree(ctx.repo, ticket.branch);
    if (!dir)
      return {
        ok: false,
        detail: `作業ブランチ ${ticket.branch} の worktree がないので、検査を回せない（claim が作る）`,
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
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      result = { code: out.code, tail: tailOf(out.stdout, out.stderr) };
    } catch (error) {
      // コマンドが見つからない・時間内に終わらない。どちらも回し直せば変わりうるので覚えない
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: `検査（${shown}）を回せない: ${reason}` };
    }
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
  return result.code === 0
    ? { ok: true, detail: `検査（${shown}）が最新のコミット ${short(sha)} で通った` }
    : {
        ok: false,
        detail: `検査（${shown}）が最新のコミット ${short(sha)} で通らない（exit ${result.code}）。出力の末尾:\n${result.tail}`,
      };
}
