import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import type { Run } from "../model/run.js";
import { peekRunningRuns, readTranscriptPaths, startRun } from "../run/record.js";
import { runPath } from "../storage/paths.js";
import { hooksOf } from "../agents/index.js";
import { openContext, openContextFor } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import {
  advancesPrOutsideDg,
  GH_PR_DENIED,
  hook,
  hookTiming,
  parseMarker,
  readHookInput,
  touchesDataDir,
  type HookView,
} from "./hook.js";
import {
  runList,
  runRetryReason,
  runReviewResult,
  runStart,
  STALE_SESSION_ERROR,
  type RunView,
} from "./run.js";
import { commit, configSet, init, sync } from "./setup.js";
import { ticketClaim, ticketCreate, ticketUpdate } from "./ticket.js";
import { runGit } from "../git/run.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  hookTiming.settleMs = 3000;
  hookTiming.pollMs = 100;
  hookTiming.onGiveUp = undefined;
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const SESSION = "s-parent";

/** init してチケット t1・t2 を起票し、会話記録を読む文脈。HOME は一時ディレクトリ */
async function prepared() {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "agent" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  const ctx: CommandContext = await openContext({ cwd: f.cloneA, actor });
  await runCommand(ticketCreate, ctx, { title: "A" });
  await runCommand(ticketCreate, ctx, { title: "B" });
  await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
  await runCommand(configSet, ctx, { key: "metrics.read_transcripts", value: "true" });
  await runCommand(commit, ctx, {});
  ctx.config = ctx.store.config;
  const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  ctx.env = { HOME: home };
  const projectDir = path.join(home, ".claude", "projects", "d");
  const parent = path.join(projectDir, `${SESSION}.jsonl`);
  const subagent = (id: string) => path.join(projectDir, SESSION, "subagents", `agent-${id}.jsonl`);
  return { ctx, home, parent, subagent };
}

const call = async (ctx: CommandContext, event: string, payload: Record<string, unknown>) => {
  const r = await runCommand(hook, ctx, { event, payload });
  return { view: r.data as HookView, warnings: r.warnings };
};

const launched = (parent: string, agentId: string, prompt: string) => ({
  session_id: SESSION,
  transcript_path: parent,
  tool_name: "Agent",
  tool_input: { prompt, description: "x" },
  tool_response: { status: "async_launched", agentId, resolvedModel: "claude-test-1" },
});

/**
 * サブエージェントが Bash で dg を呼んだ記録の 2 行（呼び出しと結果）。output は結果の文（--json の JSON か人向けの出力）。
 * 本物の記録と同じく、結果は tool_use_id で呼び出しに結び付く
 */
let callSeq = 0;
function bashCall(command: string, output: string): unknown[] {
  const id = `toolu_${++callSeq}`;
  return [
    {
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        id: `c${callSeq}`,
        content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
      },
    },
    {
      type: "user",
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] },
    },
  ];
}

/** dg run start --json の結果。警告には開いたままのほかの Run の ID が出る */
const startOutput = (run: Run, others: string[] = []) =>
  JSON.stringify(
    {
      ok: true,
      data: run,
      warnings: others.map((o) => `このマシンで claude-code の Run ${o}（t2 review）が開いたまま`),
    },
    null,
    2,
  );

