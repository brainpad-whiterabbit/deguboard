import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { findCommand } from "./registry.js";
import { runFinish, runList, runStart, type RunView } from "./run.js";
import { commit, configSet, init } from "./setup.js";
import { ticketCreate } from "./ticket.js";
import { finishRun } from "../run/record.js";
import type { Run } from "../model/run.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** init してチケット t1・t2 を起票した文脈 */
async function prepared(): Promise<CommandContext> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "agent" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  const ctx = await openContext({ cwd: f.cloneA, actor });
  await runCommand(ticketCreate, ctx, { title: "A" });
  await runCommand(ticketCreate, ctx, { title: "B" });
  return ctx;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const start = async (ctx: CommandContext, ticket: string, step = "implement") =>
  (await runCommand(runStart, ctx, { ticket, step, agent: "claude-code" })).data as Run;

describe("run", () => {
  it("start は deguboard-local/runs/ にだけ記録を置き、finish が runs/ に 1 ファイルをコミットする（RN-3）", async () => {
    const ctx = await prepared();
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    await runCommand(commit, ctx, {});
    ctx.config = ctx.store.config;
    const before = (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const run = await start(ctx, "t1");
    expect(run).toMatchObject({
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
      model: null,
      finished_at: null,
      result: null,
      retries: 0,
      usage: { input: null, output: null, cache_read: null, cache_write: null },
    });
    const localFile = path.join(ctx.repo.localDir, "runs", `${run.id}.json`);
    expect(await exists(localFile)).toBe(true);
    // 実行中は Git に何も書かない
    expect(await exists(path.join(ctx.repo.dataDir, "runs"))).toBe(false);
    expect((await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);

    const finished = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    expect(finished.write).toMatchObject({ committed: true, pushed: true });
    expect(finished.data).toMatchObject({ id: run.id, result: "success", error: null });
    expect((finished.data as Run).finished_at).not.toBeNull();
    // 使用量は渡されなければ null のまま（0 で補わない）
    expect((finished.data as Run).usage).toEqual({
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
    });
    const changed = (
      await git(ctx.repo.dataDir, ["show", "--name-only", "--format=%s", "HEAD"])
    ).stdout.trim();
    expect(changed.split("\n")).toEqual([
      `Run ${run.id} を記録: t1 implement success`,
      "",
      `runs/${run.id}.json`,
    ]);
    expect(await readdir(path.join(ctx.repo.dataDir, "runs"))).toEqual([`${run.id}.json`]);
    expect(await exists(localFile)).toBe(false);
    // チケットには書き足さない
    expect(await readFile(path.join(ctx.repo.dataDir, "tickets/t1.md"), "utf8")).not.toContain(
      "runs",
    );
  });

  it("同じチケットと step の Run を二重に start すると拒否し、別の step やチケットは始められる（SY-5）", async () => {
    const ctx = await prepared();
    const first = await start(ctx, "t1");
    await expect(start(ctx, "1")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(start(ctx, "t1", "review")).resolves.toMatchObject({ step: "review" });
    await expect(start(ctx, "t2")).resolves.toMatchObject({ ticket: "t2" });
    await expect(start(ctx, "t9")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 閉じれば同じ step をまた始められる
    await runCommand(runFinish, ctx, { run: first.id, result: "failure", error: "テストが落ちた" });
    await expect(start(ctx, "t1")).resolves.toMatchObject({ step: "implement" });
  });

  it("並行して start しても、同じチケットと step の Run は 1 つしか始まらない", async () => {
    const ctx = await prepared();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => start(ctx, "t1")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(path.join(ctx.repo.localDir, "runs"))).toHaveLength(1);
  });

  it("終わっていない Run が list に出て、finish --result interrupted で閉じられる（EX-2）", async () => {
    const ctx = await prepared();
    const a = await start(ctx, "t1");
    const b = await start(ctx, "t2");
    const listed = async (input: Record<string, unknown> = {}) =>
      (await runCommand(runList, ctx, input)).data as RunView[];
    expect((await listed()).map((r) => [r.id, r.running])).toEqual(
      [a.id, b.id].sort().map((id) => [id, true]),
    );
    const closed = await runCommand(runFinish, ctx, {
      run: a.id,
      result: "interrupted",
      error: "セッションが切れた",
    });
    expect(closed.data).toMatchObject({ result: "interrupted", error: "セッションが切れた" });
    expect((await listed({ running: true })).map((r) => r.id)).toEqual([b.id]);
    expect((await listed({ ticket: "t1" })).map((r) => [r.id, r.running, r.result])).toEqual([
      [a.id, false, "interrupted"],
    ]);
    // 閉じた Run はもう閉じられない。知らない Run は見つからない
    await expect(
      runCommand(runFinish, ctx, { run: a.id, result: "success" }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(runFinish, ctx, { run: "r20261031-000000-0000", result: "success" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runCommand(runFinish, ctx, { run: "r1", result: "success" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("finish は commit.mode が batch なら作業ツリーに残し、dg commit でコミットされる（CL-3）", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1");
    const r = await runCommand(runFinish, ctx, { run: run.id, result: "success", retries: 2 });
    expect(r.write).toMatchObject({ committed: false });
    expect(r.data).toMatchObject({ retries: 2 });
    await runCommand(commit, ctx, {});
    const tracked = (await git(ctx.repo.dataDir, ["ls-files", "runs"])).stdout.trim();
    expect(tracked).toBe(`runs/${run.id}.json`);
  });

  it("Adapter が渡した使用量だけを集計に入れ、渡さなかった値と中の未知のキーを残す", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1");
    const { run: done } = await finishRun(ctx, run.id, {
      result: "success",
      // undefined のキーは重ねない（null のまま残る）
      usage: { input: 100, output: 20, cache_read: undefined, estimated: true },
      now: new Date(),
    });
    expect(done.usage).toEqual({
      input: 100,
      output: 20,
      cache_read: null,
      cache_write: null,
      estimated: true,
    });
  });

  it("集計のコミットの後、実行中の記録を消す前に止まっても、start・finish・list がその記録を消して進める", async () => {
    const ctx = await prepared();
    // 止まった finish の残りを作る：集計を書いた後に、実行中の記録を戻す
    const leftover = async (): Promise<{ run: Run; file: string }> => {
      const run = await start(ctx, "t1");
      const file = path.join(ctx.repo.localDir, "runs", `${run.id}.json`);
      const text = await readFile(file, "utf8");
      await runCommand(runFinish, ctx, { run: run.id, result: "success" });
      await writeFile(file, text);
      return { run, file };
    };

    // start：同じチケットと step でも拒否せず、残りを消して始める
    const a = await leftover();
    const next = await start(ctx, "t1");
    expect(next.id).not.toBe(a.run.id);
    expect(await exists(a.file)).toBe(false);
    await runCommand(runFinish, ctx, { run: next.id, result: "success" });

    // finish：終わっていると拒否し、残りは消す
    const b = await leftover();
    await expect(
      runCommand(runFinish, ctx, { run: b.run.id, result: "interrupted" }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(await exists(b.file)).toBe(false);

    // list：実行中として出さず、残りを消す
    const c = await leftover();
    const listed = (await runCommand(runList, ctx, { running: true })).data as RunView[];
    expect(listed).toEqual([]);
    expect(await exists(c.file)).toBe(false);
    const all = (await runCommand(runList, ctx, {})).data as RunView[];
    expect(all.filter((r) => r.id === c.run.id)).toMatchObject([{ running: false }]);
  });

  it("step と agent は空白・改行を含まない 1 語でなければ使い方の誤り", async () => {
    const ctx = await prepared();
    for (const input of [
      { ticket: "t1", step: "imple ment", agent: "claude-code" },
      { ticket: "t1", step: "implement\nreview", agent: "claude-code" },
      { ticket: "t1", step: "implement", agent: "" },
      { ticket: "t1", step: "implement", agent: "claude code" },
    ]) {
      await expect(runCommand(runStart, ctx, input)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("CLI・MCP・HTTP が写す一覧に run.start・run.finish・run.list がある", () => {
    for (const name of ["run.start", "run.finish", "run.list"]) {
      expect(findCommand(name)?.needs).toBe("store");
    }
  });
});
