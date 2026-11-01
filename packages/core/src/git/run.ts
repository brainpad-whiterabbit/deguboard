// git と gh を execFile で引数配列として呼ぶ（シェルを経由しない。ADR-008）

import { execFile } from "node:child_process";
import path from "node:path";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitErrorKind = "missing" | "exit" | "timeout";

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    readonly args: readonly string[],
    readonly result: ExecResult | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunOptions {
  timeoutMs?: number;
  /** true なら終了コードが 0 以外でも投げずに ExecResult を返す */
  allowFailure?: boolean;
  /** 追加の環境変数 */
  env?: Record<string, string>;
}

// dg が hook や他ツールから呼ばれたときに漏れてくると別のリポジトリに書いてしまう変数
const STRIPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
];

function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
  for (const k of STRIPPED_ENV) delete env[k];
  return env;
}

function exec(
  file: string,
  args: readonly string[],
  cwd: string,
  opts: RunOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd,
        env: cleanEnv(opts.env),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const e = error as
          | (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string })
          | null;
        if (e && e.code === "ENOENT") {
          reject(new GitError("missing", args, undefined, `${file} が見つからない`));
          return;
        }
        if (e && (e.killed || e.signal === "SIGTERM") && typeof e.code !== "number") {
          reject(
            new GitError(
              "timeout",
              args,
              { stdout, stderr, code: -1 },
              `${file} ${args[0] ?? ""} が時間内に終わらない`,
            ),
          );
          return;
        }
        const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        const result = { stdout, stderr, code };
        if (code !== 0 && !opts.allowFailure) {
          reject(
            new GitError(
              "exit",
              args,
              result,
              `${file} ${args.join(" ")} が失敗した (exit ${code}): ${stderr.trim()}`,
            ),
          );
          return;
        }
        resolve(result);
      },
    );
    // stdin を閉じる。閉じないと `hash-object --stdin` のように標準入力を読むコマンドが待ち続ける
    child.stdin?.end();
  });
}

/** 利用者の hooks（husky など）が deguboard worktree への commit で動かないよう、空の hooksPath を前置する */
function gitBaseArgs(localDir: string | undefined): string[] {
  return localDir ? ["-c", `core.hooksPath=${path.join(localDir, "no-hooks")}`] : [];
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  opts: RunOptions & { localDir?: string } = {},
): Promise<ExecResult> {
  return exec("git", [...gitBaseArgs(opts.localDir), ...args], cwd, opts);
}

export async function runGh(
  cwd: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<ExecResult> {
  return exec("gh", args, cwd, opts);
}

/** git・gh 以外のプログラムを引数配列で呼ぶ（Action のテスト実行と、許可したシェル。actions モジュール） */
export async function runProcess(
  cwd: string,
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<ExecResult> {
  return exec(file, args, cwd, opts);
}