/** サブエージェントの記録。最初の行が頼んだ文、続けて extra の行と応答 2 つ（開始の前の時刻も含む） */
async function subagentRecord(
  file: string,
  prompt: string,
  tokens: number,
  extra: unknown[] = [],
  tail: unknown[] = [],
) {
  const line = (id: string, ms: number) => ({
    type: "assistant",
    timestamp: new Date(Date.now() + ms).toISOString(),
    message: {
      id,
      model: "claude-test-1",
      content: "答え",
      usage: {
        input_tokens: tokens,
        output_tokens: tokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  const first = { type: "user", timestamp: new Date().toISOString(), message: { content: prompt } };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [first, ...extra, line("m1", -60_000), line("m2", 0), ...tail]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
}

describe("フックの印", () => {
  it("最初の空でない行の deguboard: ticket=<id> step=<step> だけを印と読む", () => {
    expect(parseMarker("\ndeguboard: ticket=t12 step=review\n\n本文")).toEqual({
      ticket: "t12",
      step: "review",
    });
    expect(parseMarker("本文\ndeguboard: ticket=t12 step=review")).toBeUndefined();
    expect(parseMarker("deguboard: ticket=x step=review")).toBeUndefined();
    expect(parseMarker("deguboard: ticket=t1")).toBeUndefined();
  });
});

describe("dg hook（ADR-012）", () => {
  it("SessionStart は以後の Bash の環境に export 付きで主体・セッション ID・記録のパスを書く", async () => {
    const { ctx, home, parent } = await prepared();
    const envFile = path.join(home, "env.sh");
    ctx.env = { ...ctx.env, CLAUDE_ENV_FILE: envFile };
    const { view } = await call(ctx, "SessionStart", {
      session_id: SESSION,
      transcript_path: parent,
      source: "startup",
    });
    expect(view.done).toHaveLength(1);
    expect(await readFile(envFile, "utf8")).toBe(
      [
        "export DEGUBOARD_ACTOR=agent",
        `export DEGUBOARD_SESSION='${SESSION}'`,
        `export DEGUBOARD_TRANSCRIPT='${parent}'`,
        "",
      ].join("\n"),
    );
  });

  it("PostToolUse（Agent）は印のある呼び出しだけ Run を開き、記録の場所をサブエージェントの記録にする。印がなければ何もしない", async () => {
    const { ctx, parent, subagent } = await prepared();
    await call(ctx, "PostToolUse", launched(parent, "a1", "調べもの"));
    expect(await peekRunningRuns(ctx.repo)).toEqual([]);
    const { view } = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a1", "deguboard: ticket=t1 step=review\n\n見直す"),
    );
    expect(view.done).toEqual([expect.stringContaining("t1 の review の Run")]);
    const [run] = await peekRunningRuns(ctx.repo);
    expect(run).toMatchObject({
      ticket: "t1",
      step: "review",
      agent: "claude-code",
      model: "claude-test-1",
      session: SESSION,
    });
    expect((await readTranscriptPaths(ctx.repo)).get(run!.id)).toBe(subagent("a1"));
    // 同じチケットと step の二重起動は開かずに警告する（フックは失敗にしない）
    const again = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a2", "deguboard: ticket=t1 step=review"),
    );
    expect(again.warnings).toEqual([expect.stringContaining("Run を開いていない")]);
    // 印のチケットがなければ警告する
    const missing = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a3", "deguboard: ticket=t99 step=review"),
    );
    expect(missing.warnings).toEqual([expect.stringContaining("t99 が見つからない")]);
  });

  it("別のセッションで開いたままの見直しの Run は、印 step=review の起動が interrupted で閉じてから新しい Run を開き、run review-result は新しい Run に書く（ADR-015）", async () => {
    const { ctx, parent, subagent } = await prepared();
    // 落ちたセッション s-old の見直しの Run が開いたまま残っている
    const stale = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
        session: "s-old",
      })
    ).data as Run;
    const { view, warnings } = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a1", "deguboard: ticket=t1 step=review\n\n見直す"),
    );
    expect(warnings).not.toContainEqual(expect.stringContaining("Run を開いていない"));
    expect(view.done).toEqual([
      `t1 の review の Run ${stale.id} を interrupted で閉じた`,
      expect.stringMatching(/^t1 の review の Run r\S+ を開いた$/),
    ]);
    const [fresh] = await peekRunningRuns(ctx.repo);
    expect(fresh).toMatchObject({ ticket: "t1", step: "review", session: SESSION });
    expect((await readTranscriptPaths(ctx.repo)).get(fresh!.id)).toBe(subagent("a1"));
    const closed = ((await runCommand(runList, ctx, {})).data as RunView[]).find(
      (r) => r.id === stale.id,
    );
    expect(closed).toMatchObject({
      result: "interrupted",
      error: STALE_SESSION_ERROR,
      running: false,
      review: null,
    });
    // 見直し役の結果は新しい Run に書く
    const written = (await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 1, light: 0 }))
      .data as Run;
    expect(written).toMatchObject({
      id: fresh!.id,
      review: { heavy: 1, light: 0, passed: false },
    });
    // セッションの分からない Run（フックのない環境で開いたもの）は、落ちた残りと決められないので閉じない
    await runCommand(runStart, ctx, { ticket: "t2", step: "review", agent: "claude-code" });
    const unknown = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a2", "deguboard: ticket=t2 step=review"),
    );
    expect(unknown.warnings).toContainEqual(expect.stringContaining("Run を開いていない"));
  });

  it("前景の起動で、見直し役が別のセッションの古い見直しの Run に書いた結果は、古い Run から外して新しい Run に結び付ける。起動より前に書かれた結果は古い Run に残す（ADR-015）", async () => {
    const { ctx, parent, subagent } = await prepared();
    const stale = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
        session: "s-old",
      })
    ).data as Run;
    // 前景の見直し役は終わってから PostToolUse が来るので、動いている間の review-result は古い Run に書かれる
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    await subagentRecord(subagent("a1"), prompt, 2);
    const written = (
      await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 1, passed: true })
    ).data as Run;
    expect(written.id).toBe(stale.id);
    const completed = (agentId: string, p: string) => ({
      ...launched(parent, agentId, p),
      tool_response: {
        status: "completed",
        agentId,
        resolvedModel: "claude-test-1",
        totalDurationMs: 90_000,
        content: [{ type: "text", text: "指摘はない" }],
      },
    });
    const { view } = await call(ctx, "PostToolUse", completed("a1", prompt));
    expect(view.done).toContainEqual(expect.stringContaining("保留に移した"));
    const runs = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(runs.find((r) => r.id === stale.id)).toMatchObject({
      result: "interrupted",
      review: null,
    });
    expect(runs.find((r) => r.id !== stale.id)).toMatchObject({
      result: "success",
      running: false,
      review: { heavy: 0, light: 1, passed: true },
    });

    // 落ちたセッションの見直し役が起動より前に書いた結果は、その Run のものとして残す
    const old = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "review",
        agent: "claude-code",
        session: "s-old",
      })
    ).data as Run;
    await runCommand(runReviewResult, ctx, { ticket: "t2", heavy: 2, light: 0 });
    const past = new Date(Date.now() - 3600_000);
    await utimes(path.join(ctx.repo.localDir, runPath(old.id)), past, past);
    const prompt2 = "deguboard: ticket=t2 step=review";
    await subagentRecord(subagent("a2"), prompt2, 1);
    await call(ctx, "PostToolUse", completed("a2", prompt2));
    const runs2 = (await runCommand(runList, ctx, { ticket: "t2" })).data as RunView[];
    expect(runs2.find((r) => r.id === old.id)).toMatchObject({
      result: "interrupted",
      review: { heavy: 2, light: 0, passed: false },
    });
    // 新しい Run には結果がないので、閉じずに待つ
    expect(runs2.find((r) => r.id !== old.id)).toMatchObject({ running: true, review: null });
  });

  it("前景の起動でかかった時間が入力にないときは、記録の最初の行の時刻を起動の時刻にし、その後に古い Run に書かれた結果を新しい Run に結び付ける（ADR-017）", async () => {
    const { ctx, parent, subagent } = await prepared();
    const stale = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
        session: "s-old",
      })
    ).data as Run;
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    await subagentRecord(subagent("a1"), prompt, 2);
    // 見直し役は頼んだ文を受け取ってから数秒かけて結果を書く（ファイルの更新時刻は粗い時計なので、同じ瞬間では比べない）
    const firstAt = new Date(Date.now() - 5000).toISOString();
    const [head, ...rest] = (await readFile(subagent("a1"), "utf8")).split("\n");
    await writeFile(
      subagent("a1"),
      [JSON.stringify({ ...JSON.parse(head!), timestamp: firstAt }), ...rest].join("\n"),
    );
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 1, passed: true });
    const { view } = await call(ctx, "PostToolUse", {
      ...launched(parent, "a1", prompt),
      // totalDurationMs のない入力
      tool_response: {
        status: "completed",
        agentId: "a1",
        resolvedModel: "claude-test-1",
        content: [{ type: "text", text: "指摘はない" }],
      },
    });
    expect(view.done).toContainEqual(expect.stringContaining("保留に移した"));
    const runs = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(runs.find((r) => r.id === stale.id)).toMatchObject({
      result: "interrupted",
      review: null,
    });
    const fresh = runs.find((r) => r.id !== stale.id)!;
    expect(fresh).toMatchObject({
      result: "success",
      review: { heavy: 0, light: 1, passed: true },
    });
    // 新しい Run の開始も記録の最初の行の時刻（秒まで）
    expect(Date.parse(fresh.started_at)).toBeLessThanOrEqual(Date.parse(firstAt));
    expect(Date.parse(fresh.started_at)).toBeGreaterThan(Date.parse(firstAt) - 1000);
  });

  it("dg sync は、書き終わり待ちで残った別のセッションの見直しの Run を閉じず、同じセッションのものは閉じる（ADR-017）", async () => {
    const { ctx, parent } = await prepared();
    hookTiming.settleMs = 60;
    hookTiming.pollMs = 20;
    // 落ちたセッション s-old の見直し役が結果を書いて止まり、書き終わり待ちのまま残った
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    const oldParent = path.join(path.dirname(parent), "s-old.jsonl");
    const oldSub = path.join(path.dirname(parent), "s-old", "subagents", "agent-o1.jsonl");
    await call(ctx, "PostToolUse", { ...launched(oldParent, "o1", prompt), session_id: "s-old" });
    await subagentRecord(oldSub, prompt, 1, [], [{ type: "api-request", id: "q1" }]);
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 2, light: 0 });
    await call(ctx, "SubagentStop", {
      session_id: "s-old",
      agent_id: "o1",
      agent_transcript_path: oldSub,
    });
    const [stale] = await peekRunningRuns(ctx.repo);
    expect(stale!.settling_since).not.toBeNull();
    await appendResponses(oldSub, 1, ["m3"]);

    // 今のセッションの前景の見直し役が、古い Run に今回の結果を書いてから sync を呼ぶ
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
    ctx.env = { ...ctx.env, DEGUBOARD_SESSION: SESSION };
    await runCommand(sync, ctx, {});
    expect((await peekRunningRuns(ctx.repo)).map((r) => r.id)).toEqual([stale!.id]);

    // 同じセッションの sync なら閉じる
    ctx.env = { ...ctx.env, DEGUBOARD_SESSION: "s-old" };
    const synced = await runCommand(sync, ctx, {});
    expect(synced.warnings).toContainEqual(expect.stringContaining("success で閉じた"));
    expect(await peekRunningRuns(ctx.repo)).toEqual([]);
  });

  it("同じセッションで同じチケットの見直しの Run を重ねて開くと、前の Run を閉じずに拒否して警告する（ADR-015）", async () => {
    const { ctx, parent } = await prepared();
    await call(ctx, "PostToolUse", launched(parent, "a1", "deguboard: ticket=t1 step=review"));
    const [first] = await peekRunningRuns(ctx.repo);
    const again = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a2", "deguboard: ticket=t1 step=review"),
    );
    expect(again.view.done).toEqual([]);
    expect(again.warnings).toEqual([
      expect.stringContaining(
        `t1 の review の Run を開いていない: t1 の review の Run ${first!.id} が実行中`,
      ),
    ]);
    expect((await peekRunningRuns(ctx.repo)).map((r) => r.id)).toEqual([first!.id]);
    // 前の Run は閉じていない
    const runs = (await runCommand(runList, ctx, {})).data as RunView[];
    expect(runs.filter((r) => !r.running)).toEqual([]);
  });

  it("前景の起動（終わってから返る。SubagentStop が先に来る）は、PostToolUse が Run を開いてその場で閉じ、開始をかかった時間だけ前にする", async () => {
    const { ctx, parent, subagent } = await prepared();
    // 結果を step の事実で決めない step（investigate）で、開閉と時間だけを見る
    const prompt = "deguboard: ticket=t1 step=investigate\n\n調べる";
    await subagentRecord(subagent("a1"), prompt, 3);
    // 先に来る SubagentStop は閉じる Run がないので何もしない
    const stop = await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
      last_assistant_message: "指摘はない",
    });
    expect(stop.view.done).toEqual([]);
    const { view } = await call(ctx, "PostToolUse", {
      ...launched(parent, "a1", prompt),
      tool_response: {
        status: "completed",
        agentId: "a1",
        resolvedModel: "claude-test-1",
        totalDurationMs: 90_000,
        content: [
          { type: "text", text: "<tools-used-before-summary>Bash</tools-used-before-summary>" },
          { type: "text", text: "指摘はない" },
        ],
      },
    });
    expect(view.done).toEqual([
      expect.stringContaining("を開いた"),
      expect.stringContaining("success で閉じた"),
    ]);
    const [run] = (await runCommand(runList, ctx, {})).data as RunView[];
    expect(run).toMatchObject({ result: "success", running: false, usage: { input: 6 } });
    expect(run!.duration_seconds).toBeGreaterThanOrEqual(89);
  });

  it("SubagentStop は印のある Run を記録の全体から数えて閉じ、見直しは結果が記録されていれば success（ADR-013）", async () => {
    const { ctx, parent, subagent } = await prepared();
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 5);
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 2, passed: true });
    const { view } = await call(ctx, "SubagentStop", {
      session_id: SESSION,
      transcript_path: parent,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
      last_assistant_message: "指摘はない",
    });
    expect(view.done).toEqual([expect.stringContaining("success で閉じた")]);
    const [run] = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    // 開始の前の応答も、サブエージェントの記録の先頭から数える
    expect(run).toMatchObject({
      result: "success",
      running: false,
      usage: { input: 10 },
      review: { heavy: 0, light: 2, passed: true },
    });
  });

  it("SubagentStop は結果の記録のない見直しの Run を閉じず、止まって待っている印を付けて run list --running に出す（ADR-014）", async () => {
    const { ctx, parent, subagent } = await prepared();
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 1);
    await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
      last_assistant_message: "指摘はない",
    });
    const [run] = (await runCommand(runList, ctx, { running: true })).data as RunView[];
    expect(run).toMatchObject({ ticket: "t1", step: "review", running: true, review: null });
    expect(run!.waiting_since).toEqual(expect.any(String));
  });

  it("SubagentStop は記録の最初の文の印で Run のチケットと step を直す（並べて起動して取り違えたとき）", async () => {
    const { ctx, parent, subagent } = await prepared();
    await call(ctx, "PostToolUse", launched(parent, "a1", "deguboard: ticket=t1 step=review"));
    await subagentRecord(subagent("a1"), "deguboard: ticket=t2 step=review", 1);
    const { warnings } = await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
      last_assistant_message: "ok",
    });
    expect(warnings).toContainEqual(expect.stringContaining("t2 の review に直した"));
    const runs = (await runCommand(runList, ctx, {})).data as RunView[];
    // 結果を記録していない見直しなので、閉じずに待つ
    expect(runs.map((r) => [r.ticket, r.step, r.running])).toEqual([["t2", "review", true]]);
  });

  it("SubagentStop は手直しの Run を、開始より後の push がなければ閉じずに待ち、SessionEnd が interrupted で閉じる", async () => {
    const { ctx, parent, subagent } = await prepared();
    await call(ctx, "PostToolUse", launched(parent, "a1", "deguboard: ticket=t1 step=fix"));
    await subagentRecord(subagent("a1"), "deguboard: ticket=t1 step=fix", 1);
    await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
      last_assistant_message: "直した",
    });
    expect((await peekRunningRuns(ctx.repo))[0]!.waiting_since).not.toBeNull();
    await call(ctx, "SessionEnd", { session_id: SESSION });
    const [run] = (await runCommand(runList, ctx, {})).data as RunView[];
    expect(run).toMatchObject({ step: "fix", result: "interrupted", running: false });
  });

  it("印のある Run がなければ、サブエージェントが自分で開いた Run（記録に ID が出る）に記録の場所を結び付ける", async () => {
    const { ctx, parent, subagent } = await prepared();
    const run = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    await subagentRecord(
      subagent("a9"),
      "見直す",
      1,
      bashCall("dg --json --actor agent run start t1 review --agent claude-code", startOutput(run)),
    );
    const { view } = await call(ctx, "SubagentStop", {
      session_id: SESSION,
      transcript_path: parent,
      agent_id: "a9",
      agent_transcript_path: subagent("a9"),
      last_assistant_message: "ok",
    });
    // 見直しの結果がないまま返ったので、記録の場所の結び付けのあとに止まって待っている印を付ける
    expect(view.done).toEqual([
      expect.stringContaining(`Run ${run.id} の記録の場所`),
      expect.stringContaining(`Run ${run.id} は止まって待っている`),
    ]);
    expect((await readTranscriptPaths(ctx.repo)).get(run.id)).toBe(subagent("a9"));
  });

  it("SessionEnd はこのセッションのサブエージェントの開いた Run をすべて閉じ（見直しは interrupted、PR のない実装は failure）、親が自分で開いた Run とほかのセッションの Run は残す（ADR-014）", async () => {
    const { ctx, parent, subagent } = await prepared();
    await call(ctx, "PostToolUse", launched(parent, "a1", "deguboard: ticket=t1 step=review"));
    await call(ctx, "PostToolUse", launched(parent, "a2", "deguboard: ticket=t2 step=implement"));
    await runCommand(runStart, ctx, {
      ticket: "t1",
      step: "fix",
      agent: "claude-code",
      session: SESSION,
    });
    await runCommand(runStart, ctx, {
      ticket: "t2",
      step: "review",
      agent: "claude-code",
      session: "s-other",
    });
    await subagentRecord(subagent("a1"), "deguboard: ticket=t1 step=review", 1);
    await subagentRecord(subagent("a2"), "deguboard: ticket=t2 step=implement", 1);
    const { view } = await call(ctx, "SessionEnd", { session_id: SESSION, reason: "other" });
    expect(view.done).toHaveLength(2);
    const closed = ((await runCommand(runList, ctx, {})).data as RunView[])
      .filter((r) => !r.running)
      .map((r) => [r.ticket, r.step, r.result])
      .sort();
    expect(closed).toEqual([
      ["t1", "review", "interrupted"],
      ["t2", "implement", "failure"],
    ]);
    const running = (await peekRunningRuns(ctx.repo)).map((r) => [r.ticket, r.step]).sort();
    expect(running).toEqual([
      ["t1", "fix"],
      ["t2", "review"],
    ]);
  });

  it("扱わないイベントや形の違う入力は何もせず成功で返す", async () => {
    const { ctx } = await prepared();
    expect((await call(ctx, "UserPromptSubmit", { session_id: SESSION })).view.done).toEqual([]);
    expect(
      (await call(ctx, "PostToolUse", { session_id: SESSION, tool_name: "Bash" })).view.done,
    ).toEqual([]);
    expect((await call(ctx, "SubagentStop", {})).view.done).toEqual([]);
  });
});

