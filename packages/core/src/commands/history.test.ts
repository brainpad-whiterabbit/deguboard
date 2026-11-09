import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { readHistory } from "../git/history.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { epicAdd, epicCreate } from "./epic.js";
import { history } from "./history.js";
import { iterationAdd, iterationClose, iterationCreate, iterationStart } from "./iteration.js";
import { commit, init } from "./setup.js";
import { ticketClaim, ticketCreate, ticketMove, ticketUpdate } from "./ticket.js";

// git の呼び出しを記録する（チケット 1 枚の history が、そのファイルに絞った git log を読むことを確かめる）
const gitCalls = vi.hoisted(() => [] as (readonly string[])[]);
vi.mock("../git/run.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../git/run.js")>();
  return {
    ...real,
    runGit: (cwd: string, args: readonly string[], opts?: Parameters<typeof real.runGit>[2]) => {
      gitCalls.push(args);
      return real.runGit(cwd, args, opts);
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function initialized(f: Fixture): Promise<CommandContext> {
  const actor = { kind: "human" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  return openContext({ cwd: f.cloneA, actor });
}

/** t1・t2 を起票し、s1 を始めて s1 と e1 に入れて進め、s1 を閉じて t2 を持ち越し、t2 を claim して PR を記録する */
async function scenario(): Promise<CommandContext> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const ctx = await initialized(f);
  await runCommand(ticketCreate, ctx, { title: "A" });
  await runCommand(ticketCreate, ctx, { title: "B" });
  await runCommand(epicCreate, ctx, { title: "E" });
  await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
  // start は即座にコミットするので、まとめる前に行う
  await runCommand(iterationStart, ctx, { iteration: "s1" });
  // commit.mode は batch なので、ここからは 1 コミットにまとまる
  await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
  await runCommand(epicAdd, ctx, { epic: "e1", tickets: ["t1"] });
  await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
  await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
  await runCommand(commit, ctx, {});
  await runCommand(iterationClose, ctx, { iteration: "s1" });
  await runCommand(commit, ctx, { message: "s1 を閉じる" });
  const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
  await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2", branch: "feat/b" });
  await runCommand(ticketUpdate, agent, { ticket: "t2", pr: 5 });
  await runCommand(commit, agent, {});
  return agent;
}

const changesOf = (events: { changes: { field: string; from: unknown; to: unknown }[] }[]) =>
  events.flatMap((e) => e.changes.map((c) => `${c.field}: ${c.from ?? "-"} → ${c.to ?? "-"}`));

describe("history", () => {
  it("チケットごとに起票・遷移・Iteration と Epic の出入り・担当者・PR を時刻の順に返す。まとめたコミットの複数のチケットも拾う", async () => {
    const ctx = await scenario();
    const all = (await runCommand(history, ctx, {})).data;
    expect(all.shallow).toBe(false);
    expect(all.incomplete).toEqual([]);

    const t1 = all.events.filter((e) => e.kind === "ticket" && e.id === "t1");
    expect(t1[0]).toMatchObject({ type: "created", changes: [{ field: "status", to: "todo" }] });
    expect(changesOf(t1.slice(1))).toEqual([
      "status: todo → done",
      "iteration: - → s1",
      "epic: - → e1",
    ]);
    // 同じまとめたコミットで t2 も Iteration に入っている
    const batch = t1[1]!.commit;
    expect(
      all.events.some((e) => e.id === "t2" && e.commit === batch && e.changes.length > 0),
    ).toBe(true);

    const t2 = (await runCommand(history, ctx, { ticket: "2" })).data.events;
    expect(t2.every((e) => e.id === "t2")).toBe(true);
    expect(changesOf(t2.slice(1))).toEqual([
      "iteration: - → s1",
      // 閉じたときに持ち越して外された Iteration が残る
      "iteration: s1 → -",
      "status: todo → in_progress",
      "assignee: - → eiki/agent",
      "pr: - → 5",
    ]);
    expect(t2.find((e) => e.subject.includes("claim"))?.author).toBe("テスト");
    // 時刻の順
    const times = all.events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  it("Epic・Iteration で絞ると、それ自身と一度でも入っていたチケットの経過を返す", async () => {
    const ctx = await scenario();
    const bySprint = (await runCommand(history, ctx, { iteration: "s1" })).data.events;
    expect(new Set(bySprint.map((e) => e.id))).toEqual(new Set(["s1", "t1", "t2"]));
    expect(changesOf(bySprint.filter((e) => e.id === "s1"))).toEqual([
      "status: - → planned",
      "status: planned → active",
      "status: active → closed",
    ]);
    const byEpic = (await runCommand(history, ctx, { epic: "e1" })).data.events;
    expect(new Set(byEpic.map((e) => e.id))).toEqual(new Set(["e1", "t1"]));
  });

  it("履歴が浅い clone では欠けたことを結果に出し、失敗しない", async () => {
    const ctx = await scenario();
    await git(ctx.repo.dataDir, ["fetch", "--quiet", "--depth", "1", "origin", "deguboard"]);
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "review" });
    await runCommand(commit, ctx, {});
    const r = await runCommand(history, ctx, {});
    expect(r.data.shallow).toBe(true);
    expect(r.warnings.join()).toContain("浅い");
    // 境界のコミットより前は欠ける。境界の中身は起点として読み、その後の変化だけを返す
    expect(r.data.incomplete).toEqual(["e1", "s1", "t1", "t2"]);
    expect(r.data.events.map((e) => e.type)).toEqual(["changed"]);
    expect(changesOf(r.data.events)).toEqual(["status: in_progress → review"]);
    // チケット 1 枚で引いても、同じ欠け方と経過を返す
    const one = await runCommand(history, ctx, { ticket: "2" });
    expect(one.data.shallow).toBe(true);
    expect(one.data.incomplete).toEqual(["t2"]);
    expect(changesOf(one.data.events)).toEqual(["status: in_progress → review"]);
  });

  it("ID でない値は使い方の誤り", async () => {
    const ctx = await scenario();
    await expect(runCommand(history, ctx, { ticket: "x1" })).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("チケット 1 枚の history は、そのファイルに絞った git log を 1 回だけ読む。全体のときは従来どおり 3 つのディレクトリ", async () => {
    const ctx = await scenario();
    gitCalls.length = 0;
    await runCommand(history, ctx, { ticket: "2" });
    const one = gitCalls.filter((a) => a.includes("log"));
    expect(one).toHaveLength(1);
    expect(one[0]!.slice(one[0]!.indexOf("--"))).toEqual([
      "--",
      ":(literal)tickets/t2.md",
      ":(literal)tickets/t2.yaml",
      ":(literal)tickets/t2.yml",
    ]);

    gitCalls.length = 0;
    await runCommand(history, ctx, {});
    const all = gitCalls.filter((a) => a.includes("log"));
    expect(all).toHaveLength(1);
    expect(all[0]!.slice(all[0]!.indexOf("--"))).toEqual(["--", "tickets", "epics", "iterations"]);
  });

  it("線形の履歴では、チケット 1 枚の経過は全体から絞った経過と同じ（消えたチケットを含む）", async () => {
    const ctx = await scenario();
    const dir = ctx.repo.dataDir;
    await git(dir, ["rm", "-q", "tickets/t1.md"]);
    await git(dir, ["commit", "-qm", "t1 を消す"]);
    expect((await git(dir, ["rev-list", "--merges", "HEAD"])).stdout.trim()).toBe("");

    const full = await readHistory(dir);
    expect(full.events.some((e) => e.id === "t1" && e.type === "deleted")).toBe(true);
    for (const id of ["t1", "t2"]) {
      const only = await readHistory(dir, { ticket: id });
      expect(only.events).toEqual(full.events.filter((e) => e.kind === "ticket" && e.id === id));
      expect(only.incomplete).toEqual(full.incomplete.filter((x) => x === id));
      expect(only.shallow).toBe(full.shallow);
    }
  });

  it("線形の履歴では、--epic・--iteration の結果は変わらない（全体の読みのまま）", async () => {
    const ctx = await scenario();
    const bySprint = (await runCommand(history, ctx, { iteration: "s1" })).data.events;
    expect(bySprint.map((e) => `${e.kind}:${e.id}:${e.type}`)).toEqual([
      "ticket:t1:created",
      "ticket:t2:created",
      "iteration:s1:created",
      "iteration:s1:changed",
      "ticket:t1:changed",
      "ticket:t2:changed",
      "iteration:s1:changed",
      "ticket:t2:changed",
      "ticket:t2:changed",
      "ticket:t2:changed",
    ]);
    expect(changesOf(bySprint.filter((e) => e.kind === "iteration"))).toEqual([
      "status: - → planned",
      "status: planned → active",
      "status: active → closed",
    ]);
    const byEpic = (await runCommand(history, ctx, { epic: "e1" })).data.events;
    expect(byEpic.map((e) => `${e.kind}:${e.id}:${e.type}`)).toEqual([
      "epic:e1:created",
      "ticket:t1:created",
      "ticket:t1:changed",
    ]);
  });

  it("merge の片側だけに入った変更は、チケット 1 枚の経過には残るが、全体の経過（--epic・--iteration を含む）には残らない", async () => {
    const ctx = await scenario();
    const dir = ctx.repo.dataDir;
    const base = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const t2 = path.join(dir, "tickets", "t2.md");
    const setStatus = async (to: string) =>
      writeFile(t2, (await readFile(t2, "utf8")).replace(/^status: .*$/m, `status: ${to}`));

    // 同じ行を両側で違う値に変えてから merge し、解決で side の版を採る。main 側の変化（done）は
    // 結果の版に残らない。既定の簡約の全体の読みでは経過から落ち、チケット 1 枚の読み（--full-history）では残る
    await git(dir, ["switch", "-q", "-c", "side"]);
    await setStatus("review");
    await git(dir, ["commit", "-qam", "t2 を review に"]);
    await git(dir, ["switch", "-q", base]);
    await setStatus("done");
    await git(dir, ["commit", "-qam", "t2 を done に"]);
    const merged = await git(dir, ["merge", "--no-ff", "--no-edit", "side"]).catch(() => null);
    expect(merged).toBeNull();
    await git(dir, ["checkout", "-q", "--theirs", "--", "tickets/t2.md"]);
    await git(dir, ["add", "tickets/t2.md"]);
    await git(dir, ["commit", "-q", "--no-edit"]);
    await git(dir, ["rm", "-q", "tickets/t1.md"]);
    await git(dir, ["commit", "-qm", "t1 を消す"]);
    expect((await git(dir, ["rev-list", "--merges", "HEAD"])).stdout.trim()).not.toBe("");

    const full = await readHistory(dir);
    expect(full.events.some((e) => e.id === "t2" && e.changes.some((c) => c.to === "done"))).toBe(
      false,
    );
    expect(full.events.some((e) => e.id === "t1" && e.type === "deleted")).toBe(true);
    const only = await readHistory(dir, { ticket: "t2" });
    expect(only.events.some((e) => e.changes.some((c) => c.to === "done"))).toBe(true);
    expect(only.events.some((e) => e.changes.some((c) => c.to === "review"))).toBe(true);
    const deleted = await readHistory(dir, { ticket: "t1" });
    expect(deleted.events.map((e) => e.type)).toEqual(["created", "changed", "deleted"]);
  });
});
