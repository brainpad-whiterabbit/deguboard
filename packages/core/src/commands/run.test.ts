import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { slowLock } from "../../test/helpers/slow-lock.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { findCommand } from "./registry.js";
import { runFinish, runList, runStart, type RunView } from "./run.js";
import { commit, configSet, init } from "./setup.js";
import { workflowValidate } from "./workflow.js";
import { projectCreate } from "./project.js";
import { ticketCreate } from "./ticket.js";
import { finishRun } from "../run/record.js";
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

  it("start は step がチケットの Workflow の steps になければ拒否し、steps のない Workflow ならどの step も受ける（WF-5）", async () => {
    const ctx = await prepared();
    // 既定の general の steps は investigate・implement・review
    await expect(start(ctx, "t1", "deploy")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("investigate・implement・review"),
    });
    await expect(start(ctx, "t1", "investigate")).resolves.toMatchObject({ step: "investigate" });
    // 利用者の既存の YAML（steps なし）は今までどおり任意の step を受ける
    await ctx.store.writeWorkflow({ id: "general", name: "General" });
    await expect(start(ctx, "t1", "deploy")).resolves.toMatchObject({ step: "deploy" });
    // Workflow が読めなければ確かめずに始め、警告する
    ctx.store.workflows.delete("general");
    const r = await runCommand(runStart, ctx, { ticket: "t2", step: "anything", agent: "x" });
    expect(r.warnings).toEqual([
      "t2 の Workflow が見つからないか読めないので、step anything を確かめていない",
    ]);
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

  it("CLI・MCP・HTTP が写す一覧に run.start・run.finish・run.list がある", () => {
    for (const name of ["run.start", "run.finish", "run.list"]) {
      expect(findCommand(name)?.needs).toBe("store");
    }
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
          content: [{ type: "tool_use", input: { command: "cat /etc/secret-command" } }],
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

  it("Claude Code の Run は会話記録から input・output・cache_read・cache_write とモデル名が埋まる", async () => {
    const { ctx, projectDir } = await withTranscripts(true);
    const run = await start(ctx, "t1");
    await transcript(projectDir, run);
    const r = await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    expect(r.warnings).toEqual([]);
    expect(r.data).toMatchObject({
      model: "model-from-transcript",
      usage: { input: 7, output: 14, cache_read: 700, cache_write: 70 },
    });
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
        "usage",
      ].sort(),
    );
    expect(saved["usage"]).toEqual({ input: 7, output: 14, cache_read: 700, cache_write: 70 });
  });
});