describe("dg hook の見直しで直した場面（ADR-012）", () => {
  it("移行の経路は、同じセッションで記録の最初の行より後に始まった Run だけを結び付け、記録に ID が出るだけの Run は結び付け直さない", async () => {
    const { ctx, parent, subagent } = await prepared();
    // 前からある、ほかのセッションの Run（一覧で ID を見ただけ）
    const old = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "review",
        agent: "claude-code",
        session: "s-other",
      })
    ).data as Run;
    await new Promise((r) => setTimeout(r, 1100));
    const mine = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    // どちらも run start の結果の形で出るが、old はほかのセッションで記録より前に始まった
    await subagentRecord(subagent("a9"), "見直す", 1, [
      ...bashCall("dg --json run start t2 review", startOutput(old)),
      ...bashCall("dg --json run start t1 review", startOutput(mine)),
    ]);
    // 記録の最初の行の時刻を、自分の Run の開始より前に（old の開始より後に）する
    const text = await readFile(subagent("a9"), "utf8");
    const first = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
    first["timestamp"] = new Date(Date.parse(mine.started_at) - 500).toISOString();
    await writeFile(
      subagent("a9"),
      [JSON.stringify(first), ...text.split("\n").slice(1)].join("\n"),
    );
    await call(ctx, "SubagentStop", {
      session_id: SESSION,
      transcript_path: parent,
      agent_id: "a9",
      agent_transcript_path: subagent("a9"),
      last_assistant_message: "ok",
    });
    const paths = await readTranscriptPaths(ctx.repo);
    expect(paths.get(mine.id)).toBe(subagent("a9"));
    expect(paths.has(old.id)).toBe(false);
  });

  it("前景の起動で、先に来た終わりの出来事が自分で開いた Run を結び付けていたら、PostToolUse はもう 1 本開かない", async () => {
    const { ctx, parent, subagent } = await prepared();
    const prompt = "deguboard: ticket=t1 step=review";
    const own = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    await subagentRecord(
      subagent("a1"),
      prompt,
      1,
      bashCall("mise run dg -- --json run start t1 review", startOutput(own)),
    );
    const text = await readFile(subagent("a1"), "utf8");
    const first = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
    first["timestamp"] = new Date(Date.parse(own.started_at) - 500).toISOString();
    await writeFile(
      subagent("a1"),
      [JSON.stringify(first), ...text.split("\n").slice(1)].join("\n"),
    );
    await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
      last_assistant_message: "ok",
    });
    const { view } = await call(ctx, "PostToolUse", {
      ...launched(parent, "a1", prompt),
      tool_response: {
        status: "completed",
        agentId: "a1",
        content: [{ type: "text", text: "ok" }],
      },
    });
    expect(view.done).toEqual([expect.stringContaining("開かない")]);
    const runs = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(runs.map((r) => r.id)).toEqual([own.id]);
  });

  it("記録のパスが会話記録の置き場所の外なら、PostToolUse も SubagentStop も使わずに警告する", async () => {
    const { ctx, home } = await prepared();
    const outside = path.join(home, "outside", `${SESSION}.jsonl`);
    const opened = await call(
      ctx,
      "PostToolUse",
      launched(outside, "a1", "deguboard: ticket=t1 step=review"),
    );
    expect(opened.warnings).toEqual([expect.stringContaining("置き場所の下にない")]);
    expect(await peekRunningRuns(ctx.repo)).toEqual([]);
    const stopped = await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: path.join(home, ".ssh", "id_rsa"),
    });
    expect(stopped.warnings).toEqual([expect.stringContaining("置き場所の下にない")]);
  });
});

