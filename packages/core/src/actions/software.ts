// ソフトウェア開発向けの登録済みの Action（AG-6）。worktree の作成は claim と共有するので git/branch-worktree.ts に置く。git・gh は引数配列で呼び、シェルを経由しない

import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import {
  branchStartPoint,
  createBranchWorktree,
  defaultWorktreePath,
  isSafeBranchName,
} from "../git/branch-worktree.js";
import { runGh, runGit, runProcess } from "../git/run.js";
import { ACTIONS_TEST_TIMEOUT_MS, PR_MERGE_METHODS } from "../model/config.js";
import { defineAction } from "./define.js";

const refName = z
  .string()
  .refine(isSafeBranchName, "ブランチ名として使えない（先頭の - や git が許さない文字を含む）");
const branchName = refName.describe("ブランチ名（feat/xxx など）");
const baseName = refName.optional().describe("元にするブランチ。省略時は git.base_branch");

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
    return createBranchWorktree(ctx.cwd, ctx.repo, { branch: input.branch, base, dir });
  },
});

export const createBranchAction = defineAction({
  name: "create_branch",
  summary: "base から作業ブランチを切る（checkout はしない）",
  input: z.object({ branch: branchName, base: baseName }),
  confirm: false,
  async run(ctx, input) {
    const start = await branchStartPoint(ctx.cwd, ctx.repo, input.base ?? ctx.repo.baseBranch);
    await runGit(ctx.cwd, ["branch", "--no-track", "--", input.branch, start]);
    return { branch: input.branch, base: start };
  },
});

export const runTestsAction = defineAction({
  name: "run_tests",
  summary: "actions.test のコマンドを作業ディレクトリで実行する。失敗しても投げずに結果を返す",
  input: z.object({
    timeout_ms: z.number().int().positive().default(ACTIONS_TEST_TIMEOUT_MS),
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

export const mergePrAction = defineAction({
  name: "merge_pr",
  summary: "PR を gh でマージする（既定は squash）",
  input: z.object({
    pr: z.number().int().positive(),
    method: z.enum(PR_MERGE_METHODS).default("squash"),
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
