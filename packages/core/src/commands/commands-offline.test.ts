// push 先に届かないときの即時の操作（SY-3・DT-5）と、リモートのない運用（SY-6）を、bare リモート付きの一時リポジトリで確かめる

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo, git } from "../../test/helpers/git-fixture.js";
import {
  agentWithRuns,
  cleanups,
  fixture,
  initialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";
import type { CommandContext } from "./define.js";
import { runCommand } from "./define.js";
import { epicCreate } from "./epic.js";
import { iterationClose, iterationCreate, iterationReopen, iterationStart } from "./iteration.js";
import { planCreate } from "./plan.js";
import { runList } from "./run.js";
import { sync } from "./setup.js";
import { ticketClaim, ticketCreate } from "./ticket.js";

afterEach(runCleanups);

const NOW = new Date("2026-11-12T03:00:00Z");

/** データのリポジトリの HEAD（失敗した操作がコミットを残さないことを見る） */
const head = async (ctx: CommandContext) =>
  (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();

/** clone の worktree とブランチの一覧（claim が worktree も作業ブランチも作らないことを見る） */
const worktreesAndBranches = async (cwd: string) => ({
  worktrees: (await git(cwd, ["worktree", "list", "--porcelain"])).stdout,
  branches: (await git(cwd, ["branch", "--list", "--format=%(refname:short)"])).stdout,
});

const goOffline = (f: { root: string; cloneA: string }) =>
  git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);

describe("push 先に届かないときの即時の操作（SY-3）", () => {
  it("ticket claim は自分のコミットを捨てて PUSH_FAILED で失敗し、worktree もブランチも Run も作らない", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA, { now: () => NOW });
    await runCommand(ticketCreate, human, { title: "A" });
    const agent = await agentWithRuns(f.cloneA, () => NOW);
    await goOffline(f);
    const before = await head(agent);
    const layout = await worktreesAndBranches(f.cloneA);

    await expect(runCommand(ticketClaim, agent, { ticket: "t1" })).rejects.toMatchObject({
      code: "PUSH_FAILED",
    });
    expect(await head(agent)).toBe(before);
    expect(agent.store.tickets.get("t1")?.data).toMatchObject({ status: "todo" });
    expect(agent.store.tickets.get("t1")?.data.assignee).toBeUndefined();
    expect(await worktreesAndBranches(f.cloneA)).toEqual(layout);
    expect((await runCommand(runList, agent, {})).data).toEqual([]);
    // 届くようになれば同じ claim が通る
    await git(f.cloneA, ["remote", "set-url", "origin", f.remoteDir]);
    const claimed = await runCommand(ticketClaim, agent, { ticket: "t1", no_worktree: true });
    expect(claimed.write).toMatchObject({ pushed: true });
  });

  it("iteration start と reopen は自分のコミットを捨てて PUSH_FAILED で失敗する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, { now: () => NOW });
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(iterationCreate, ctx, { name: "S2" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    // close はまとめ待ちに残るので、先に送っておく（即時の操作が先にまとめ待ちをコミットする分を HEAD の比べから外す）
    await runCommand(sync, ctx, {});
    await goOffline(f);
    const before = await head(ctx);

    await expect(runCommand(iterationStart, ctx, { iteration: "s2" })).rejects.toMatchObject({
      code: "PUSH_FAILED",
    });
    await expect(runCommand(iterationReopen, ctx, { iteration: "s1" })).rejects.toMatchObject({
      code: "PUSH_FAILED",
    });
    expect(await head(ctx)).toBe(before);
    expect(ctx.store.iterations.get("s1")?.data.status).toBe("closed");
    expect(ctx.store.iterations.get("s2")?.data.status).toBe("planned");
  });

  it("Epic・Iteration・Plan の作成は自分のコミットを捨てて PUSH_FAILED で失敗する。チケットの起票だけは仮番号で残る（DT-5）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, { now: () => NOW });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await goOffline(f);
    const before = await head(ctx);

    await expect(runCommand(epicCreate, ctx, { title: "E" })).rejects.toMatchObject({
      code: "PUSH_FAILED",
    });
    await expect(runCommand(iterationCreate, ctx, { name: "S1" })).rejects.toMatchObject({
      code: "PUSH_FAILED",
    });
    await expect(runCommand(planCreate, ctx, { tickets: ["t1"] })).rejects.toMatchObject({
      code: "PUSH_FAILED",
    });
    expect(await head(ctx)).toBe(before);
    expect(ctx.store.epics.size).toBe(0);
    expect(ctx.store.iterations.size).toBe(0);
    expect(ctx.store.plans.size).toBe(0);

    const filed = await runCommand(ticketCreate, ctx, { title: "B" });
    expect(filed.write).toMatchObject({ committed: true, pushed: false, provisional: true });
  });
});

describe("仮番号のチケットの claim（DT-5）", () => {
  it("仮番号のチケットは dg sync で番号を確定するよう案内して拒否し、確定した後は claim できる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, { now: () => NOW });
    await goOffline(f);
    await runCommand(ticketCreate, ctx, { title: "オフラインの起票" });
    expect(ctx.store.tickets.get("t1")?.data.provisional).toBe(true);
    // 届くようになっても、sync で確定するまでは claim しない（ブランチ名に仮番号を残さない）
    await git(f.cloneA, ["remote", "set-url", "origin", f.remoteDir]);
    const rejected = runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    await expect(rejected).rejects.toMatchObject({ code: "REJECTED" });
    await expect(rejected).rejects.toThrow(/provisional number.*dg sync/);
    expect(ctx.store.tickets.get("t1")?.data.status).toBe("todo");

    await runCommand(sync, ctx, {});
    expect(ctx.store.tickets.get("t1")?.data.provisional).toBeUndefined();
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    expect(claimed.data).toMatchObject({
      status: "in_progress",
      branch: expect.stringMatching(/t1/),
    });
  });
});

describe("リモートのない運用（SY-6）", () => {
  it("claim・iteration start と reopen・Epic・Iteration・Plan の作成は、今までどおりローカルにコミットして成功する", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const ctx = await initialized(local.dir, { now: () => NOW });
    expect(ctx.repo.remote).toBeNull();

    const filed = await runCommand(ticketCreate, ctx, { title: "A" });
    expect(filed.write).toMatchObject({ committed: true, pushed: false, provisional: false });
    const epic = await runCommand(epicCreate, ctx, { title: "E" });
    expect(epic.write).toMatchObject({ committed: true, pushed: false });
    await runCommand(iterationCreate, ctx, { name: "S1" });
    const s2 = await runCommand(iterationCreate, ctx, { name: "S2" });
    expect(s2.write).toMatchObject({ committed: true, pushed: false });
    const plan = await runCommand(planCreate, ctx, { tickets: ["t1"] });
    expect(plan.write).toMatchObject({ committed: true, pushed: false });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const reopened = await runCommand(iterationReopen, ctx, { iteration: "s1" });
    expect(reopened.write).toMatchObject({ committed: true, pushed: false });
    expect(ctx.store.iterations.get("s1")?.data.status).toBe("active");
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    expect(claimed.write).toMatchObject({ committed: true, pushed: false });
    expect(claimed.data.status).toBe("in_progress");
  });
});
