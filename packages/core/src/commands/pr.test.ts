import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { OperationError } from "../errors.js";
import { resetGhCache } from "../git/facts.js";
import type { Run } from "../model/run.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { prMerge, prReady, type PrAdvanceView } from "./pr.js";
import { runFinish, runReviewResult, runStart } from "./run.js";
import { init } from "./setup.js";
import { ticketCheck, ticketClaim, ticketCreate } from "./ticket.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 偽の gh。pr view は PR #7 を返し、pr ready・pr merge は引数を記録に書き足す */
async function fakeGh(root: string, pr: () => string) {
  const bin = path.join(root, "fake-bin");
  const log = path.join(root, "gh-calls.log");
  await mkdir(bin, { recursive: true });
  const write = () =>
    writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$2" in',
        `  view) echo '${pr()}';;`,
        `  ready|merge) echo "$@" >> '${log}';;`,
        "  *) exit 1;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  await write();
  const saved = process.env["PATH"];
  process.env["PATH"] = bin + path.delimiter + (saved ?? "");
  resetGhCache();
  cleanups.push(() => {
    process.env["PATH"] = saved;
    resetGhCache();
  });
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter((l) => l !== "");
  return { write, calls };
}

/** t1 を feat/t1 で claim して 1 コミット push し、PR #7（偽の gh。draft）がある文脈 */
async function prepared() {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "agent" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {
    template: "software-development",
  });
  const ctx: CommandContext = await openContext({ cwd: f.cloneA, actor });
  await runCommand(ticketCreate, ctx, {
    title: "A",
    body: "## 受け入れ条件\n\n- [ ] 1 つめ\n",
  });
  await runCommand(ticketClaim, ctx, {
    no_worktree: true,
    ticket: "t1",
    branch: "feat/t1",
    no_run: true,
  });
  await git(f.cloneA, ["checkout", "-qb", "feat/t1"]);
  await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
  await git(f.cloneA, ["push", "-q", "origin", "feat/t1"]);
  const state = { draft: true };
  const gh = await fakeGh(f.root, () =>
    JSON.stringify({ number: 7, state: "OPEN", isDraft: state.draft, mergeable: "MERGEABLE" }),
  );
  const undraft = async () => {
    state.draft = false;
    await gh.write();
  };
  return { ctx, calls: gh.calls, undraft };
}

/** 最後の push より後に通った見直しを記録する */
async function passedReview(ctx: CommandContext) {
  ctx.now = () => new Date(Date.now() + 60_000);
  const run = (
    await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
  ).data as Run;
  await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
  await runCommand(runFinish, ctx, { run: run.id, result: "success" });
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as OperationError,
  );

describe("dg pr ready・dg pr merge（t545）", () => {
  it("品質ゲートを満たさなければ GATE_FAILED で満たさない条件と理由を返し、gh を呼ばない", async () => {
    const { ctx, calls } = await prepared();
    const ready = await rejection(runCommand(prReady, ctx, { ticket: "t1" }));
    expect(ready).toBeInstanceOf(OperationError);
    expect(ready!.code).toBe("GATE_FAILED");
    expect(ready!.message).toContain("dg gate t1 --for ready");
    expect(ready!.detail).toContain("review:");
    expect(ready!.detail).toContain("人に gh pr ready を打ってもらう");
    const merge = await rejection(runCommand(prMerge, ctx, { ticket: "t1" }));
    expect(merge!.code).toBe("GATE_FAILED");
    expect(merge!.detail).toContain("acceptance:");
    expect(await calls()).toEqual([]);
  });

  it("満たせば gh pr ready・gh pr merge を PR の番号で呼び、判定した品質ゲートを返す", async () => {
    const { ctx, calls, undraft } = await prepared();
    await passedReview(ctx);
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready).toMatchObject({ ticket: "t1", pr: 7, action: "ready", gate: { passed: true } });
    // マージの前は draft でなく、受け入れ条件がすべて付いていること
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }))
      .data as PrAdvanceView;
    expect(merged).toMatchObject({ pr: 7, action: "merge", method: "squash" });
    expect(await calls()).toEqual(["pr ready 7", "pr merge 7 --squash --delete-branch"]);
  });
});
