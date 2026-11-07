import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { slowLock } from "../../test/helpers/slow-lock.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { findCommand } from "./registry.js";
import {
  REVIEW_UNRECORDED,
  runFinish,
  runList,
  runRefresh,
  runReviewResult,
  runStart,
  type RunRefreshItem,
  type RunView,
} from "./run.js";
import { commit, configSet, init, validate } from "./setup.js";
import { workflowValidate } from "./workflow.js";
import { metricsShow } from "./metrics.js";
import { iterationAdd, iterationCreate } from "./iteration.js";
import { projectCreate } from "./project.js";
import { ticketClaim, ticketCreate, ticketList, type TicketRow } from "./ticket.js";
import { amendRunning, finishRun, peekRunningRuns } from "../run/record.js";
import type { Run } from "../model/run.js";

vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/helpers/slow-lock.js")).withSlowLock(await importOriginal()),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  slowLock.enabled = false;
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
      retry_reasons: [],
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

  it("list は Project（チケットの今の値）で絞れ、実行時間 duration_seconds を返す（実行中は null）", async () => {
    const ctx = await prepared();
    await runCommand(projectCreate, ctx, { id: "other" });
    await runCommand(ticketCreate, ctx, { title: "C", project: "other" });
    const t1 = await start(ctx, "t1");
    const t3 = await start(ctx, "t3");
    await finishRun(ctx, t1.id, {
      result: "success",
      now: new Date(Date.parse(t1.started_at) + 90_000),
    });
    const listed = async (input: Record<string, unknown>) =>
      (await runCommand(runList, ctx, input)).data as RunView[];
    expect(
      (await listed({ project: "default" })).map((r) => [r.id, r.running, r.duration_seconds]),
    ).toEqual([[t1.id, false, 90]]);
    expect(
      (await listed({ project: "other" })).map((r) => [r.id, r.running, r.duration_seconds]),
    ).toEqual([[t3.id, true, null]]);
    expect(await listed({ project: "nothing" })).toEqual([]);
    // ほかの絞り込みと重ねられる
    expect(await listed({ project: "other", ticket: "t1" })).toEqual([]);
    expect((await listed({ project: "default", running: true })).map((r) => r.id)).toEqual([]);
  });

  it("list は Iteration（チケットの今の値）で絞れ、番号だけの指定も読む", async () => {
    const ctx = await prepared();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    const t1 = await start(ctx, "t1");
    await start(ctx, "t2");
    const listed = async (input: Record<string, unknown>) =>
      ((await runCommand(runList, ctx, input)).data as RunView[]).map((r) => r.id);
    expect(await listed({ iteration: "s1" })).toEqual([t1.id]);
    expect(await listed({ iteration: "1" })).toEqual([t1.id]);
    // 今ない Iteration はエラーにせず空で返す（ticket.list の --iteration・--epic と同じ）
    expect(await listed({ iteration: "s9" })).toEqual([]);
    expect(
      ((await runCommand(ticketList, ctx, { iteration: "s9" })).data as unknown[]).length,
    ).toBe(0);
    expect(((await runCommand(ticketList, ctx, { epic: "e9" })).data as unknown[]).length).toBe(0);
    await expect(runCommand(runList, ctx, { iteration: "x" })).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("並行して start しても、同じチケットと step の Run は 1 つしか始まらない", async () => {
    const ctx = await prepared();
    // ロックの取得を遅らせ、解放の直後に別の待ち手が取り直す競合を起こしやすくする。
    // 同じロックを取る list を混ぜ、最初の start がロックを取る前にも解放が起きるようにする。
    // 窓は乱数の待ちで開くので、閉じては始め直して何回か繰り返す
    for (let round = 0; round < 4; round++) {
      slowLock.enabled = true;
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => [runCommand(runList, ctx, {}), start(ctx, "t1")]).flat(),
      );
      slowLock.enabled = false;
      const started = results.flatMap((r) =>
        r.status === "fulfilled" && (r.value as Run).ticket === "t1" ? [r.value as Run] : [],
      );
      expect(started).toHaveLength(1);
      expect(await readdir(path.join(ctx.repo.localDir, "runs"))).toHaveLength(1);
      await runCommand(runFinish, ctx, { run: started[0]!.id, result: "failure", error: "テスト" });
    }
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
    // 閉じた Run への finish は記録を変えずに警告して返す（RN-4・RN-6）。知らない Run は見つからない
    const head = (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const again = await runCommand(runFinish, ctx, { run: a.id, result: "success" });
    expect(again.data).toMatchObject({ result: "interrupted", error: "セッションが切れた" });
    expect(again.warnings).toEqual([
      expect.stringMatching(/^Run .* は既に interrupted で閉じている/),
    ]);
    expect((await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
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

  it("finish はリトライの理由を retry_reasons に残し、回数を省けば理由の数を回数にする", async () => {
    const ctx = await prepared();
    const reasons = ["型の検査が落ちた", "見直しで境界の扱いを指摘された"];
    const first = await start(ctx, "t1");
    const r = await runCommand(runFinish, ctx, {
      run: first.id,
      result: "success",
      retry_reasons: reasons,
    });
    expect(r.data).toMatchObject({ retries: 2, retry_reasons: reasons });
    await runCommand(commit, ctx, {});
    const saved = JSON.parse(
      await readFile(path.join(ctx.repo.dataDir, "runs", `${first.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({ retries: 2, retry_reasons: reasons });

    // 理由を渡さなければ空の配列。回数だけも受ける
    const second = await start(ctx, "t2");
    const plain = await runCommand(runFinish, ctx, {
      run: second.id,
      result: "success",
      retries: 1,
    });
    expect(plain.data).toMatchObject({ retries: 1, retry_reasons: [] });
  });

  it("finish は空の理由の配列を省いたのと同じに扱い、回数だけを記録する", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1");
    const r = await runCommand(runFinish, ctx, {
      run: run.id,
      result: "success",
      retries: 1,
      retry_reasons: [],
    });
    expect(r.data).toMatchObject({ retries: 1, retry_reasons: [] });
  });

  it("retry_reasons と session のない古い実行中の記録も finish で閉じられ、空の配列と null で記録する", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1");
    const localFile = path.join(ctx.repo.localDir, "runs", `${run.id}.json`);
    const {
      retry_reasons: _reasons,
      session: _session,
      ...old
    } = JSON.parse(await readFile(localFile, "utf8")) as Record<string, unknown>;
    await writeFile(localFile, `${JSON.stringify(old, null, 2)}\n`);
    const listed = (await runCommand(runList, ctx, { running: true })).data as RunView[];
    expect(listed[0]).toMatchObject({ id: run.id, retry_reasons: [], session: null });
    const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    expect(r.data).toMatchObject({ retries: 0, retry_reasons: [], session: null });
    await runCommand(commit, ctx, {});
    const saved = JSON.parse(
      await readFile(path.join(ctx.repo.dataDir, "runs", `${run.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(saved["retry_reasons"]).toEqual([]);
    expect(saved["session"]).toBeNull();
  });

  it("start は transcript を agent の会話記録の置き場所の下だけ受け付け、外のパス（相対パスを含む）は拒否する", async () => {
    const ctx = await prepared();
    const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    ctx.env = { HOME: home };
    const inside = path.join(home, ".claude", "projects", "d", "s1", "subagents", "agent-a.jsonl");
    const run = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "implement",
        agent: "claude-code",
        transcript: inside,
      })
    ).data as Run;
    const local = JSON.parse(
      await readFile(path.join(ctx.repo.localDir, "transcripts", `${run.id}.json`), "utf8"),
    ) as { path: string };
    expect(local.path).toBe(inside);
    for (const outside of [
      "rel/agent-a.jsonl",
      path.join(home, ".ssh", "id_rsa"),
      path.join(home, ".claude", "projects"),
    ]) {
      await expect(
        runCommand(runStart, ctx, {
          ticket: "t2",
          step: "implement",
          agent: "claude-code",
          transcript: outside,
        }),
      ).rejects.toThrow(/会話記録の置き場所の下/);
    }
  });

  it("start と claim は、session と transcript を省けばフックが環境に入れた DEGUBOARD_SESSION・DEGUBOARD_TRANSCRIPT を使う", async () => {
    const ctx = await prepared();
    const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const parent = path.join(home, ".claude", "projects", "d", "s1.jsonl");
    ctx.env = { HOME: home, DEGUBOARD_SESSION: "s1", DEGUBOARD_TRANSCRIPT: parent };
    const run = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "implement", agent: "claude-code" })
    ).data as Run;
    expect(run.session).toBe("s1");
    const local = JSON.parse(
      await readFile(path.join(ctx.repo.localDir, "transcripts", `${run.id}.json`), "utf8"),
    ) as { path: string };
    expect(local.path).toBe(parent);
    // 明示した値が先
    const other = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "implement",
        agent: "claude-code",
        session: "s2",
      })
    ).data as Run;
    expect(other.session).toBe("s2");
  });

  it("finish は回数と理由の数が食い違うか、理由が 1 行でなければ拒否し、Run を開けたままにする", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1");
    await expect(
      runCommand(runFinish, ctx, {
        run: run.id,
        result: "success",
        retries: 1,
        retry_reasons: ["検査が落ちた", "見直しの指摘"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/食い違う/) });
    await expect(
      runCommand(runFinish, ctx, {
        run: run.id,
        result: "success",
        retry_reasons: ["1 行目\n2 行目"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(runFinish, ctx, { run: run.id, result: "success", retry_reasons: ["  "] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const running = (await runCommand(runList, ctx, { running: true })).data as RunView[];
    expect(running.map((r) => r.id)).toEqual([run.id]);
    // 数が合えば閉じられる
    const r = await runCommand(runFinish, ctx, {
      run: run.id,
      result: "failure",
      retries: 1,
      retry_reasons: ["検査が落ちた"],
    });
    expect(r.data).toMatchObject({ retries: 1, retry_reasons: ["検査が落ちた"] });
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

  it("集計のコミットの後、実行中の記録を消す前に止まっても、start・finish・list がその記録を消して進め、一覧の表示も実行中に数えない", async () => {
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

    // finish：終わっていると警告して集計をそのまま返し、残りは消す
    const b = await leftover();
    const finished = await runCommand(runFinish, ctx, { run: b.run.id, result: "interrupted" });
    expect(finished.data).toMatchObject({ id: b.run.id, result: "success" });
    expect(finished.warnings).toEqual([expect.stringContaining("は既に success で閉じている")]);
    expect(await exists(b.file)).toBe(false);

    // 一覧の表示（ticket.list の run_agent）：readRunningRuns と同じくファイルで確かめて実行中に数えず、ロックを取らないので残りは消さない
    const c = await leftover();
    expect(await peekRunningRuns(ctx.repo)).toEqual([]);
    expect(await exists(c.file)).toBe(true);

    // list：実行中として出さず、残りを消す
    const listed = (await runCommand(runList, ctx, { running: true })).data as RunView[];
    expect(listed).toEqual([]);
    expect(await exists(c.file)).toBe(false);
    const all = (await runCommand(runList, ctx, {})).data as RunView[];
    expect(all.filter((r) => r.id === c.run.id)).toMatchObject([{ running: false }]);
  });

  it("ticket.list の run_agent は実行中の Run の agent、なければ最後の Run の agent、Run がなければ null（RN-1）", async () => {
    const ctx = await prepared();
    // Run の ID は秒までの開始の時刻で並ぶので、呼ぶたびに時計を 1 分進める
    let clock = Date.parse("2026-11-02T00:00:00Z");
    ctx.now = () => new Date((clock += 60_000));
    const agents = async () =>
      ((await runCommand(ticketList, ctx, {})).data as TicketRow[]).map((t) => [t.id, t.run_agent]);
    expect(await agents()).toEqual([
      ["t1", null],
      ["t2", null],
    ]);
    const begin = async (ticket: string, step: string, agent: string) =>
      (await runCommand(runStart, ctx, { ticket, step, agent })).data as Run;
    // t1：終わった Run が 2 つなら後に始めた方
    const a = await begin("t1", "implement", "codex");
    expect(await agents()).toEqual([
      ["t1", "codex"],
      ["t2", null],
    ]);
    await runCommand(runFinish, ctx, { run: a.id, result: "success" });
    const b = await begin("t1", "review", "claude-code");
    await runCommand(runFinish, ctx, { run: b.id, result: "success" });
    // t2：実行中の Run は、後に始めて終わった Run より優先する
    await begin("t2", "implement", "codex");
    const c = await begin("t2", "review", "my-bot");
    await runCommand(runFinish, ctx, { run: c.id, result: "success" });
    expect(await agents()).toEqual([
      ["t1", "claude-code"],
      ["t2", "codex"],
    ]);
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

  it("start は --agent を省くと環境変数から判定した agent で始め、判定できなければ使い方の誤りにする（AG-5）", async () => {
    const ctx = await prepared();
    ctx.env = { CLAUDECODE: "1" };
    const detected = await runCommand(runStart, ctx, { ticket: "t1", step: "implement" });
    expect(detected.data).toMatchObject({ ticket: "t1", agent: "claude-code" });
    // --agent を渡せば判定より先に使う
    const given = await runCommand(runStart, ctx, {
      ticket: "t2",
      step: "implement",
      agent: "my-bot",
    });
    expect(given.data).toMatchObject({ agent: "my-bot" });
    for (const env of [{}, { CLAUDECODE: "1", CODEX_THREAD_ID: "t" }]) {
      ctx.env = env;
      await expect(
        runCommand(runStart, ctx, { ticket: "t1", step: "review" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("--agent"),
      });
    }
    expect(await peekRunningRuns(ctx.repo)).toHaveLength(2);
  });

  it("start は step がチケットの Workflow の steps になければ拒否し、steps のない Workflow ならどの step も受ける（WF-5）", async () => {
    const ctx = await prepared();
    // 既定の general の steps は investigate・implement・review・fix
    await expect(start(ctx, "t1", "deploy")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("investigate・implement・review・fix"),
    });
    await expect(start(ctx, "t1", "investigate")).resolves.toMatchObject({ step: "investigate" });
    // 利用者の既存の YAML（steps なし）は今までどおり任意の step を受ける
    await ctx.store.writeWorkflow({ id: "general", name: "General" });
    await expect(start(ctx, "t1", "deploy")).resolves.toMatchObject({ step: "deploy" });
    // Workflow が読めなければ確かめずに始め、警告する
    ctx.store.workflows.delete("general");
    const r = await runCommand(runStart, ctx, {
      ticket: "t2",
      step: "anything",
      agent: "claude-code",
    });
    expect(r.warnings).toContain(
      "t2 の Workflow が見つからないか読めないので、step anything を確かめていない",
    );
  });

  it("Workflow の steps にない step（記録済みの plan の Run）があっても、validate・workflow.validate・run list・metrics show は警告も失敗も出さない", async () => {
    const ctx = await prepared();
    // plan を持つ旧い定義で plan の Run を記録してから、plan のない定義に直す
    await ctx.store.writeWorkflow({
      id: "general",
      name: "General",
      steps: [
        { id: "plan", label: "Plan" },
        { id: "implement", label: "Implement" },
      ],
    });
    const old = await start(ctx, "t1", "plan");
    await runCommand(runFinish, ctx, { run: old.id, result: "success" });
    await ctx.store.writeWorkflow({
      id: "general",
      name: "General",
      steps: [{ id: "implement", label: "Implement" }],
    });
    const validated = await runCommand(workflowValidate, ctx, { workflow: "general" });
    expect(validated.warnings).toEqual([]);
    const all = await runCommand(validate, ctx, {});
    expect(all.data).toMatchObject({ ok: true, issues: [] });
    expect(all.warnings).toEqual([]);
    const listed = await runCommand(runList, ctx, {});
    expect(listed.warnings).toEqual([]);
    expect((listed.data as RunView[]).map((r) => r.step)).toEqual(["plan"]);
    const metrics = await runCommand(metricsShow, ctx, { ticket: "t1" });
    expect(metrics.warnings).toEqual([]);
  });

  it("読み込み時と workflow.validate が、渡した Action の一覧にない Action（警告）と同じ step の重複（エラー）を指摘する（WF-3）", async () => {
    const ctx = await prepared();
    const writeGeneral = (steps: string[]) =>
      writeFile(
        path.join(ctx.repo.dataDir, "workflows/general.yaml"),
        ["id: general", "name: General", "steps:", ...steps, ""].join("\n"),
      );
    const reopen = () =>
      openContext({
        cwd: ctx.repo.topLevel,
        actor: { kind: "agent", user: "eiki" },
        actions: ["create_branch"],
      });
    const codes = (data: unknown) =>
      (data as { issues: { code: string; severity: string }[] }).issues.map((i) => [
        i.code,
        i.severity,
      ]);

    // 未知の Action は警告で、Workflow は索引に残る（新しい版の dg で足した Action を古い版で読んでも止めない）
    await writeGeneral(["  - { id: implement, actions: [create_branch, deploy] }"]);
    const lenient = await reopen();
    expect(lenient.store.workflows.has("general")).toBe(true);
    const warned = await runCommand(workflowValidate, lenient, { workflow: "general" });
    expect(warned.data).toMatchObject({ ok: true, valid: ["general"] });
    expect(codes(warned.data)).toEqual([["workflow_action_unknown", "warning"]]);
    await expect(start(lenient, "t1")).resolves.toMatchObject({ step: "implement" });

    // 同じ step の重複はエラーで、索引から外れる
    await writeGeneral(["  - { id: implement }", "  - { id: implement }"]);
    const strict = await reopen();
    expect(strict.store.workflows.has("general")).toBe(false);
    const failed = await runCommand(workflowValidate, strict, { workflow: "general" });
    expect(failed.data).toMatchObject({ ok: false, valid: [] });
    expect(codes(failed.data)).toEqual([["workflow_step_duplicate", "error"]]);
  });

  it("CLI・MCP・HTTP が写す一覧に run.start・run.finish・run.review-result・run.list・run.refresh がある", () => {
    for (const name of [
      "run.start",
      "run.finish",
      "run.review-result",
      "run.list",
      "run.refresh",
    ]) {
      expect(findCommand(name)?.needs).toBe("store");
    }
  });
});

describe("run review-result（見直しの結果。ADR-013）", () => {
  /** 文脈の今を seconds 秒だけ先にする */
  const laterBy = (ctx: CommandContext, seconds: number) => {
    ctx.now = () => new Date(Date.now() + seconds * 1000);
  };

  const record = (
    ctx: CommandContext,
    ticket: string,
    heavy: number,
    light: number,
    passed?: boolean,
  ) =>
    runCommand(runReviewResult, ctx, {
      ticket,
      heavy,
      light,
      ...(passed === undefined ? {} : { passed }),
    });

  it("実行中の見直しの Run に結果だけを書き、呼び直せば置き換え、finish の集計に残る", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1", "review");
    await record(ctx, "t1", 2, 1);
    const written = await record(ctx, "1", 0, 3, true);
    expect(written.data).toMatchObject({
      id: run.id,
      review: { heavy: 0, light: 3, passed: true },
    });
    // 実行中の記録に書くので、コミットはしない
    expect(written.write).toBeUndefined();
    const closed = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    expect((closed.data as Run).review).toEqual({ heavy: 0, light: 3, passed: true });
  });

  it("見直し以外の step の Run には書かず、見直しの Run がなければ結果を保留にする（ADR-014）", async () => {
    const ctx = await prepared();
    await start(ctx, "t1", "implement");
    const held = await record(ctx, "t1", 0, 0, true);
    expect(held.data).toMatchObject({ ticket: "t1", pending: true, review: { passed: true } });
    expect(held.warnings).toEqual([expect.stringContaining("保留にした")]);
    const [run] = await peekRunningRuns(ctx.repo);
    expect(run!.review).toBeNull();
  });

  it("実行中のものがなければ閉じた最新の見直しの Run に 1 回だけ書き、結果の記録がなくて failure なら success に直す", async () => {
    const ctx = await prepared();
    const older = await start(ctx, "t1", "review");
    await runCommand(runFinish, ctx, { run: older.id, result: "success" });
    // ID は開始の秒で並ぶので、次の Run は後の秒に始める
    laterBy(ctx, 5);
    const latest = await start(ctx, "t1", "review");
    await runCommand(runFinish, ctx, {
      run: latest.id,
      result: "failure",
      error: REVIEW_UNRECORDED,
    });
    const written = await record(ctx, "t1", 1, 0);
    expect(written.data).toMatchObject({
      id: latest.id,
      result: "success",
      error: null,
      review: { heavy: 1, light: 0, passed: false },
    });
    expect(ctx.store.runs.get(older.id)!.data.review).toBeNull();
    // 閉じた Run の結果は書き換えない（RN-4）
    await expect(record(ctx, "t1", 0, 0, true)).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("閉じた見直しの Run の後に別の Run（手直しなど）が始まっていれば、前の回の見直しなので書かずに保留にする", async () => {
    const ctx = await prepared();
    const review = await start(ctx, "t1", "review");
    await runCommand(runFinish, ctx, {
      run: review.id,
      result: "failure",
      error: REVIEW_UNRECORDED,
    });
    laterBy(ctx, 5);
    await start(ctx, "t1", "fix");
    expect((await record(ctx, "t1", 0, 0, true)).data).toMatchObject({ pending: true });
    expect(ctx.store.runs.get(review.id)!.data).toMatchObject({ result: "failure", review: null });
  });

  it("実行中の記録を読んだ後に閉じられていたら（集計がある）、実行中の記録に書かず閉じた Run に書く", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1", "review");
    const localFile = path.join(ctx.repo.localDir, "runs", `${run.id}.json`);
    const kept = await readFile(localFile, "utf8");
    await runCommand(runFinish, ctx, { run: run.id, result: "failure", error: REVIEW_UNRECORDED });
    // 集計を書いた後、実行中の記録を消す前の形にする
    await writeFile(localFile, kept);
    const written = await record(ctx, "t1", 0, 1, true);
    expect(written.data).toMatchObject({ id: run.id, result: "success", review: { light: 1 } });
    expect(ctx.store.runs.get(run.id)!.data.review).toEqual({ heavy: 0, light: 1, passed: true });
  });

  it("finish の decide は、ロックの中で読み直した記録から結果を決める（読んだ後に書かれた見直しの結果を落とさない）", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1", "review");
    // 閉じる側が古い記録（結果なし）で failure と決めた後に、結果が書かれる
    await amendRunning(ctx.repo, run.id, { review: { heavy: 0, light: 0, passed: true } });
    const { run: closed } = await finishRun(ctx, run.id, {
      result: "failure",
      error: REVIEW_UNRECORDED,
      decide: (local) =>
        local.review !== null
          ? { result: "success" }
          : { result: "failure", error: REVIEW_UNRECORDED },
      now: new Date(),
    });
    expect(closed).toMatchObject({ result: "success", error: null, review: { passed: true } });
  });

  it("amendRunning は集計のある Run（閉じた後に実行中の記録が残ったもの）に書かず REJECTED", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1", "review");
    const localFile = path.join(ctx.repo.localDir, "runs", `${run.id}.json`);
    const kept = await readFile(localFile, "utf8");
    await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    await writeFile(localFile, kept);
    await expect(
      amendRunning(ctx.repo, run.id, { review: { heavy: 0, light: 0, passed: true } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("閉じた見直しの Run が別の理由で failure なら、結果を書いても failure のまま", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1", "review");
    await runCommand(runFinish, ctx, { run: run.id, result: "failure", error: "落ちた" });
    const written = await record(ctx, "t1", 0, 0, true);
    expect(written.data).toMatchObject({
      result: "failure",
      error: "落ちた",
      review: { passed: true },
    });
  });

  it("重い指摘があるのに --passed なら使い方の誤りで、何も書かない", async () => {
    const ctx = await prepared();
    await start(ctx, "t1", "review");
    await expect(record(ctx, "t1", 1, 0, true)).rejects.toMatchObject({ name: "UsageError" });
    expect((await peekRunningRuns(ctx.repo))[0]!.review).toBeNull();
  });

  it("run list と metrics show に見直しの結果が出る", async () => {
    const ctx = await prepared();
    let n = 0;
    for (const [heavy, passed] of [
      [2, false],
      [0, true],
    ] as const) {
      laterBy(ctx, 5 * ++n);
      const run = await start(ctx, "t1", "review");
      await record(ctx, "t1", heavy, 1, passed);
      await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    }
    laterBy(ctx, 15);
    const impl = await start(ctx, "t1", "implement");
    await runCommand(runFinish, ctx, { run: impl.id, result: "success" });
    const listed = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(listed.map((r) => r.review)).toEqual([
      { heavy: 2, light: 1, passed: false },
      { heavy: 0, light: 1, passed: true },
      null,
    ]);
    const shown = await runCommand(metricsShow, ctx, { ticket: "t1", by: "step" });
    const view = shown.data as {
      total: { reviews: unknown };
      groups: Array<{ key: string; reviews: unknown }>;
    };
    expect(view.total.reviews).toEqual({ recorded: 2, passed: 1, heavy: 2, light: 2 });
    expect(view.groups.find((g) => g.key === "implement")!.reviews).toEqual({
      recorded: 0,
      passed: 0,
      heavy: 0,
      light: 0,
    });
  });
});

describe("run finish の使用量の取り込み（MT-1・MT-2・MT-4）", () => {
  /** read_transcripts を決めてコミットごとに push する文脈。HOME は一時ディレクトリにして本物の ~/.claude を読まない */
  async function withTranscripts(read: boolean, env: Record<string, string> = {}) {
    const ctx = await prepared();
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    await runCommand(configSet, ctx, { key: "metrics.read_transcripts", value: String(read) });
    await runCommand(commit, ctx, {});
    ctx.config = ctx.store.config;
    const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    ctx.env = { HOME: home, ...env };
    // 会話記録の置き場所の名前は作業ツリーのパスの英数字以外を - にしたもの（agents の Adapter が正本）
    const name = ctx.repo.topLevel.replace(/[^A-Za-z0-9]/g, "-");
    const projectDir = path.join(home, ".claude", "projects", name);
    return { ctx, home, projectDir };
  }

  /** 会話の中身・コマンド・リポジトリの外のパスを含む偽の会話記録（Run の期間内） */
  async function transcript(projectDir: string, run: Run): Promise<void> {
    const t = (ms: number) => new Date(Date.parse(run.started_at) + ms).toISOString();
    const usage = (n: number) => ({
      input_tokens: n,
      output_tokens: n * 2,
      cache_read_input_tokens: n * 100,
      cache_creation_input_tokens: n * 10,
    });
    const lines = [
      { type: "user", timestamp: t(0), message: { content: `秘密のプロンプト ${run.id}` } },
      {
        type: "assistant",
        timestamp: t(100),
        cwd: "/home/someone/secret-project",
        message: {
          id: "m1",
          model: "model-from-transcript",
          content: [
            { type: "tool_use", id: "u1", name: "Grep", input: { pattern: "secret-command" } },
            {
              type: "tool_use",
              id: "u2",
              name: "Edit",
              input: { file_path: "/etc/secret-command" },
            },
            {
              type: "tool_use",
              id: "u3",
              name: "Read",
              input: { file_path: "/etc/secret-command" },
            },
            {
              type: "tool_use",
              id: "u4",
              name: "Bash",
              input: { command: "cat /etc/secret-command" },
            },
          ],
          usage: usage(3),
        },
      },
      {
        type: "assistant",
        timestamp: t(200),
        message: { id: "m2", model: "model-from-transcript", content: "答え", usage: usage(4) },
      },
    ];
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "session.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
  }

  /** transcript の tool_use の回数。Grep・Edit・Read・Bash の順なので、書くまでは探す 1 回だけ */
  const TOOLS = {
    read: 1,
    search: 1,
    write: 1,
    bash: 1,
    other: 0,
    read_before_write: 0,
    search_before_write: 1,
  };

  it("Claude Code の Run は会話記録から input・output・cache_read・cache_write とモデル名とツールの回数が埋まる", async () => {
    const { ctx, projectDir } = await withTranscripts(true);
    const run = await start(ctx, "t1");
    await transcript(projectDir, run);
    const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    expect(r.warnings).toEqual([]);
    expect(r.data).toMatchObject({
      model: "model-from-transcript",
      usage: { input: 7, output: 14, cache_read: 700, cache_write: 70 },
      tools: TOOLS,
    });
  });

  it("start は Adapter のない agent 名でも記録し、使用量とモデル名を取り込めないと警告する。Adapter のある名前では警告しない", async () => {
    const { ctx } = await withTranscripts(true, {});
    const ok1 = await runCommand(runStart, ctx, {
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
    });
    expect(ok1.warnings).toEqual([]);
    const r = await runCommand(runStart, ctx, {
      ticket: "t1",
      step: "review",
      agent: "no-such-reviewer",
    });
    expect((r.data as Run).agent).toBe("no-such-reviewer");
    expect(r.warnings).toEqual([
      expect.stringMatching(/no-such-reviewer.*Adapter がない.*claude-code/),
    ]);
  });

  it("start はこのマシンで同じ agent の Run が開いたままなら警告して記録し、finish は重なった応答を後に始めた Run にだけ数える", async () => {
    const { ctx, projectDir } = await withTranscripts(true, {});
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    const t = (minutes: number) => new Date(t0 + minutes * 60_000);
    ctx.now = () => t(0);
    const a = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "implement", agent: "claude-code" })
    ).data as Run;
    ctx.now = () => t(10);
    const other = await runCommand(runStart, ctx, { ticket: "t2", step: "review", agent: "codex" });
    expect(other.warnings).toEqual([]);
    const started = await runCommand(runStart, ctx, {
      ticket: "t2",
      step: "implement",
      agent: "claude-code",
    });
    const b = started.data as Run;
    expect(started.warnings).toEqual([
      expect.stringMatching(new RegExp(`claude-code の Run ${a.id}（t1 implement）が開いたまま`)),
    ]);
    const reply = (id: string, minutes: number, output: number) => ({
      type: "assistant",
      timestamp: t(minutes).toISOString(),
      message: {
        id,
        model: "m",
        content: "答え",
        usage: { input_tokens: 0, output_tokens: output },
      },
    });
    const mention = (id: string, minutes: number) => ({
      type: "user",
      timestamp: t(minutes).toISOString(),
      message: { content: id },
    });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "s1.jsonl"),
      [mention(a.id, 0), reply("m1", 1, 1), mention(b.id, 10), reply("m2", 12, 10)]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    ctx.now = () => t(20);
    const fa = await runCommand(runFinish, ctx, { run: a.id, result: "success" });
    ctx.now = () => t(30);
    const fb = await runCommand(runFinish, ctx, { run: b.id, result: "success" });
    expect((fa.data as Run).usage.output).toBe(1);
    expect((fb.data as Run).usage.output).toBe(10);
  });

  it("read_transcripts が false か DEGUBOARD_NO_TRANSCRIPTS=1 なら会話記録を読まず、null にして警告する", async () => {
    for (const [read, env] of [
      [false, {}],
      [true, { DEGUBOARD_NO_TRANSCRIPTS: "1" }],
    ] as const) {
      const { ctx, projectDir } = await withTranscripts(read, env);
      const run = await start(ctx, "t1");
      await transcript(projectDir, run);
      const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
      expect((r.data as Run).usage).toEqual({
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
      });
      expect((r.data as Run).model).toBeNull();
      expect((r.data as Run).tools).toBeNull();
      expect(r.warnings).toEqual([expect.stringMatching(/会話記録を読まない/)]);
    }
  });

  it("Git に入る記録は数とモデル名だけで、会話の中身・コマンド・リポジトリの外のパスを写さない（MT-4）", async () => {
    const { ctx, home, projectDir } = await withTranscripts(true);
    const run = await start(ctx, "t1");
    await transcript(projectDir, run);
    await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    const committed = (await git(ctx.repo.dataDir, ["show", "--format=", "HEAD"])).stdout;
    for (const text of [
      "秘密のプロンプト",
      "答え",
      "secret-command",
      "secret-project",
      "/etc/",
      home,
      ctx.repo.topLevel,
      os.homedir(),
      ".jsonl",
    ]) {
      expect(committed).not.toContain(text);
    }
    const saved = JSON.parse(
      await readFile(path.join(ctx.repo.dataDir, "runs", `${run.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(
      [
        "id",
        "ticket",
        "step",
        "agent",
        "model",
        "started_at",
        "finished_at",
        "result",
        "error",
        "retries",
        "retry_reasons",
        "usage",
        "tools",
        "session",
        "review",
      ].sort(),
    );
    expect(saved["usage"]).toEqual({ input: 7, output: 14, cache_read: 700, cache_write: 70 });
    expect(saved["tools"]).toEqual(TOOLS);
    expect(saved["session"]).toBeNull();
  });

  describe("会話記録の場所（ADR-005）", () => {
    /** Run の ID を含まないサブエージェントの会話記録（見直しを終えた後に run start した見直し役など）。期間の応答 2 つ */
    async function subagentTranscript(projectDir: string, run: Run, n: number): Promise<string> {
      const t = (ms: number) => new Date(Date.parse(run.started_at) + ms).toISOString();
      const file = path.join(projectDir, "s1", "subagents", "agent-a.jsonl");
      const line = (id: string, ms: number) => ({
        type: "assistant",
        timestamp: t(ms),
        message: {
          id,
          model: "model-from-transcript",
          content: "答え",
          usage: {
            input_tokens: n,
            output_tokens: n,
            cache_read_input_tokens: n,
            cache_creation_input_tokens: n,
          },
        },
      });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        [line("m1", -500), line("m2", 100)].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      return file;
    }

    it("start は session を Run に、transcript をこのマシンの deguboard-local/transcripts/ に置き、finish はそのファイルの先頭から数えて Git にはパスを入れない", async () => {
      const { ctx, home, projectDir } = await withTranscripts(true);
      const file = path.join(projectDir, "s1", "subagents", "agent-a.jsonl");
      const run = (
        await runCommand(runStart, ctx, {
          ticket: "t1",
          step: "review",
          agent: "claude-code",
          session: "s1",
          transcript: file,
        })
      ).data as Run;
      expect(run.session).toBe("s1");
      await subagentTranscript(projectDir, run, 5);
      const local = JSON.parse(
        await readFile(path.join(ctx.repo.localDir, "transcripts", `${run.id}.json`), "utf8"),
      ) as unknown;
      expect(local).toEqual({ path: file });
      const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
      // ID の出ていない記録でも、場所のファイルの先頭から数える（開始の前の応答も入る）
      expect(r.data).toMatchObject({ session: "s1", usage: { input: 10, output: 10 } });
      const committed = (await git(ctx.repo.dataDir, ["show", "--format=", "HEAD"])).stdout;
      for (const text of [home, ".jsonl", "subagents", "transcripts"]) {
        expect(committed).not.toContain(text);
      }
      // 閉じても場所は残し、refresh も同じファイルから数える
      await subagentTranscript(projectDir, run, 7);
      const refreshed = await runCommand(runRefresh, ctx, { runs: [run.id], dry_run: true });
      expect((refreshed.data as RunRefreshItem[])[0]!.changes).toContainEqual({
        field: "usage.input",
        from: 10,
        to: 14,
      });
    });

    it("場所のファイルがこのマシンで読めなければ、推測に落とさず使用量を null にして警告する", async () => {
      const { ctx, projectDir } = await withTranscripts(true);
      const run = (
        await runCommand(runStart, ctx, {
          ticket: "t1",
          step: "implement",
          agent: "claude-code",
          transcript: path.join(projectDir, "gone", "subagents", "agent-x.jsonl"),
        })
      ).data as Run;
      // 推測なら見つかる記録（ID を含む）があっても使わない
      await transcript(projectDir, run);
      const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
      expect(r.data).toMatchObject({ usage: { input: null, output: null } });
      expect(r.warnings).toEqual([expect.stringContaining("読めない")]);
    });

    it("agent の claim は session と transcript を開く Run に渡し、人の claim と no_run では使い方の誤りにする", async () => {
      const { ctx, projectDir } = await withTranscripts(true);
      const file = path.join(projectDir, "s1.jsonl");
      const claimed = await runCommand(ticketClaim, ctx, {
        ticket: "t1",
        agent: "claude-code",
        session: "s1",
        transcript: file,
      });
      const id = (claimed.data as { run: string }).run;
      const running = (await runCommand(runList, ctx, { running: true })).data as RunView[];
      expect(running.find((r) => r.id === id)?.session).toBe("s1");
      await expect(
        runCommand(ticketClaim, ctx, { ticket: "t2", no_run: true, session: "s1" }),
      ).rejects.toThrow(/session と transcript/);
      const human = { ...ctx, actor: { ...ctx.actor, kind: "human" as const } };
      await expect(
        runCommand(ticketClaim, human, { ticket: "t2", transcript: file }),
      ).rejects.toThrow(/session と transcript/);
    });
  });
});

describe("deguboard-local/runs/ の壊れた記録", () => {
  /** 読めない実行中の記録を置く。JSON でないもの・スキーマに合わないもの・ファイル名と中の id が違うもの */
  async function broken(ctx: CommandContext) {
    const dir = path.join(ctx.repo.localDir, "runs");
    await mkdir(dir, { recursive: true });
    const files = {
      json: "r20261101-000000-0001",
      schema: "r20261101-000000-0002",
      mismatch: "r20261101-000000-0003",
    };
    await writeFile(path.join(dir, `${files.json}.json`), "{ 壊れた");
    await writeFile(
      path.join(dir, `${files.schema}.json`),
      JSON.stringify({ id: files.schema, ticket: "t1", step: "implement" }),
    );
    const valid = await start(ctx, "t2", "review");
    const text = (await readFile(path.join(dir, `${valid.id}.json`), "utf8")).replace(
      valid.id,
      "r20261101-999999-9999",
    );
    await runCommand(runFinish, ctx, { run: valid.id, result: "interrupted" });
    await writeFile(path.join(dir, `${files.mismatch}.json`), text);
    // Run の ID の形でないファイルは記録として読まない
    await writeFile(path.join(dir, "notes.txt"), "メモ");
    return { dir, files };
  }

  it("list は読めない記録を飛ばして警告に出し、記録は消さない", async () => {
    const ctx = await prepared();
    const { dir, files } = await broken(ctx);
    const running = await start(ctx, "t1");
    const r = await runCommand(runList, ctx, {});
    expect((r.data as RunView[]).filter((v) => v.running).map((v) => v.id)).toEqual([running.id]);
    expect(r.warnings).toEqual([
      `deguboard-local/runs/${files.json}.json: JSON を読めない`,
      `deguboard-local/runs/${files.schema}.json: スキーマに合わない`,
      `deguboard-local/runs/${files.mismatch}.json: ファイル名の ID ${files.mismatch} と中の id r20261101-999999-9999 が違う`,
    ]);
    for (const id of Object.values(files))
      expect(await exists(path.join(dir, `${id}.json`))).toBe(true);
  });

  it("start は読めない記録があっても止まらず、同じチケットと step でも始められる", async () => {
    const ctx = await prepared();
    const { dir, files } = await broken(ctx);
    // スキーマに合わない記録は t1 の implement を名乗るが、読めないので重複とはみなさない
    const r = await runCommand(runStart, ctx, {
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
    });
    expect(r.data).toMatchObject({ ticket: "t1", step: "implement", result: null });
    expect(r.warnings).toEqual([]);
    for (const id of Object.values(files))
      expect(await exists(path.join(dir, `${id}.json`))).toBe(true);
  });

  it("finish は読めない記録を VALIDATION_FAILED で拒否し、記録も runs/ も書き換えない", async () => {
    const ctx = await prepared();
    const { dir, files } = await broken(ctx);
    for (const id of Object.values(files)) {
      const before = await readFile(path.join(dir, `${id}.json`), "utf8");
      await expect(
        runCommand(runFinish, ctx, { run: id, result: "interrupted" }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining(`実行中の Run ${id} の記録を読めない`),
      });
      expect(await readFile(path.join(dir, `${id}.json`), "utf8")).toBe(before);
      expect(await exists(path.join(ctx.repo.dataDir, "runs", `${id}.json`))).toBe(false);
    }
  });
});

describe("run finish のモデル名と finished_at", () => {
  /** 会話記録（モデル名 model-from-transcript）を読める文脈 */
  async function withModelTranscript() {
    const ctx = await prepared();
    await runCommand(configSet, ctx, { key: "metrics.read_transcripts", value: "true" });
    await runCommand(commit, ctx, {});
    ctx.config = ctx.store.config;
    const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    ctx.env = { HOME: home };
    const projectDir = path.join(
      home,
      ".claude",
      "projects",
      ctx.repo.topLevel.replace(/[^A-Za-z0-9]/g, "-"),
    );
    const startWith = async (ticket: string, model?: string) => {
      const run = (
        await runCommand(runStart, ctx, {
          ticket,
          step: "implement",
          agent: "claude-code",
          ...(model ? { model } : {}),
        })
      ).data as Run;
      const at = new Date(Date.parse(run.started_at) + 100).toISOString();
      const line = {
        type: "assistant",
        timestamp: at,
        message: {
          id: `m-${run.id}`,
          model: "model-from-transcript",
          content: "答え",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      // 数えるのは Run の ID が出た後の行
      const intro = { type: "user", timestamp: run.started_at, message: { content: run.id } };
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, `${run.id}.jsonl`),
        [intro, line].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      return run;
    };
    return { ctx, startWith };
  }

  it("モデル名は会話記録の名前 > finish で明示した名前 > start の記録の名前の順に採る", async () => {
    const { ctx, startWith } = await withModelTranscript();
    const finish = async (run: Run, model?: string) =>
      (
        await runCommand(runFinish, ctx, {
          run: run.id,
          result: "success",
          ...(model ? { model } : {}),
        })
      ).data as Run;

    // 会話記録から取れれば、start・finish の別名より先
    expect((await finish(await startWith("t1", "sonnet"), "opus")).model).toBe(
      "model-from-transcript",
    );
    expect((await finish(await startWith("t1", "sonnet"))).model).toBe("model-from-transcript");
    expect((await finish(await startWith("t2"))).model).toBe("model-from-transcript");
  });

  it("会話記録からモデル名が取れないときは、finish で明示した名前 > start の記録の名前を使う", async () => {
    const ctx = await prepared();
    const finish = async (ticket: string, startModel?: string, model?: string) => {
      const run = (
        await runCommand(runStart, ctx, {
          ticket,
          step: "implement",
          agent: "claude-code",
          ...(startModel ? { model: startModel } : {}),
        })
      ).data as Run;
      return (
        await runCommand(runFinish, ctx, {
          run: run.id,
          result: "success",
          ...(model ? { model } : {}),
        })
      ).data as Run;
    };
    expect((await finish("t1", "model-at-start", "model-explicit")).model).toBe("model-explicit");
    expect((await finish("t1", "model-at-start")).model).toBe("model-at-start");
    expect((await finish("t2", undefined, "model-explicit")).model).toBe("model-explicit");
  });

  it("finish の時刻が start より前（時計のずれ）なら finished_at を started_at に揃え、実行時間は 0 になる", async () => {
    const ctx = await prepared();
    const run = await start(ctx, "t1");
    ctx.now = () => new Date(Date.parse(run.started_at) - 60_000);
    const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    expect((r.data as Run).finished_at).toBe(run.started_at);
    const listed = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(listed.map((v) => [v.id, v.duration_seconds])).toEqual([[run.id, 0]]);

    // 遅れていなければ finish の時刻のまま
    const later = await start(ctx, "t2");
    const at = new Date(Date.parse(later.started_at) + 30_000);
    ctx.now = () => at;
    const done = await runCommand(runFinish, ctx, { run: later.id, result: "success" });
    expect((done.data as Run).finished_at).toBe(at.toISOString().replace(/\.\d{3}Z$/, "Z"));
  });
});

describe("run refresh の取り直し（RN-4・MT-5）", () => {
  /** 会話記録を読める・コミットごとに push する文脈。会話記録は finish の後に置き、閉じた Run を取り直す */
  async function closedRuns() {
    const ctx = await prepared();
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    await runCommand(configSet, ctx, { key: "metrics.read_transcripts", value: "true" });
    await runCommand(commit, ctx, {});
    ctx.config = ctx.store.config;
    const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    ctx.env = { HOME: home };
    const projectDir = path.join(
      home,
      ".claude",
      "projects",
      ctx.repo.topLevel.replace(/[^A-Za-z0-9]/g, "-"),
    );
    /** Run の期間の応答 1 つを持つ会話記録。usage のキーを省けばその値は取れない */
    const transcriptFor = async (run: Run, usage: Record<string, number>) => {
      const intro = { type: "user", timestamp: run.started_at, message: { content: run.id } };
      const line = {
        type: "assistant",
        timestamp: new Date(Date.parse(run.started_at) + 100).toISOString(),
        message: {
          id: `m-${run.id}`,
          model: "claude-opus-from-transcript",
          content: "答え",
          usage,
        },
      };
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, `${run.id}.jsonl`),
        [intro, line].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
    };
    /** 会話記録のないまま閉じた Run（使用量は null、モデル名は start の別名） */
    const closedRun = async (ticket: string, model = "opus") => {
      const run = (
        await runCommand(runStart, ctx, { ticket, step: "implement", agent: "claude-code", model })
      ).data as Run;
      return (await runCommand(runFinish, ctx, { run: run.id, result: "success" })).data as Run;
    };
    const saved = async (id: string) =>
      readFile(path.join(ctx.repo.dataDir, "runs", `${id}.json`), "utf8");
    const head = async () => (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    return { ctx, transcriptFor, closedRun, saved, head };
  }

  const full = {
    input_tokens: 3,
    output_tokens: 4,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 6,
  };

  it("閉じた Run の別名のモデル名と null の使用量を会話記録の値で書き換え、1 回の書き込みでコミットする", async () => {
    const { ctx, transcriptFor, closedRun, saved } = await closedRuns();
    const a = await closedRun("t1");
    const b = await closedRun("t2");
    await transcriptFor(a, full);
    await transcriptFor(b, full);
    const r = await runCommand(runRefresh, ctx, { runs: [a.id, b.id] });
    expect(r.warnings).toEqual([]);
    expect(r.write).toMatchObject({ committed: true, pushed: true });
    const items = r.data as RunRefreshItem[];
    expect(items.map((i) => [i.id, i.updated])).toEqual([
      [a.id, true],
      [b.id, true],
    ]);
    expect(items[0]?.changes).toEqual([
      { field: "model", from: "opus", to: "claude-opus-from-transcript" },
      { field: "usage.input", from: null, to: 3 },
      { field: "usage.output", from: null, to: 4 },
      { field: "usage.cache_read", from: null, to: 50 },
      { field: "usage.cache_write", from: null, to: 6 },
    ]);
    const after = JSON.parse(await saved(a.id)) as Run;
    // 取り直すのはモデル名と使用量だけで、ほかの値は変えない
    expect(after).toEqual({
      ...a,
      // 止まって待っている印は閉じた Run に書かない（ADR-014）
      waiting_since: undefined,
      model: "claude-opus-from-transcript",
      usage: { input: 3, output: 4, cache_read: 50, cache_write: 6 },
    });
    const changed = (
      await git(ctx.repo.dataDir, ["show", "--name-only", "--format=%s", "HEAD"])
    ).stdout.trim();
    expect(changed.split("\n")).toEqual([
      `Run を会話記録から取り直す: ${a.id} ${b.id}`,
      "",
      // git は名前の順に並べる
      ...[`runs/${a.id}.json`, `runs/${b.id}.json`].sort(),
    ]);
    // 同じ値なら差分はなく、書かない
    const again = await runCommand(runRefresh, ctx, { runs: [a.id] });
    expect((again.data as RunRefreshItem[])[0]).toMatchObject({ changes: [], updated: false });
    expect(again.write).toBeUndefined();
  });

  it("--dry-run は書き換える差分を返し、記録もコミットも変えない", async () => {
    const { ctx, transcriptFor, closedRun, saved, head } = await closedRuns();
    const a = await closedRun("t1");
    await transcriptFor(a, full);
    const before = await saved(a.id);
    const sha = await head();
    const r = await runCommand(runRefresh, ctx, { runs: [a.id], dry_run: true });
    expect(r.write).toBeUndefined();
    expect((r.data as RunRefreshItem[])[0]).toMatchObject({
      id: a.id,
      updated: false,
      changes: expect.arrayContaining([
        { field: "model", from: "opus", to: "claude-opus-from-transcript" },
        { field: "usage.cache_read", from: null, to: 50 },
      ]),
    });
    expect(await saved(a.id)).toBe(before);
    expect(await head()).toBe(sha);
  });

  it("取れなかった値は今の値を消さずに残し、値の名前を挙げて警告する", async () => {
    const { ctx, transcriptFor, saved } = await closedRuns();
    // 使用量の一部が記録済みの閉じた Run
    const started = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "implement",
        agent: "claude-code",
        model: "opus",
      })
    ).data as Run;
    await finishRun(ctx, started.id, {
      result: "success",
      usage: { cache_read: 900, cache_write: 90 },
      now: new Date(),
    });
    // 会話記録には cache の値がない
    await transcriptFor(started, { input_tokens: 3, output_tokens: 4 });
    const r = await runCommand(runRefresh, ctx, { runs: [started.id] });
    expect((r.data as RunRefreshItem[])[0]).toMatchObject({
      kept: ["usage.cache_read", "usage.cache_write"],
      updated: true,
    });
    expect(r.warnings).toEqual([
      `Run ${started.id}: usage.cache_read・usage.cache_write は会話記録から取れなかったので今の値を残す`,
    ]);
    expect((JSON.parse(await saved(started.id)) as Run).usage).toEqual({
      input: 3,
      output: 4,
      cache_read: 900,
      cache_write: 90,
    });

    // 会話記録がなければ何も書き換えず、Adapter の理由を「今の値を残す」で 1 回だけ出す
    const lost = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "implement",
        agent: "claude-code",
        model: "opus",
      })
    ).data as Run;
    await runCommand(runFinish, ctx, { run: lost.id, result: "success" });
    const before = await saved(lost.id);
    const none = await runCommand(runRefresh, ctx, { runs: [lost.id] });
    expect(none.write).toBeUndefined();
    expect(none.warnings).toEqual([
      `Run ${lost.id}: Claude Code の会話記録に Run ${lost.id} が見つからない。今の値を残す`,
    ]);
    expect((none.data as RunRefreshItem[])[0]?.kept).toHaveLength(5);
    expect(await saved(lost.id)).toBe(before);
  });

  it("Adapter のない agent の Run も、警告の末尾は「今の値を残す」になる", async () => {
    const { ctx, saved } = await closedRuns();
    const started = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "implement", agent: "no-such-agent" })
    ).data as Run;
    await runCommand(runFinish, ctx, { run: started.id, result: "success" });
    const before = await saved(started.id);
    const r = await runCommand(runRefresh, ctx, { runs: [started.id] });
    expect(r.warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Run ${started.id}: agent no-such-agent の Adapter がない（.*）。今の値を残す$`,
        ),
      ),
    ]);
    expect(await saved(started.id)).toBe(before);
  });

  it("使用量の 4 つをすべて取り直せたら usage.estimated を外し、一部だけなら残す（RN-2）", async () => {
    const { ctx, transcriptFor, saved } = await closedRuns();
    const closeEstimated = async (ticket: string) => {
      const s = (
        await runCommand(runStart, ctx, { ticket, step: "implement", agent: "claude-code" })
      ).data as Run;
      await finishRun(ctx, s.id, {
        result: "success",
        usage: { input: 1, output: 1, cache_read: 1, cache_write: 1, estimated: true },
        now: new Date(),
      });
      return s;
    };
    const a = await closeEstimated("t1");
    await transcriptFor(a, full);
    const r = await runCommand(runRefresh, ctx, { runs: [a.id] });
    expect((r.data as RunRefreshItem[])[0]?.changes).toContainEqual({
      field: "usage.estimated",
      from: true,
      to: null,
    });
    expect((JSON.parse(await saved(a.id)) as Run).usage).toEqual({
      input: 3,
      output: 4,
      cache_read: 50,
      cache_write: 6,
    });

    const b = await closeEstimated("t2");
    await transcriptFor(b, { input_tokens: 3, output_tokens: 4 });
    await runCommand(runRefresh, ctx, { runs: [b.id] });
    expect((JSON.parse(await saved(b.id)) as Run).usage).toMatchObject({
      input: 3,
      cache_read: 1,
      estimated: true,
    });
  });

  it("read_transcripts が false なら会話記録を読まず、今の値を残して警告する（MT-2）", async () => {
    const { ctx, transcriptFor, closedRun, saved } = await closedRuns();
    const a = await closedRun("t1");
    await transcriptFor(a, full);
    await runCommand(configSet, ctx, { key: "metrics.read_transcripts", value: "false" });
    ctx.config = ctx.store.config;
    const before = await saved(a.id);
    const r = await runCommand(runRefresh, ctx, { runs: [a.id] });
    expect(r.warnings[0]).toMatch(/会話記録を読まない。今の値を残す$/);
    expect(await saved(a.id)).toBe(before);
  });

  it("実行中・見つからない・ID の形でない Run は、ほかの Run も書き換えずに拒否する", async () => {
    const { ctx, transcriptFor, closedRun, saved } = await closedRuns();
    const a = await closedRun("t1");
    await transcriptFor(a, full);
    const before = await saved(a.id);
    const running = await start(ctx, "t2");
    await expect(runCommand(runRefresh, ctx, { runs: [a.id, running.id] })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("実行中"),
    });
    await expect(
      runCommand(runRefresh, ctx, { runs: [a.id, "r20261101-000000-0000"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runCommand(runRefresh, ctx, { runs: ["nope"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await saved(a.id)).toBe(before);
  });
});