describe("dg hook の移行の経路と兄弟の Run（ADR-012）", () => {
  /** 印のない A が自分で run start した記録。最初の行の時刻は A の Run の開始より前 */
  async function selfStarted(
    ctx: CommandContext,
    file: string,
    extra: (mine: Run) => unknown[],
    step = "review",
  ) {
    const mine = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step,
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    await subagentRecord(file, "見直す", 1, extra(mine));
    const text = await readFile(file, "utf8");
    const first = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
    first["timestamp"] = new Date(Date.parse(mine.started_at) - 500).toISOString();
    await writeFile(file, [JSON.stringify(first), ...text.split("\n").slice(1)].join("\n"));
    return mine;
  }
  const stopA = (ctx: CommandContext, file: string) =>
    call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: file,
      last_assistant_message: "ok",
    });

  it("run start の警告に出るだけの兄弟の Run と、ほかのサブエージェントの記録に結び付いた Run は奪わない", async () => {
    const { ctx, parent, subagent } = await prepared();
    // 印のある兄弟 B を起動のフックが開く
    await call(ctx, "PostToolUse", launched(parent, "b1", "deguboard: ticket=t2 step=review"));
    const [sibling] = await peekRunningRuns(ctx.repo);
    const mine = await selfStarted(ctx, subagent("a1"), (m) =>
      bashCall("dg --json run start t1 review", startOutput(m, [sibling!.id])),
    );
    const { view } = await stopA(ctx, subagent("a1"));
    expect(view.done).toEqual([
      expect.stringContaining(`Run ${mine.id} の記録の場所`),
      expect.stringContaining(`Run ${mine.id} は止まって待っている`),
    ]);
    const paths = await readTranscriptPaths(ctx.repo);
    expect(paths.get(mine.id)).toBe(subagent("a1"));
    expect(paths.get(sibling!.id)).toBe(subagent("b1"));
  });

  it("一覧（run list --json）に出た兄弟の Run は奪わない", async () => {
    const { ctx, subagent } = await prepared();
    let other: Run | undefined;
    const mine = await selfStarted(ctx, subagent("a1"), (m) => [
      ...bashCall("dg --json run start t1 review", startOutput(m)),
      ...bashCall(
        "dg --json run list --running",
        JSON.stringify({ ok: true, data: [m, other] }, null, 2),
      ),
    ]);
    // 印のない兄弟 B も同じセッションで自分で run start した（親の記録の場所のまま）
    other = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "review",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    await subagentRecord(subagent("a1"), "見直す", 1, [
      ...bashCall("dg --json run start t1 review", startOutput(mine)),
      ...bashCall(
        "dg --json run list --running",
        JSON.stringify({ ok: true, data: [mine, other] }, null, 2),
      ),
    ]);
    const text = await readFile(subagent("a1"), "utf8");
    const first = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
    first["timestamp"] = new Date(Date.parse(mine.started_at) - 500).toISOString();
    await writeFile(
      subagent("a1"),
      [JSON.stringify(first), ...text.split("\n").slice(1)].join("\n"),
    );
    await stopA(ctx, subagent("a1"));
    const paths = await readTranscriptPaths(ctx.repo);
    expect(paths.get(mine.id)).toBe(subagent("a1"));
    expect(paths.has(other.id)).toBe(false);
  });

  it("人向けの出力の run start（id: の行）と claim（run: の行）の ID も取る", async () => {
    const { ctx, subagent } = await prepared();
    const mine = await selfStarted(ctx, subagent("a1"), (m) =>
      bashCall(
        "dg run start t1 review",
        `id: ${m.id}\nticket: t1\nstep: review\n警告: このマシンで claude-code の Run r20260101-000000-0000 が開いたまま`,
      ),
    );
    const { view } = await stopA(ctx, subagent("a1"));
    expect(view.done).toEqual([
      expect.stringContaining(`Run ${mine.id} の記録の場所`),
      expect.stringContaining(`Run ${mine.id} は止まって待っている`),
    ]);
  });

  it("自分で開いた手直しの Run が push なしで返ったら、止まって待っている印を付けて開いたままにする（ADR-014）", async () => {
    const { ctx, subagent } = await prepared();
    const mine = await selfStarted(
      ctx,
      subagent("a1"),
      (m) => bashCall("dg --json run start t1 fix", startOutput(m)),
      "fix",
    );
    const { view } = await stopA(ctx, subagent("a1"));
    expect(view.done).toEqual([
      expect.stringContaining(`Run ${mine.id} の記録の場所`),
      expect.stringContaining("止まって待っている"),
    ]);
    const [open] = await peekRunningRuns(ctx.repo);
    expect(open).toMatchObject({ id: mine.id, step: "fix" });
    expect(open!.waiting_since).not.toBeNull();
  });

  it("自分で開いた見直しの Run でも、step を終えた事実（見直しの結果）があれば印を付けない", async () => {
    const { ctx, subagent } = await prepared();
    const mine = await selfStarted(ctx, subagent("a1"), (m) =>
      bashCall("dg --json run start t1 review", startOutput(m)),
    );
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 1 });
    await stopA(ctx, subagent("a1"));
    const [open] = await peekRunningRuns(ctx.repo);
    expect(open).toMatchObject({ id: mine.id, review: { heavy: 0, light: 1 } });
    expect(open!.waiting_since).toBeNull();
  });

  it("手直しを続きで頼んだ会話で claim が開いた手直しの Run は、待ちの印から続けて止まっても印の step（実装）に直さず、push があれば fix のまま success で閉じる", async () => {
    const { ctx, parent, subagent } = await prepared();
    await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feat/t1", no_run: true });
    await runGit(ctx.repo.topLevel, ["checkout", "-qb", "feat/t1"]);
    const mine = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "fix",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    // 続きで頼まれた実装の会話の最初の文は印（step=implement）。claim の結果に、開いた手直しの Run の ID が出る
    await subagentRecord(
      subagent("a1"),
      "deguboard: ticket=t1 step=implement",
      1,
      bashCall("dg --json ticket claim t1 --retry-reason 指摘", startOutput(mine)),
    );
    const text = await readFile(subagent("a1"), "utf8");
    const first = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
    first["timestamp"] = new Date(Date.parse(mine.started_at) - 500).toISOString();
    await writeFile(
      subagent("a1"),
      [JSON.stringify(first), ...text.split("\n").slice(1)].join("\n"),
    );
    // 1 回目の止まり：push がないので、結び付けて待ちの印を付ける
    await stopA(ctx, subagent("a1"));
    expect((await peekRunningRuns(ctx.repo))[0]!.waiting_since).not.toBeNull();
    // 親が続きを送る（同じ agent_id の再開で印が消える）
    await call(ctx, "SubagentStart", {
      session_id: SESSION,
      transcript_path: parent,
      agent_id: "a1",
      agent_type: "general-purpose",
    });
    expect((await peekRunningRuns(ctx.repo))[0]!.waiting_since).toBeNull();
    // 続きで直して push してから、2 回目の止まり
    await runGit(ctx.repo.topLevel, ["commit", "-q", "--allow-empty", "-m", "直した"]);
    await runGit(ctx.repo.topLevel, ["push", "-q", "origin", "feat/t1"]);
    await stopA(ctx, subagent("a1"));
    const runs = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(runs.find((r) => r.id === mine.id)).toMatchObject({
      step: "fix",
      result: "success",
      running: false,
    });
  });
});

