// ソフトウェア開発向けの登録済みの Action（AG-6）。git・gh は引数配列で呼び、シェルを経由しない

import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import { runGh, runGit, runProcess } from "../git/run.js";
import { defineAction, type ActionContext } from "./define.js";

/**
 * `git check-ref-format --branch` 相当の検査。先頭の `-` を拒み、git にオプションとして読まれないようにする
 * （`--upload-pack=<コマンド>` のような注入で actions.shell を回り込ませない。AG-7）
 */
export function isSafeBranchName(name: string): boolean {
  if (name === "" || name === "@" || name.startsWith("-")) return false;
  // 制御文字・空白・~ ^ : ? * [ \ と、`..`・`@{`・`//` を含むもの
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

const refName = z
  .string()
  .refine(isSafeBranchName, "ブランチ名として使えない（先頭の - や git が許さない文字を含む）");
const branchName = refName.describe("ブランチ名（feat/xxx など）");
const baseName = refName.optional().describe("元にするブランチ。省略時は git.base_branch");

/** 作業ブランチの起点。リモートがあれば取り込んでから <remote>/<base>、なければローカルの <base> */
async function startPoint(ctx: ActionContext & { cwd: string }, base: string): Promise<string> {
  // 省略時の base は config（Git で共有される）から来るので、ここでも検査する
  if (!isSafeBranchName(base)) {
    throw new OperationError("REJECTED", `base のブランチ名として使えない：${base}`);
  }
  const remote = ctx.repo.remote;
  if (!remote) return base;
  await runGit(ctx.cwd, ["fetch", "--", remote, base], { timeoutMs: 120_000 });
  return `${remote}/${base}`;
}

/** worktree.root（`<repo>` を置き換え、メインの作業ツリーからの相対）にブランチ名をつないだ場所 */
export function defaultWorktreePath(
  repo: ActionContext["repo"],
  root: string,
  branch: string,
): string {
  const main =
    path.basename(repo.commonDir) === ".git" ? path.dirname(repo.commonDir) : repo.topLevel;
  const resolvedRoot = path.resolve(main, root.replaceAll("<repo>", path.basename(main)));
  return path.join(resolvedRoot, branch);
}

export const createWorktreeAction = defineAction({
  name: "create_worktree",
  summary: "base から作業ブランチを切り、worktree に checkout する",
  input: z.object({
    branch: branchName,
    base: baseName,
    path: z
      .string()
      .min(1)
      .optional()
      .describe("worktree の場所。省略時は worktree.root/<ブランチ名>"),
  }),
  confirm: false,
  async run(ctx, input) {
    const base = input.base ?? ctx.repo.baseBranch;
    const dir = path.resolve(
      ctx.cwd,
      input.path ?? defaultWorktreePath(ctx.repo, ctx.config.worktree.root, input.branch),
    );
    const start = await startPoint(ctx, base);
    await runGit(ctx.cwd, ["worktree", "add", "--no-track", "-b", input.branch, "--", dir, start]);
    return { branch: input.branch, path: dir, base: start };
  },
});

export const createBranchAction = defineAction({
  name: "create_branch",
  summary: "base から作業ブランチを切る（checkout はしない）",
  input: z.object({ branch: branchName, base: baseName }),
  confirm: false,
  async run(ctx, input) {
    const start = await startPoint(ctx, input.base ?? ctx.repo.baseBranch);
    await runGit(ctx.cwd, ["branch", "--no-track", "--", input.branch, start]);
    return { branch: input.branch, base: start };
  },
});

export const runTestsAction = defineAction({
  name: "run_tests",
  summary: "actions.test のコマンドを作業ディレクトリで実行する。失敗しても投げずに結果を返す",
  input: z.object({
    timeout_ms: z
      .number()
      .int()
      .positive()
      .default(30 * 60_000),
  }),
  confirm: false,
  allowed: (config) =>
    config.actions.test.length > 0
      ? null
      : "テストのコマンドが設定されていない（config.yaml の actions.test に引数配列で書く）",
  async run(ctx, input) {
    const [file, ...args] = ctx.config.actions.test;
    const result = await runProcess(ctx.cwd, file ?? "", args, {
      allowFailure: true,
      timeoutMs: input.timeout_ms,
    });
    return { passed: result.code === 0, ...result };
  },
});

async function currentBranch(cwd: string): Promise<string> {
  const name = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (name === "HEAD") {
    throw new OperationError("REJECTED", `${cwd} はブランチを checkout していない`);
  }
  return name;
}

export const createPrAction = defineAction({
  name: "create_pr",
  summary: "作業ブランチから base への PR を gh で作る（ブランチは push 済みであること）",
  input: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
    branch: branchName.optional().describe("PR にするブランチ。省略時は作業ディレクトリのブランチ"),
    base: baseName,
    draft: z.boolean().default(false),
  }),
  confirm: false,
  async run(ctx, input) {
    const branch = input.branch ?? (await currentBranch(ctx.cwd));
    const base = input.base ?? ctx.repo.baseBranch;
    const args = ["pr", "create", "--base", base, "--head", branch];
    args.push("--title", input.title, "--body", input.body);
    if (input.draft) args.push("--draft");
    const url = (await runGh(ctx.cwd, args)).stdout.trim().split("\n").at(-1) ?? "";
    const number = /\/pull\/(\d+)/.exec(url)?.[1];
    return { url, number: number ? Number(number) : null, branch, base };
  },
});

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;

export const mergePrAction = defineAction({
  name: "merge_pr",
  summary: "PR を gh でマージする（既定は squash）",
  input: z.object({
    pr: z.number().int().positive(),
    method: z.enum(MERGE_METHODS).default("squash"),
    delete_branch: z.boolean().default(false).describe("リモートとローカルのブランチも消すか"),
  }),
  confirm: false,
  async run(ctx, input) {
    const args = ["pr", "merge", String(input.pr), `--${input.method}`];
    if (input.delete_branch) args.push("--delete-branch");
    await runGh(ctx.cwd, args, { timeoutMs: 120_000 });
    return { pr: input.pr, method: input.method };
  },
});

export const softwareActions = [
  createWorktreeAction,
  createBranchAction,
  runTestsAction,
  createPrAction,
  mergePrAction,
] as const;
