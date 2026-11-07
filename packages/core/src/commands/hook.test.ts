import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import type { Run } from "../model/run.js";
import { peekRunningRuns, readTranscriptPaths } from "../run/record.js";
import { resetGhCache } from "../git/facts.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { hook, hookTiming, parseGhPr, parseMarker, writesDataDir, type HookView } from "./hook.js";
import { runList, runReviewResult, runStart, type RunView } from "./run.js";
import { commit, configSet, init, sync } from "./setup.js";
import { ticketCreate, ticketUpdate } from "./ticket.js";

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
    expect(view.done).toEqual([expect.stringContaining(`Run ${run.id} の記録の場所`)]);
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
  async function selfStarted(ctx: CommandContext, file: string, extra: (mine: Run) => unknown[]) {
    const mine = (
      await runCommand(runStart, ctx, {
        ticket: "t1",
        step: "review",
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
    expect(view.done).toEqual([expect.stringContaining(`Run ${mine.id} の記録の場所`)]);
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
    expect(view.done).toEqual([expect.stringContaining(`Run ${mine.id} の記録の場所`)]);
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

describe("PreToolUse（t532）", () => {
  it("Bash の .git/deguboard/ への書き込みだけを拒み、読むだけのコマンドは通す", () => {
    for (const c of [
      "echo x > .git/deguboard/tickets/t1.md",
      "cat a | tee -a /r/.git/deguboard/config.yaml",
      "rm -rf .git/deguboard/runs",
      "sed -i 's/a/b/' .git/deguboard/tickets/t1.md",
      "git -C .git/deguboard commit -m x",
      "cp x.md .git/deguboard/tickets/",
      "cd .git/deguboard && git commit -am x",
      "git -C .git/deguboard -c a=b commit -m x",
      "perl -pi -e 's/a/b/' .git/deguboard/x",
      'echo "a b" >> /r/.git/deguboard/config.yaml',
    ])
      expect(writesDataDir(c), c).toBe(true);
    for (const c of [
      "cat .git/deguboard/tickets/t1.md",
      "ls .git/deguboard",
      "git -C .git/deguboard log --oneline -1",
      "mise run dg -- ticket update t1 --pr 3",
      "grep -rn x .git/deguboard 2>/dev/null",
      "cp .git/deguboard/tickets/t1.md /tmp/x",
      'grep -rn "install" .git/deguboard',
    ])
      expect(writesDataDir(c), c).toBe(false);
  });

  it("gh pr merge・ready の PR の指定を読み、値を取るフラグの値と取り違えない", () => {
    expect(parseGhPr("gh pr merge 12 --squash")).toEqual({
      action: "merge",
      selector: "12",
      undo: false,
    });
    expect(parseGhPr("gh pr merge --repo o/r --squash feat/x")).toMatchObject({
      selector: "feat/x",
    });
    expect(parseGhPr("cd w && gh pr ready")).toEqual({
      action: "ready",
      selector: undefined,
      undo: false,
      dir: "w",
    });
    expect(parseGhPr("gh pr ready 3 --undo")).toMatchObject({ undo: true });
    expect(parseGhPr("gh pr view 3")).toBeUndefined();
    // 引用符の中の空白を割らず、全体のフラグを pr より前に置いても読み、前の cd を覚える
    expect(parseGhPr('gh pr merge --squash --subject "a b" 7')).toMatchObject({ selector: "7" });
    expect(parseGhPr("gh -R o/r pr merge 5")).toMatchObject({ action: "merge", selector: "5" });
    expect(parseGhPr("cd ../w && gh pr ready")).toMatchObject({ selector: undefined, dir: "../w" });
  });

  /** 偽の gh（PR はいつも見つからない）。実際の gh がテストで GitHub を読まないように */
  async function noGh(home: string) {
    const bin = path.join(home, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      '#!/bin/sh\ncase "$1" in --version) echo fake; exit 0;; esac\necho "no pull requests found" >&2; exit 1\n',
      { mode: 0o755 },
    );
    const saved = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (saved ?? "");
    resetGhCache();
    cleanups.push(async () => {
      process.env["PATH"] = saved;
      resetGhCache();
    });
  }

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

  it("gh pr merge は品質ゲートを満たさないチケットの PR を止めて理由を返し、チケットのない PR は止めない", async () => {
    const { ctx, home } = await prepared();
    await noGh(home);
    await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 5 });
    const denied = await pre(ctx, { command: "gh pr merge 5 --squash" });
    const reason = (
      JSON.parse((denied.data as HookView).output!) as {
        hookSpecificOutput: { permissionDecisionReason: string };
      }
    ).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("dg gate t1 --for merge");
    expect(reason).toContain("pr:");
    expect(reason).toContain("人に gh pr merge を打ってもらう");
    const other = await pre(ctx, { command: "gh pr merge 99 --squash" });
    expect((other.data as HookView).output).toBeUndefined();
    expect((other.data as HookView).done).toEqual([expect.stringContaining("チケットがない")]);
    // 取り消し（--undo）と、ほかの gh のコマンドは見ない
    expect((await pre(ctx, { command: "gh pr ready 5 --undo" })).data).toMatchObject({ done: [] });
    expect((await pre(ctx, { command: "gh pr view 5" })).data).toMatchObject({ done: [] });
  });
});