/** 記録に応答の行を足す（再開の後の応答や、書き終わりの最後の応答） */
async function appendResponses(file: string, tokens: number, ids: string[]) {
  const lines = ids.map((id) => ({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      id,
      model: "claude-test-1",
      content: "答え",
      usage: {
        input_tokens: tokens,
        output_tokens: tokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }));
  await appendFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("サブエージェントの止まりと再開（ADR-014）", () => {
  const stop = (ctx: CommandContext, file: string, agentId = "a1") =>
    call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: agentId,
      agent_transcript_path: file,
    });

  it("質問で止まった Run は同じ agent_id の SubagentStart で続きになり、次の Stop が最初と再開後の応答を両方数えて閉じる", async () => {
    const { ctx, parent, subagent } = await prepared();
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 1);
    await stop(ctx, subagent("a1"));
    const [waiting] = await peekRunningRuns(ctx.repo);
    expect(waiting!.waiting_since).not.toBeNull();

    const started = await call(ctx, "SubagentStart", {
      session_id: SESSION,
      transcript_path: parent,
      agent_id: "a1",
      agent_type: "general-purpose",
    });
    expect(started.view.done).toEqual([expect.stringContaining("続きとして使う")]);
    const resumed = await peekRunningRuns(ctx.repo);
    // 新しい Run を開かず、印だけを消す
    expect(resumed.map((r) => [r.id, r.waiting_since])).toEqual([[waiting!.id, null]]);

    await appendResponses(subagent("a1"), 3, ["m3", "m4"]);
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
    const { view } = await stop(ctx, subagent("a1"));
    expect(view.done).toEqual([expect.stringContaining("success で閉じた")]);
    const [run] = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    // 最初の Stop までの 2 つ（1 ずつ）と再開後の 2 つ（3 ずつ）
    expect(run).toMatchObject({ id: waiting!.id, result: "success", usage: { input: 8 } });
    expect(run).not.toHaveProperty("waiting_since", expect.any(String));
  });

  it("記録の最後が api-request のままなら待ち、上限までに書かれなければ閉じずに警告し、dg sync が数えて閉じる", async () => {
    const { ctx, parent, subagent } = await prepared();
    hookTiming.settleMs = 150;
    hookTiming.pollMs = 20;
    const prompt = "deguboard: ticket=t1 step=investigate\n\n調べる";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 1, [], [{ type: "api-request", id: "q1" }]);
    const first = await stop(ctx, subagent("a1"));
    expect(first.warnings).toContainEqual(expect.stringContaining("まだ閉じない"));
    expect(await peekRunningRuns(ctx.repo)).toHaveLength(1);

    await appendResponses(subagent("a1"), 5, ["m3"]);
    const synced = await runCommand(sync, ctx, {});
    expect(synced.warnings).toContainEqual(expect.stringContaining("success で閉じた"));
    const [run] = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(run).toMatchObject({ result: "success", running: false, usage: { input: 7 } });
  });

  it("記録の最後の api-request の後に応答が出れば、待ってから閉じる", async () => {
    const { ctx, parent, subagent } = await prepared();
    hookTiming.pollMs = 20;
    const prompt = "deguboard: ticket=t1 step=investigate";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 1, [], [{ type: "api-request", id: "q1" }]);
    const late = setTimeout(() => void appendResponses(subagent("a1"), 5, ["m3"]), 100);
    const { view } = await stop(ctx, subagent("a1"));
    clearTimeout(late);
    expect(view.done).toEqual([expect.stringContaining("success で閉じた")]);
    const [run] = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(run).toMatchObject({ usage: { input: 7 } });
  });

  it("前景の見直し役が Run のないうちに書いた結果は保留になり、PostToolUse が開いて閉じるときに結び付いて success になる", async () => {
    const { ctx, parent, subagent } = await prepared();
    const prompt = "deguboard: ticket=t1 step=review\n\n見直す";
    await subagentRecord(subagent("a1"), prompt, 1);
    const held = await runCommand(runReviewResult, ctx, {
      ticket: "t1",
      heavy: 0,
      light: 1,
      passed: true,
    });
    expect(held.data).toMatchObject({ pending: true });
    await stop(ctx, subagent("a1"));
    const { view } = await call(ctx, "PostToolUse", {
      ...launched(parent, "a1", prompt),
      tool_response: {
        status: "completed",
        agentId: "a1",
        resolvedModel: "claude-test-1",
        totalDurationMs: 90_000,
      },
    });
    expect(view.done).toContainEqual(expect.stringContaining("保留の見直しの結果"));
    expect(view.done).toContainEqual(expect.stringContaining("success で閉じた"));
    const [run] = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(run).toMatchObject({ result: "success", review: { heavy: 0, light: 1, passed: true } });
  });

  it("SessionEnd は PR のある実装のサブエージェントの Run を success で閉じる", async () => {
    const { ctx, parent, subagent } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 12 });
    await call(ctx, "PostToolUse", launched(parent, "a1", "deguboard: ticket=t1 step=implement"));
    await subagentRecord(subagent("a1"), "deguboard: ticket=t1 step=implement", 1);
    await call(ctx, "SessionEnd", { session_id: SESSION });
    const [run] = (await runCommand(runList, ctx, { ticket: "t1" })).data as RunView[];
    expect(run).toMatchObject({ step: "implement", result: "success", running: false });
  });

  it("掃除は質問で止まって待っている Run を、事実がそろっても閉じない（再開を待つ）", async () => {
    const { ctx, parent, subagent } = await prepared();
    const prompt = "deguboard: ticket=t1 step=review";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 1);
    await stop(ctx, subagent("a1"));
    // 待っている間に結果が書かれても、再開した後の作業を数えるため閉じない
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
    await runCommand(sync, ctx, {});
    const [run] = await peekRunningRuns(ctx.repo);
    expect(run).toMatchObject({ step: "review", review: { passed: true } });
    expect(run!.waiting_since).not.toBeNull();
  });

  it("書き終わりを待ちきれなかったフックは、同じフックの中ではその Run を閉じない", async () => {
    const { ctx, parent, subagent } = await prepared();
    hookTiming.settleMs = 60;
    hookTiming.pollMs = 20;
    const prompt = "deguboard: ticket=t1 step=investigate";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    await subagentRecord(subagent("a1"), prompt, 1, [], [{ type: "api-request", id: "q1" }]);
    // 待ちの上限を過ぎた直後、同じフックの掃除の前に書かれる
    hookTiming.onGiveUp = () => appendResponses(subagent("a1"), 5, ["m3"]);
    const { view, warnings } = await stop(ctx, subagent("a1"));
    expect(warnings).toContainEqual(expect.stringContaining("まだ閉じない"));
    expect(view.done.some((d) => d.includes("で閉じた"))).toBe(false);
    expect((await peekRunningRuns(ctx.repo))[0]!.settling_since).not.toBeNull();
  });
});

