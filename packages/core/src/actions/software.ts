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
  .refine(
    isSafeBranchName,
    "Cannot be used as a branch name (it starts with - or contains characters git does not allow)",
  );
const branchName = refName.describe(
  "Work branch name, given in full. For ticket work dg names it `<id>-<English words>` (for example `t12-fix-login`)",
);
const baseName = refName
  .optional()
  .describe("Branch to start from. Defaults to git.base_branch when omitted");
// Action はチケットを知らないので、claim --no-worktree の後に切るときは呼び手がチケットの branch_base を渡す。
// 取り込み直した base から切ると、main が進んでいれば起点が記録とずれ、コミットのないブランチがマージ済みに見える（ST-4）
const startCommit = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "start is a commit SHA")
  .optional()
  .describe(
    "SHA of the commit to start from. Pass the ticket's branch_base to start from the same commit that claim recorded. Defaults to the tip of the fetched base when omitted",
  );

export const createWorktreeAction = defineAction({
  name: "create_worktree",
  summary:
    "Create the work branch from base (from the start commit when given) and check it out in a worktree",
  input: z.object({
    branch: branchName,
    base: baseName,
    start: startCommit,
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Worktree location. Defaults to worktree.root/<branch name> when omitted"),
  }),
  confirm: false,
  async run(ctx, input) {
    const base = input.base ?? ctx.repo.baseBranch;
    const dir = path.resolve(
      ctx.cwd,
      input.path ?? defaultWorktreePath(ctx.repo, ctx.config.worktree.root, input.branch),
    );
    return createBranchWorktree(ctx.cwd, ctx.repo, {
      branch: input.branch,
      base,
      dir,
      start: input.start,
    });
  },
});

export const createBranchAction = defineAction({
  name: "create_branch",
  summary:
    "Create the work branch from base (from the start commit when given), without checking it out",
  input: z.object({ branch: branchName, base: baseName, start: startCommit }),
  confirm: false,
  async run(ctx, input) {
    const start =
      input.start ?? (await branchStartPoint(ctx.cwd, ctx.repo, input.base ?? ctx.repo.baseBranch));
    await runGit(ctx.cwd, ["branch", "--no-track", "--", input.branch, start]);
    return { branch: input.branch, base: start };
  },
});

export const runTestsAction = defineAction({
  name: "run_tests",
  summary:
    "Run the actions.test command in the working directory. A failure returns the result without throwing",
  input: z.object({
    timeout_ms: z.number().int().positive().default(ACTIONS_TEST_TIMEOUT_MS),
  }),
  confirm: false,
  allowed: (config) =>
    config.actions.test.length > 0
      ? null
      : "The test command is not set (write it as an argument array in actions.test of config.yaml)",
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
    throw new OperationError("REJECTED", `${cwd} has no branch checked out`);
  }
  return name;
}

export const createPrAction = defineAction({
  name: "create_pr",
  summary: "Open a PR from the work branch to base with gh (the branch must already be pushed)",
  input: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
    branch: branchName
      .optional()
      .describe(
        "Branch to open the PR from. Defaults to the branch checked out in the working directory",
      ),
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
  summary: "Merge the PR with gh (squash by default)",
  input: z.object({
    pr: z.number().int().positive(),
    method: z.enum(PR_MERGE_METHODS).default("squash"),
    delete_branch: z.boolean().default(false).describe("Also delete the remote and local branches"),
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
