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
import { configSet, init } from "./setup.js";
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

  it("--method・--delete-branch を省けば config の merge.method・merge.delete_branch に従い、渡せばそちらを使う（t601）", async () => {
    const { ctx: first, calls, undraft } = await prepared();
    await runCommand(configSet, first, { key: "merge.method", value: "rebase" });
    await runCommand(configSet, first, { key: "merge.delete_branch", value: "true" });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(merged.method).toBe("rebase");
    await runCommand(prMerge, ctx, { ticket: "t1", method: "merge", delete_branch: false });
    expect(await calls()).toEqual(["pr merge 7 --rebase --delete-branch", "pr merge 7 --merge"]);
  });

  it("--delete-branch のときは品質ゲートを通した後、gh を呼ぶ前に作業ブランチの worktree を消し、その worktree から呼べば消さずに警告する（t601）", async () => {
    const { ctx, calls, undraft } = await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // feat/t1 を cloneA から外し、別の worktree に checkout する
    const main = ctx.repo.topLevel;
    await git(main, ["checkout", "-q", "main"]);
    const wt = path.join(path.dirname(main), "wt-t1");
    await git(main, ["worktree", "add", "-q", wt, "feat/t1"]);
    // その worktree から呼ぶと、自分の作業ツリーは消さない
    const inner = await openContext({ cwd: wt, actor: ctx.actor });
    const fromInside = await runCommand(prMerge, inner, { ticket: "t1", delete_branch: true });
    expect(fromInside.warnings.join("\n")).toContain(
      "worktree から呼んだので、worktree を消さない",
    );
    expect(await git(main, ["worktree", "list"])).toMatchObject({
      stdout: expect.stringContaining("wt-t1"),
    });
    // main の worktree から呼ぶと消してから gh を呼ぶ
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true });
    expect(merged.warnings).toEqual([]);
    expect((await git(main, ["worktree", "list"])).stdout).not.toContain("wt-t1");
    expect(await calls()).toEqual([
      "pr merge 7 --squash --delete-branch",
      "pr merge 7 --squash --delete-branch",
    ]);
  });

  it("検査（actions.test）が通らなければ GATE_FAILED に終了コードと出力の末尾を入れ、gh を呼ばない（t601）", async () => {
    const { ctx: first, calls } = await prepared();
    const script = path.join(path.dirname(first.repo.topLevel), "failing-check.sh");
    await writeFile(script, "#!/bin/sh\necho 落ちたテスト\nexit 1\n", { mode: 0o755 });
    await runCommand(configSet, first, { key: "actions.test", value: `sh, ${script}` });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    const ready = await rejection(runCommand(prReady, ctx, { ticket: "t1" }));
    expect(ready!.code).toBe("GATE_FAILED");
    expect(ready!.detail).toContain("check: 検査");
    expect(ready!.detail).toContain("exit 1");
    expect(ready!.detail).toContain("落ちたテスト");
    expect(await calls()).toEqual([]);
  });
});