describe("dg hook の入力の記録（t542）", () => {
  it("扱うイベントは受け取った入力の項目の有無と時刻を deguboard-local/hook-inputs/ に残し、値は残さない", async () => {
    const { ctx, parent } = await prepared();
    await call(
      ctx,
      "PostToolUse",
      launched(parent, "a1", "deguboard: ticket=t1 step=implement\n秘密の文"),
    );
    const record = await readHookInput(ctx.repo.localDir, "PostToolUse");
    expect(record).toMatchObject({
      event: "PostToolUse",
      fields: { "tool_input.prompt": true, "tool_response.agentId": true },
    });
    expect(record!.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const text = await readFile(
      path.join(ctx.repo.localDir, "hook-inputs", "PostToolUse.json"),
      "utf8",
    );
    expect(text).not.toContain("秘密の文");
    expect(text).not.toContain("a1");
  });

  it("要る項目がない入力は有無に false として残し、直近の 1 件だけを上書きする", async () => {
    const { ctx, parent } = await prepared();
    const broken = {
      ...launched(parent, "a1", "頼んだ文"),
      tool_response: { status: "async_launched" },
    };
    await call(ctx, "PostToolUse", broken);
    const fields = (await readHookInput(ctx.repo.localDir, "PostToolUse"))!.fields;
    expect(fields["tool_input.prompt"]).toBe(true);
    expect(fields["tool_response.agentId"]).toBe(false);
    await call(ctx, "PostToolUse", launched(parent, "a2", "頼んだ文"));
    expect(
      (await readHookInput(ctx.repo.localDir, "PostToolUse"))!.fields["tool_response.agentId"],
    ).toBe(true);
  });

  it("PreToolUse はツールごとに読む項目を記録し、Bash で command がなければ欠けたと残す", async () => {
    const { ctx } = await prepared();
    await call(ctx, "PreToolUse", {
      session_id: SESSION,
      tool_name: "Bash",
      tool_input: {},
      cwd: "/w",
    });
    expect((await readHookInput(ctx.repo.localDir, "PreToolUse"))!.fields).toEqual({
      session_id: true,
      tool_name: true,
      cwd: true,
      "tool_input.command": false,
    });
  });

  it("扱わないイベントの入力は記録しない", async () => {
    const { ctx } = await prepared();
    await call(ctx, "UserPromptSubmit", { session_id: SESSION });
    expect(await readHookInput(ctx.repo.localDir, "UserPromptSubmit")).toBeUndefined();
  });
});

describe("入力の項目と parseHook の読み方（t542）", () => {
  const full: Record<string, Record<string, unknown>> = {
    SessionStart: { session_id: "s", transcript_path: "/t.jsonl" },
    PostToolUse: {
      session_id: "s",
      transcript_path: "/t.jsonl",
      tool_name: "Agent",
      tool_input: { prompt: "頼んだ文" },
      tool_response: { agentId: "a1", status: "completed", resolvedModel: "m", totalDurationMs: 5 },
    },
    SubagentStart: { session_id: "s", transcript_path: "/t.jsonl", agent_id: "a1" },
    SubagentStop: { session_id: "s", agent_id: "a1", agent_transcript_path: "/a.jsonl" },
    SessionEnd: { session_id: "s" },
  };
  const pre = (tool: string, toolInput: Record<string, unknown>) => ({
    session_id: "s",
    tool_name: tool,
    tool_input: toolInput,
    cwd: "/w",
  });
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["SessionStart", full["SessionStart"]!, ["session_id", "transcript_path"]],
    [
      "PostToolUse",
      full["PostToolUse"]!,
      ["session_id", "transcript_path", "tool_name", "tool_input.prompt", "tool_response.agentId"],
    ],
    ["SubagentStart", full["SubagentStart"]!, ["session_id", "transcript_path", "agent_id"]],
    ["SubagentStop", full["SubagentStop"]!, ["session_id", "agent_id", "agent_transcript_path"]],
    ["SessionEnd", full["SessionEnd"]!, ["session_id"]],
    [
      "PreToolUse",
      pre("Bash", { command: "ls" }),
      ["session_id", "tool_name", "cwd", "tool_input.command"],
    ],
    [
      "PreToolUse",
      pre("Edit", { file_path: "/a" }),
      ["session_id", "tool_name", "cwd", "tool_input.file_path"],
    ],
    [
      "PreToolUse",
      pre("NotebookEdit", { notebook_path: "/n" }),
      ["session_id", "tool_name", "cwd", "tool_input.notebook_path"],
    ],
  ];

  it("イベント（とツール）ごとの項目は、parseHook が読む項目と一致し、外すと parse の結果が変わる", () => {
    const hooks = hooksOf("claude-code")!;
    const env = { CLAUDE_ENV_FILE: "/env" };
    for (const [event, input, expected] of cases) {
      expect([...hooks.inputFields(event, input)]).toEqual(expected);
      const whole = hooks.parse(event, input, env);
      expect(whole, event).toBeDefined();
      for (const field of expected) {
        const without = structuredClone(input);
        const keys = field.split(".");
        let at: Record<string, unknown> = without;
        for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
        delete at[keys[keys.length - 1]!];
        expect(hooks.parse(event, without, env), `${event} の ${field}`).not.toEqual(whole);
      }
    }
  });
});

describe("PreToolUse（t532）", () => {
  it("Bash は .git/deguboard の語があれば、書くものも読むだけのものも、引用符・コメントの中でも止め、語のないものは通す（t546）", () => {
    for (const c of [
      // 書くもの（t532 で見分けていた形）
      "echo x > .git/deguboard/tickets/t1.md",
      "cat a | tee -a /r/.git/deguboard/config.yaml",
      "git -C .git/deguboard commit -m x",
      "cd .git/deguboard && echo hi > tickets/t1.md",
      "find .git/deguboard -exec rm {} +",
      // 読むだけのもの（t532 では通していた）
      "cat .git/deguboard/tickets/t1.md",
      "ls .git/deguboard",
      "git -C .git/deguboard log --oneline -1",
      "cp .git/deguboard/tickets/t1.md /tmp/x",
      // 字句で読み切れなかった形
      `python3 -c "open('.git/deguboard/tickets/t1.md', 'w').write('x')"`,
      "D=.git/deguboard; rm $D/x",
      "ls .git\\deguboard",
      "cat /r/.git/deguboard-local/config.yaml",
      // 引用符・ヒアドキュメント・コメントの中も伏せない
      "git commit -F - <<'EOF'\nrm .git/deguboard/x と書く\nEOF",
      'echo ".git/deguboard"',
      "ls # .git/deguboard",
    ])
      expect(touchesDataDir(c), c).toBe(true);
    // 語として現れない書き込みは通る（dg の外の変更として事後に見つける）
    for (const c of [
      "mise run dg -- ticket update t1 --pr 3",
      "cd .git && rm deguboard/tickets/t1.md",
      "grep -rn deguboard docs",
    ])
      expect(touchesDataDir(c), c).toBe(false);
  });

  it("dg を経由しない gh pr merge・ready を、PR の指定・包むコマンド・置き換え・任意の言語のコードの中でも、字句を読まずに見つける（PR 482 で読み違えた例を含む）", () => {
    for (const c of [
      "gh pr merge 12 --squash",
      "gh pr ready",
      "gh -R o/r pr merge 5",
      "gh pr merge --squash --subject 'a b' 7",
      // PR 482 で読み違えた・読めなかった例
      "gh pr merge --squash --delete-branch 2>&1",
      "gh pr merge --squash --delete-branch 2>&1 | tail -1",
      "gh pr merge $PR --squash",
      'gh pr merge "$PR" --squash',
      "gh pr merge ${PR} --squash",
      `python3 -c "import subprocess; subprocess.run(['gh', 'pr', 'merge', '482'])"`,
      "python -c 'import os; os.system(\"gh pr merge 482\")'",
      "node -e \"require('child_process').execSync('gh pr ready 482')\"",
      'bash -c "gh pr merge 482"',
      "sh <<'EOF'\ngh pr merge 482\nEOF",
      "eval 'gh pr merge 482'",
      'echo "gh pr merge 482" | sh',
      "xargs gh pr merge < prs.txt",
      "echo merge 1 | xargs gh pr",
      "echo 'pr merge 1' | xargs gh",
      "echo 482 | xargs -I{} gh pr merge {}",
      // 前の代入・包むコマンド・括弧・予約語・関数・置き換え・絶対パス・行の継ぎ
      "DEGUBOARD_ACTOR=agent gh pr merge 482",
      "env gh pr merge 482",
      "sudo -u me gh pr merge 482",
      "(cd /x && gh pr merge 482)",
      "for p in 1 2; do gh pr merge $p; done",
      "if gh pr ready 482; then echo ok; fi",
      "{ gh pr merge 482; }",
      "function f { gh pr merge 482; }",
      "echo $(gh pr merge 482)",
      "echo `gh pr merge 482`",
      '$(echo "gh pr merge 482")',
      "$(which gh) pr merge 1",
      "`which gh` pr merge 1",
      "GH=gh; $GH pr merge 1",
      "SUB=pr; gh $SUB merge 1",
      "mise run deploy -- 'gh pr merge 1'",
      "/usr/bin/gh pr merge 482",
      "gh pr \\\n  merge 482",
      'gh pr "merge" 482',
      "gh pr merge --help",
      // 取り消しの後に続けた呼び出しと、-- の後の --undo
      "gh pr ready 482 --undo && gh pr merge 482",
      "gh pr ready 1 -- --undo",
      "gh pr ready 1 --undo=false",
      // dg pr の後に続けた gh と、gh の引数の中の dg（名前が dg で終わるリポジトリ）
      "mise run dg -- pr merge t1; gh pr merge 1",
      "gh -R o/dg pr merge 1",
      "gh --repo me/foo-dg pr ready 1",
      // gh api の同じ操作
      "gh api -X PUT repos/o/r/pulls/482/merge",
      "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
      // 任意の言語のコードでは pr と merge が隣り合わない
      "python3 - <<'EOF'\nimport subprocess\nsubprocess.run([\n  'gh',\n  'pr',\n  'merge',\n  '1',\n])\nEOF",
      "python3 -c \"import os; os.system('gh pr ' + 'merge 1')\"",
      "git fetch --upload-pack=\"sh -c 'gh pr merge 1'\" /tmp/x",
    ])
      expect(advancesPrOutsideDg(c), c).toBe(true);
  });

  it("本文の引用符・ヒアドキュメント・コメントの中の gh pr merge・ready の語も伏せずに止め、拒む文がファイル渡しの道を案内する", () => {
    for (const c of [
      'echo "gh pr merge 482 を打つ"',
      "echo ok # gh pr merge はまだ打たない",
      "git commit -m 'gh pr merge を止める'",
      "git commit -F - <<'EOF'\ngh pr merge 482 を止める\nEOF",
      "git commit -m \"$(cat <<'EOF'\ngh pr merge 482 を止める\nEOF\n)\"",
      'gh pr create --draft --title "t545" --body "gh pr ready は dg のコマンドで"',
      "gh pr comment 482 --body 'gh pr merge はまだ'",
      "cat > /tmp/note.md <<'EOF'\ngh pr merge 482\nEOF",
    ])
      expect(advancesPrOutsideDg(c), c).toBe(true);
    expect(GH_PR_DENIED).toContain("--body-file");
    expect(GH_PR_DENIED).toContain("git commit -F");
    // ファイルで渡せば通る
    for (const c of [
      "gh pr create --draft --title t555 --body-file /tmp/body.md",
      "git commit -F /tmp/msg.txt",
    ])
      expect(advancesPrOutsideDg(c), c).toBe(false);
  });

  it("dg pr ready・dg pr merge（mise run dg -- pr … も）と gh pr ready --undo、PR を進めない gh は通す", () => {
    for (const c of [
      "gh pr view 482",
      "gh pr list --state merged",
      "gh pr ready 482 --undo",
      "gh pr view $PR --json state",
      "gh pr checks 482 && git merge-base main HEAD",
      "mise run dg -- --json --actor agent pr merge t545",
      "DEGUBOARD_ACTOR=agent mise run dg -- pr ready t545",
      "dg pr ready t1",
      'mise run dg -- pr merge t545 --delete-branch && echo "$HOME" && gh pr view 1',
      "node packages/cli/bin/dg.js pr ready t1",
      "cd $WT && mise run check && mise run dg -- pr merge t545",
      "python3 scripts/x.py && gh pr view 5 --json mergeable",
      // gh の語がなければ、pr・merge の語があっても通す
      'git commit -m "dg pr merge で PR を進める"',
      "git merge origin/main && echo pr",
    ])
      expect(advancesPrOutsideDg(c), c).toBe(false);
  });

  const pre = (ctx: CommandContext, toolInput: Record<string, unknown>, tool = "Bash") =>
    runCommand(hook, ctx, {
      event: "PreToolUse",
      payload: {
        session_id: SESSION,
        tool_name: tool,
        tool_input: toolInput,
        cwd: ctx.repo.topLevel,
      },
    });

  it("書くツールの .git/deguboard/ の下のパスを拒み、拒む文を Adapter の形で返す。外のパスは通す", async () => {
    const { ctx } = await prepared();
    const denied = await pre(
      ctx,
      { file_path: path.join(ctx.repo.dataDir, "tickets", "t1.md") },
      "Write",
    );
    const out = JSON.parse((denied.data as HookView).output!) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("dg のコマンド");
    const allowed = await pre(ctx, { file_path: "src/a.ts" }, "Edit");
    expect((allowed.data as HookView).output).toBeUndefined();
  });

  it("dg を経由しない gh pr merge・ready は、チケットの有無やゲートによらず拒み、dg pr のコマンドと人に頼む例外を案内する", async () => {
    const { ctx } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 5 });
    for (const command of ["gh pr merge 5 --squash", "gh pr merge 99 --squash", "gh pr ready"]) {
      const denied = await pre(ctx, { command });
      const reason = (
        JSON.parse((denied.data as HookView).output!) as {
          hookSpecificOutput: { permissionDecisionReason: string };
        }
      ).hookSpecificOutput.permissionDecisionReason;
      expect(reason, command).toContain("dg pr merge <ticket>");
      expect(reason, command).toContain("人に gh pr ready・gh pr merge を打ってもらう");
    }
    // 取り消し（--undo）と、ほかの gh のコマンドと dg pr は通す
    for (const command of [
      "gh pr ready 5 --undo",
      "gh pr view 5",
      "mise run dg -- --json --actor agent pr merge t1",
    ]) {
      const view = (await pre(ctx, { command })).data as HookView;
      expect(view.output, command).toBeUndefined();
      expect(view.done, command).toEqual([]);
    }
  });

  it("PreToolUse はストアを開かずに判定する。ストアのファイルがなくても拒み、ほかのイベントはストアを開く（t554）", async () => {
    const { ctx } = await prepared();
    // ストア（チケット・Plan・Epic・Iteration・config）のファイルを消す。初期化の印のデータのリポジトリの .git だけを残す
    for (const entry of await readdir(ctx.repo.dataDir))
      if (entry !== ".git")
        await rm(path.join(ctx.repo.dataDir, entry), { recursive: true, force: true });
    const opts = { cwd: ctx.repo.topLevel, actor: { kind: "agent" as const, user: "eiki" } };
    const input = (tool: string, toolInput: Record<string, unknown>) => ({
      event: "PreToolUse",
      payload: {
        session_id: SESSION,
        tool_name: tool,
        tool_input: toolInput,
        cwd: ctx.repo.topLevel,
      },
    });
    const writeInput = input("Write", {
      file_path: path.join(ctx.repo.dataDir, "tickets", "t1.md"),
    });
    const light = await openContextFor(hook, writeInput, opts);
    expect(light.storeless).toBe(true);
    expect(() => light.store).toThrow("storeless");
    expect(() => light.config).toThrow("storeless");
    for (const [i, reason] of [
      [writeInput, "dg のコマンド"],
      [input("Bash", { command: "rm .git/deguboard/tickets/t1.md" }), "dg のコマンド"],
      [input("Bash", { command: "gh pr merge 5 --squash" }), "dg pr merge <ticket>"],
    ] as const) {
      const r = await runCommand(hook, await openContextFor(hook, i, opts), i);
      expect((r.data as HookView).output).toContain(reason);
      expect(r.warnings).toEqual([]);
    }
    const allowed = input("Bash", { command: "ls" });
    const r = await runCommand(hook, await openContextFor(hook, allowed, opts), allowed);
    expect((r.data as HookView).output).toBeUndefined();
    // PreToolUse 以外（ここでは SessionStart）はストアを開く
    const full = await openContextFor(
      hook,
      { event: "SessionStart", payload: { session_id: SESSION } },
      opts,
    );
    expect(full.storeless).toBeUndefined();
    expect(full.store).toBeDefined();
  });

  it("初期化していないリポジトリでは、PreToolUse も今までどおり NOT_INITIALIZED で何も拒まない（t554）", async () => {
    const { ctx } = await prepared();
    await rm(ctx.repo.dataDir, { recursive: true, force: true });
    const opts = { cwd: ctx.repo.topLevel, actor: { kind: "agent" as const, user: "eiki" } };
    const input = {
      event: "PreToolUse",
      payload: {
        session_id: SESSION,
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 5 --squash" },
        cwd: ctx.repo.topLevel,
      },
    };
    // CLI はこの失敗を標準エラーに書いて 0 で返すので、フックはツールを止めない
    await expect(openContextFor(hook, input, opts)).rejects.toThrow("初期化されていない");
  });
});

describe("手直しの Run の印と run retry-reason（ADR-018）", () => {
  const fixRuns = async (ctx: CommandContext, ticket: string) =>
    ((await runCommand(runList, ctx, { ticket })).data as RunView[]).filter(
      (r) => r.step === "fix",
    );

  it("印 step=fix の起動は、開いたままの前の手直しの Run を区切りとして閉じてから開く。別のセッションの前の手直しは interrupted で閉じる", async () => {
    const { ctx, parent } = await prepared();
    const previous = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "fix",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    const { warnings } = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a1", "deguboard: ticket=t1 step=fix\n\n直す"),
    );
    expect(warnings).toContainEqual(
      `t1: 前の手直しの Run ${previous.id} を、次の fix の Run の開始を区切りとして、push がないので開始の時刻で閉じる`,
    );
    const runs = await fixRuns(ctx, "t1");
    expect(runs.find((r) => r.id === previous.id)).toMatchObject({
      result: "success",
      running: false,
    });
    // 開いている手直しの Run はいつも 1 本
    expect(runs.filter((r) => r.running)).toHaveLength(1);

    const stale = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "fix",
        agent: "claude-code",
        session: "s-old",
      })
    ).data as Run;
    await call(ctx, "PostToolUse", launched(parent, "a2", "deguboard: ticket=t2 step=fix"));
    const runs2 = await fixRuns(ctx, "t2");
    expect(runs2.find((r) => r.id === stale.id)).toMatchObject({
      result: "interrupted",
      error: STALE_SESSION_ERROR,
    });
    expect(runs2.filter((r) => r.running)).toHaveLength(1);
  });

  it("印 step=review の起動も、開いたままの手直しの Run を区切りとして閉じてから開く。見直しを開くときは別のセッションの手直しも success で閉じる（ADR-022）", async () => {
    const { ctx, parent } = await prepared();
    const same = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "fix",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    const other = (
      await runCommand(runStart, ctx, {
        ticket: "t2",
        step: "fix",
        agent: "claude-code",
        session: "s-old",
      })
    ).data as Run;
    const { warnings } = await call(
      ctx,
      "PostToolUse",
      launched(parent, "a1", "deguboard: ticket=t1 step=review\n\n見直す"),
    );
    expect(warnings).toContainEqual(
      `t1: 前の手直しの Run ${same.id} を、次の review の Run の開始を区切りとして、push がないので開始の時刻で閉じる`,
    );
    await call(ctx, "PostToolUse", launched(parent, "a2", "deguboard: ticket=t2 step=review"));
    expect((await fixRuns(ctx, "t1"))[0]).toMatchObject({
      id: same.id,
      result: "success",
      running: false,
    });
    expect((await fixRuns(ctx, "t2"))[0]).toMatchObject({
      id: other.id,
      result: "success",
      error: null,
      running: false,
    });
    expect((await peekRunningRuns(ctx.repo)).map((r) => [r.ticket, r.step]).sort()).toEqual([
      ["t1", "review"],
      ["t2", "review"],
    ]);
  });

  it("前景の起動でかかった時間だけ前にした開始が、手直しの Run の開始より前なら閉じず、同じ秒か後なら閉じる（ADR-022）", async () => {
    const { ctx, parent, subagent } = await prepared();
    let clock = new Date("2026-11-08T01:10:00Z");
    ctx.now = () => clock;
    const fixOf = async (ticket: "t1" | "t2") =>
      (
        await runCommand(runStart, ctx, {
          ticket,
          step: "fix",
          agent: "claude-code",
          session: SESSION,
        })
      ).data as Run;
    const foreground = async (agentId: string, prompt: string, durationMs: number) => {
      await subagentRecord(subagent(agentId), prompt, 1);
      return call(ctx, "PostToolUse", {
        ...launched(parent, agentId, prompt),
        tool_response: {
          status: "completed",
          agentId,
          resolvedModel: "claude-test-1",
          totalDurationMs: durationMs,
        },
      });
    };
    // t1：01:10 に始まった手直しの後、01:20 に返った前景の見直しは 20 分かかった（開始は 01:00 で手直しより前）
    const before = await fixOf("t1");
    clock = new Date("2026-11-08T01:20:00Z");
    await foreground("a1", "deguboard: ticket=t1 step=review", 20 * 60_000);
    expect((await fixRuns(ctx, "t1"))[0]).toMatchObject({ id: before.id, running: true });
    // t2：01:20 に始まった手直しの後、01:30 に返った前景の見直しは 10 分かかった（開始は手直しと同じ 01:20）
    const sameSecond = await fixOf("t2");
    clock = new Date("2026-11-08T01:30:00Z");
    await foreground("a2", "deguboard: ticket=t2 step=review", 10 * 60_000);
    expect((await fixRuns(ctx, "t2"))[0]).toMatchObject({
      id: sameSecond.id,
      result: "success",
      finished_at: "2026-11-08T01:20:00Z",
      running: false,
    });
  });

  it("背景で起動した手直しは、run retry-reason がフックの開いた Run に理由を書き足し、回数を理由の数にする", async () => {
    const { ctx, parent } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 12 });
    await call(ctx, "PostToolUse", launched(parent, "a1", "deguboard: ticket=t1 step=fix"));
    const first = (await runCommand(runRetryReason, ctx, { ticket: "t1", reasons: ["型の誤り"] }))
      .data as Run;
    expect(first).toMatchObject({ step: "fix", retries: 1, retry_reasons: ["型の誤り"] });
    const second = (
      await runCommand(runRetryReason, ctx, { ticket: "t1", reasons: ["文書のずれ", "名前"] })
    ).data as Run;
    expect(second).toMatchObject({
      id: first.id,
      retries: 3,
      retry_reasons: ["型の誤り", "文書のずれ", "名前"],
    });
    expect(await fixRuns(ctx, "t1")).toHaveLength(1);
    // PR のないチケットでは使い方の誤り（要らない保留を残さない）
    await expect(
      runCommand(runRetryReason, ctx, { ticket: "t2", reasons: ["打ち間違い"] }),
    ).rejects.toThrow("PR がない");
  });

  it("前景で起動した手直しの理由は保留になり、フックが開いた Run に結び付く。手直し 1 回につき Run は 1 本", async () => {
    const { ctx, parent, subagent } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 12 });
    const prompt = "deguboard: ticket=t1 step=fix\n\n直す";
    await subagentRecord(subagent("a1"), prompt, 1);
    const held = await runCommand(runRetryReason, ctx, { ticket: "t1", reasons: ["型の誤り"] });
    expect(held.data).toMatchObject({ pending: true, reasons: ["型の誤り"] });
    const { view } = await call(ctx, "PostToolUse", {
      ...launched(parent, "a1", prompt),
      tool_response: {
        status: "completed",
        agentId: "a1",
        resolvedModel: "claude-test-1",
        totalDurationMs: 90_000,
      },
    });
    expect(view.done).toContainEqual(expect.stringContaining("保留のやり直しの理由"));
    const runs = await fixRuns(ctx, "t1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ retries: 1, retry_reasons: ["型の誤り"] });
  });

  it("最後の見直しより前に始まった手直しの Run（前の回の残り）には書き足さず、保留にして次の手直しの Run に結び付ける", async () => {
    const { ctx, parent, subagent } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 12 });
    let clock = new Date("2026-11-08T01:00:00Z");
    ctx.now = () => clock;
    const old = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "fix",
        agent: "claude-code",
        session: SESSION,
      })
    ).data as Run;
    // 見直しの Run は普段は開いた openRun が前の手直しを閉じるので、閉じずに開いた形（別のマシン・前の版の dg）を startRun で作る
    clock = new Date("2026-11-08T01:10:00Z");
    await startRun(ctx.repo, {
      ticket: "t1",
      step: "review",
      agent: "claude-code",
      session: SESSION,
      now: clock,
    });
    clock = new Date("2026-11-08T01:20:00Z");
    const held = await runCommand(runRetryReason, ctx, { ticket: "t1", reasons: ["次の指摘"] });
    expect(held.data).toMatchObject({ pending: true });
    expect((await peekRunningRuns(ctx.repo)).find((r) => r.id === old.id)).toMatchObject({
      retry_reasons: [],
    });
    // 手直しの起動（背景）が前の回を閉じて開き、止まるときに保留の理由を結び付ける
    const prompt = "deguboard: ticket=t1 step=fix";
    await call(ctx, "PostToolUse", launched(parent, "a1", prompt));
    const fresh = (await peekRunningRuns(ctx.repo)).find((r) => r.step === "fix")!;
    expect(fresh.id).not.toBe(old.id);
    await subagentRecord(subagent("a1"), prompt, 1);
    await call(ctx, "SubagentStop", {
      session_id: SESSION,
      agent_id: "a1",
      agent_transcript_path: subagent("a1"),
    });
    const runs = await fixRuns(ctx, "t1");
    expect(runs.find((r) => r.id === old.id)).toMatchObject({ running: false, retry_reasons: [] });
    expect(runs.find((r) => r.id === fresh.id)).toMatchObject({ retry_reasons: ["次の指摘"] });
  });

  it("人や親が自分で直すときの ticket claim --retry-reason は今のとおり手直しの Run を開き、run retry-reason はその Run に書き足す", async () => {
    const { ctx } = await prepared();
    // PR のある自分の claim（もう一度の claim になる）を作る
    await runCommand(ticketClaim, ctx, { ticket: "t2", branch: "feat/t2", no_run: true });
    await runCommand(ticketUpdate, ctx, { ticket: "t2", pr: 9 });
    const claimed = await runCommand(ticketClaim, ctx, {
      ticket: "t2",
      agent: "claude-code",
      retry_reasons: ["親が直す"],
    });
    const runId = (claimed.data as { run: string | null }).run;
    expect(runId).not.toBeNull();
    const added = (await runCommand(runRetryReason, ctx, { ticket: "t2", reasons: ["もう 1 件"] }))
      .data as Run;
    expect(added).toMatchObject({
      id: runId,
      retry_reasons: ["親が直す", "もう 1 件"],
      retries: 2,
    });
  });
});
