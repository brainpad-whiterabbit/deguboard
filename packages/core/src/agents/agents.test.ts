import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../model/config.js";
import { waitedSeconds, type Run } from "../model/run.js";
import { claudeCodeAdapter, inSession, projectDirName } from "./adapters/claude-code.js";
import { bindFile, sightings } from "./adapters/transcript.js";
import {
  agentNames,
  collectRunUsage,
  collectRunWaits,
  detectAgent,
  type UsageQuery,
} from "./index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dg-agents-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const RUN_ID = "r20260101-100000-abcd";
// 書いたファイルの更新日時より前（started_at より前に書き終えたファイルは探さない）
const STARTED = "2026-01-01T10:00:00Z";
const FINISHED = "2026-01-01T10:30:00Z";
const at = (minutes: number) => new Date(Date.parse(STARTED) + minutes * 60_000).toISOString();

const run = (over: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  ticket: "t1",
  step: "implement",
  agent: "claude-code",
  model: null,
  started_at: STARTED,
  finished_at: null,
  result: null,
  error: null,
  retries: 0,
  retry_reasons: [],
  usage: { input: null, output: null, cache_read: null, cache_write: null },
  tools: null,
  session: null,
  review: null,
  waited_seconds: null,
  check_seconds: null,
  waiting_since: null,
  settling_since: null,
  ...over,
});

/** 偽の assistant の行。同じ id の行は同じ応答の分かれた行 */
function assistant(id: string, minutes: number, tokens: number[], model = "claude-test-1") {
  const [input, output, cacheRead, cacheWrite] = tokens;
  return {
    type: "assistant",
    timestamp: at(minutes),
    cwd: "/somewhere/else",
    message: {
      id,
      model,
      role: "assistant",
      content: [{ type: "text", text: "会話の中身" }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  };
}

/** tool_use を持つ偽の assistant の行。calls は [tool_use の id, ツールの名前] */
function toolUse(id: string, minutes: number, calls: Array<[string, string]>) {
  const line = assistant(id, minutes, [1, 1, 1, 1]);
  line.message.content = calls.map(([callId, name]) => ({
    type: "tool_use",
    id: callId,
    name,
    input: { command: "cat /home/secret/file" },
  })) as unknown as typeof line.message.content;
  return line;
}

/** Bash の tool_use を持つ偽の assistant の行。calls は [tool_use の id, コマンド]。input は Bash の入力に足す項目 */
function bash(id: string, minutes: number, calls: Array<[string, string]>, input: object = {}) {
  const line = assistant(id, minutes, [1, 1, 1, 1]);
  line.message.content = calls.map(([callId, command]) => ({
    type: "tool_use",
    id: callId,
    name: "Bash",
    input: { command, ...input },
  })) as unknown as typeof line.message.content;
  return line;
}

/** STARTED から minutes 分後の時刻（エポックからのミリ秒） */
const ms = (minutes: number) => Date.parse(at(minutes));

/** ツールの結果を持つ偽の user の行。results は [tool_use の id, 失敗の印（省けば印のない結果）] */
function toolResult(minutes: number, results: Array<[string, boolean?]>) {
  return {
    type: "user",
    timestamp: at(minutes),
    toolUseResult: { stderr: "secret-stderr" },
    message: {
      role: "user",
      content: results.map(([id, failed]) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "Exit code 1: cat /home/secret/file",
        ...(failed === undefined ? {} : { is_error: failed }),
      })),
    },
  };
}

/** Run の ID を含む行（dg run start の出力を受け取ったツールの結果） */
const mention = (minutes: number) => ({
  type: "user",
  timestamp: at(minutes),
  message: { role: "user", content: [{ type: "tool_result", content: `{"id":"${RUN_ID}"}` }] },
});

async function writeTranscript(file: string, lines: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** HOME を一時ディレクトリにした問い合わせ。作業ツリーは HOME の下の repo */
async function setup(env: Record<string, string> = {}) {
  const home = await tempDir();
  const topLevel = path.join(home, "repo");
  const projectDir = path.join(home, ".claude", "projects", projectDirName(topLevel));
  const query = (over: Partial<UsageQuery> = {}): UsageQuery => ({
    run: run(),
    finishedAt: FINISHED,
    env: { HOME: home, ...env },
    topLevel,
    ...over,
  });
  return { home, topLevel, projectDir, query };
}

describe("Claude Code の Adapter", () => {
  it("projects/ の下の名前は作業ディレクトリの英数字以外を - にしたもの", () => {
    expect(projectDirName("/home/a_b/deguboard.worktrees/feat/x")).toBe(
      "-home-a-b-deguboard-worktrees-feat-x",
    );
  });

  it("Run の ID を含む会話記録の、期間内の応答の使用量を message.id で重ねずに足す", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      assistant("m0", -5, [1000, 1000, 1000, 1000]), // 期間の前
      mention(0),
      assistant("m1", 1, [10, 20, 300, 40]),
      assistant("m1", 1, [10, 20, 300, 40]), // 同じ応答の別の行
      assistant("m2", 2, [1, 2, 30, 4], "<synthetic>"),
      "書きかけの行",
      assistant("m3", 40, [1000, 1000, 1000, 1000]), // 期間の後
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got).toEqual({
      usage: { input: 11, output: 22, cache_read: 330, cache_write: 44 },
      model: "claude-test-1",
      tools: {
        read: 0,
        search: 0,
        write: 0,
        bash: 0,
        other: 0,
        read_before_write: 0,
        search_before_write: 0,
        errors: 0,
      },
      // 数えるコマンドを渡さなければ、検査とテストの区間は数えない
      checks: null,
      warnings: [],
    });
  });

  it("数えるコマンドの前景の Bash を、呼び出しの行から結果の行までの区間にする。背後で回したコマンド・結果のない呼び出し・ほかのコマンドは入れず、コマンドの文字列は返さない", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      bash("m0", -5, [["u0", "mise run check"]]), // 期間の前の呼び出し
      toolResult(-4, [["u0"]]),
      mention(0),
      bash("m1", 1, [
        ["u1", "cd /home/secret && mise run check 2>&1 | tail -5"],
        ["u2", "git status"],
      ]),
      bash("m1", 2, [["u1", "mise run check"]]), // 同じ tool_use の別の行（最初の行の時刻を残す）
      toolResult(4, [["u1", true], ["u2"]]), // 落ちた検査も回していた時間
      toolResult(5, [["u1"]]), // 同じ結果の別の行（最初の行の時刻を残す）
      bash("m2", 6, [["u3", "mise run check"]], { run_in_background: true }),
      toolResult(6, [["u3"]]),
      toolUse("m3", 7, [["u4", "Read"]]), // Bash でない呼び出し
      toolResult(8, [["u4"]]),
      bash("m4", 9, [["u5", "mise run check"]]), // 結果のない呼び出し（中断）
      // 期間の終わりの呼び出しの結果は、finished_at の後に書かれても結ぶ（Run の範囲で切るのは閉じる側）
      bash("m5", 29, [["u6", "mise run dg -- --json gate t1 --only check"]]),
      toolResult(31, [["u6"]]),
      bash("m6", 40, [["u7", "mise run check"]]), // 期間の後
      toolResult(41, [["u7"]]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(
      query({ checkCommands: [["mise", "run", "check"]] }),
    );
    expect(got.checks).toEqual([
      { from: ms(1), to: ms(4) },
      { from: ms(29), to: ms(31) },
    ]);
    expect(got.tools).toMatchObject({ bash: 5, read: 1 });
    expect(waitedSeconds(got.checks, STARTED, FINISHED)).toBe(4 * 60);
    expect(JSON.stringify(got)).not.toContain("secret");
    expect(JSON.stringify(got)).not.toContain("mise");
  });

  it("失敗の印（is_error）のあるツールの結果を tool_use_id で重ねずに数え、断られた・hook に拒まれた呼び出しも印だけで数える。結果の文は返さない", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      toolUse("m0", -5, [["u0", "Bash"]]), // 期間の前の呼び出し
      toolResult(-4, [["u0", true]]),
      mention(0),
      toolUse("m1", 1, [
        ["u1", "Bash"],
        ["u2", "Edit"],
        ["u3", "Read"],
        ["u4", "Grep"],
      ]),
      toolResult(1, [
        ["u1", true], // 落ちたコマンド
        ["u2", true], // 当たらなかった Edit
        ["u3", false],
        ["u4"], // 印のない結果は成功
      ]),
      toolResult(1, [["u1", true]]), // 同じ結果の別の行
      toolUse("m2", 2, [
        ["u5", "Bash"],
        ["u6", "Write"],
        ["u7", "Bash"],
      ]),
      // 許可を断られた呼び出しと hook に拒まれた呼び出しは、結果の文が違うだけで同じ印を持つ
      { ...toolResult(2, [["u5", true]]), toolDenialKind: "user" },
      toolResult(2, [["u6", true]]),
      toolResult(2, [["other-run", true]]), // 数えていない呼び出しの結果
      // 期間の終わりの呼び出しの結果は、finished_at の後に書かれても数える
      toolResult(31, [["u7", true]]),
      toolUse("m3", 40, [["u8", "Bash"]]), // 期間の後
      toolResult(40, [["u8", true]]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.tools).toMatchObject({ bash: 3, write: 2, read: 1, search: 1, errors: 5 });
    // 写すのは数だけで、結果の中身（出力・コマンド・パス）は返さない（MT-4）
    const text = JSON.stringify(got);
    for (const secret of ["secret", "Exit code", "cat "]) expect(text).not.toContain(secret);
  });

  it("数えた呼び出しがあるのに結果が 1 つも見つからない会話記録では、失敗の数を 0 にせず errors を書かない", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      mention(0),
      toolUse("m1", 1, [["u1", "Bash"]]),
      // tool_result のない形の結果（失敗の印を読めない）
      { type: "user", timestamp: at(1), message: { role: "user", content: "failed" } },
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.tools).toMatchObject({ bash: 1 });
    expect(got.tools).not.toHaveProperty("errors");
  });

  it("期間内の応答の tool_use を id で重ねずに種類ごとに数え、最初に書くまでの読む・探すも数える", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      toolUse("m0", -5, [["u0", "Read"]]), // 期間の前
      mention(0),
      toolUse("m1", 1, [
        ["u1", "Grep"],
        ["u2", "Read"],
      ]),
      toolUse("m1", 1, [["u2", "Read"]]), // 同じ tool_use の別の行
      toolUse("m2", 2, [
        ["u3", "Bash"],
        ["u4", "Glob"],
      ]),
      toolUse("m3", 3, [["u5", "Edit"]]),
      toolUse("m4", 4, [
        ["u6", "Read"],
        ["u7", "Write"],
        ["u8", "Agent"],
        ["u9", "mcp__x__y"],
      ]),
      toolUse("m5", 40, [["u10", "Read"]]), // 期間の後
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.tools).toEqual({
      read: 2,
      search: 2,
      write: 2,
      bash: 1,
      other: 2,
      read_before_write: 1,
      search_before_write: 2,
    });
    // 写すのは数だけで、ツールの入力（コマンド・パス）は返さない（MT-4）
    expect(JSON.stringify(got)).not.toContain("secret");
  });

  it("書かずに終わった Run では、最初に書くまでの回数は全体の回数になる", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      mention(0),
      toolUse("m1", 1, [
        ["u1", "Read"],
        ["u2", "Grep"],
        ["u3", "Read"],
        ["u4", "Bash"],
      ]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.tools).toMatchObject({
      read: 2,
      search: 1,
      read_before_write: 2,
      search_before_write: 1,
    });
  });

  it("Run が見つからなければ、ツールの回数も null", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [toolUse("m1", 1, [["u1", "Read"]])]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.tools).toBeNull();
  });

  it("並行するエージェントの記録は Run の ID を含まないので数えず、ID を後から受け取った記録より最初に含む記録を選ぶ", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1", "subagents", "agent-a.jsonl"), [
      mention(0),
      assistant("a1", 1, [1, 2, 3, 4]),
    ]);
    // 同じ時間帯の別のエージェント
    await writeTranscript(path.join(projectDir, "s1", "subagents", "agent-b.jsonl"), [
      assistant("b1", 1, [100, 200, 300, 400]),
    ]);
    // 報告で ID を後から受け取った親
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      assistant("p1", 1, [50, 50, 50, 50]),
      mention(20),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
  });

  describe("同じ会話記録で期間が重なる Run", () => {
    // A（RUN_ID、10:00 開始）を開いたまま、同じ会話で B（10:10 開始）を始めた記録
    const B = "r20260101-101000-beef";
    const B_STARTED = at(10).replace(".000", "");
    const mentionOf = (id: string, minutes: number) => ({
      type: "user",
      timestamp: at(minutes),
      message: { role: "user", content: [{ type: "tool_result", content: `{"id":"${id}"}` }] },
    });
    const lines = [
      mention(0),
      assistant("m1", 5, [1, 1, 1, 1]),
      mentionOf(B, 10),
      assistant("m2", 12, [10, 10, 10, 10]),
      assistant("m3", 25, [100, 100, 100, 100]),
    ];
    const runB = (finished: string | null) =>
      run({ id: B, started_at: B_STARTED, finished_at: finished });
    const spans = (entries: Array<[string, string, string | null]>) =>
      new Map(entries.map(([id, started_at, finished_at]) => [id, { started_at, finished_at }]));

    it("先に閉じた側（A）は B の ID の後の応答を数えず、後に閉じた側（B）は A と重ならずに数える", async () => {
      const { projectDir, query } = await setup();
      await writeTranscript(path.join(projectDir, "s1.jsonl"), lines);
      // A を 10:20 に閉じる。B は実行中
      const a = await claudeCodeAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others: spans([[B, B_STARTED, null]]) }),
      );
      // B を 10:30 に閉じる。A は 10:20 に閉じている
      const b = await claudeCodeAdapter.readTranscriptUsage(
        query({
          run: runB(null),
          finishedAt: FINISHED,
          others: spans([[RUN_ID, STARTED, at(20)]]),
        }),
      );
      expect(a.usage.output).toBe(1);
      expect(b.usage.output).toBe(110);
    });

    it("後に始めた B を先に閉じても、A は B の期間の応答だけを数えず、B が閉じた後の応答は数える", async () => {
      const { projectDir, query } = await setup();
      await writeTranscript(path.join(projectDir, "s1.jsonl"), lines);
      // B を 10:15 に閉じる。A は実行中
      const b = await claudeCodeAdapter.readTranscriptUsage(
        query({ run: runB(null), finishedAt: at(15), others: spans([[RUN_ID, STARTED, null]]) }),
      );
      // A を 10:30 に閉じる。B は 10:15 に閉じている
      const a = await claudeCodeAdapter.readTranscriptUsage(
        query({ others: spans([[B, B_STARTED, at(15)]]) }),
      );
      expect(b.usage.output).toBe(10);
      expect(a.usage.output).toBe(101);
    });

    it("ほかの Run の期間を渡さなければ分けず、開始から 1 分より後に ID を見ただけの Run には譲らない", async () => {
      const { projectDir, query } = await setup();
      await writeTranscript(path.join(projectDir, "s1.jsonl"), lines);
      const alone = await claudeCodeAdapter.readTranscriptUsage(query());
      expect(alone.usage.output).toBe(111);
      // B を 10:08 に始めた（ほかの会話で）。この記録は 10:10 に一覧などで ID を見ただけ
      const seen = await claudeCodeAdapter.readTranscriptUsage(
        query({ others: spans([[B, at(8).replace(".000", ""), null]]) }),
      );
      expect(seen.usage.output).toBe(111);
    });

    it("期間の応答をすべて後に始めた Run に譲ったら、使用量は null でなく 0 にする", async () => {
      const { projectDir, query } = await setup();
      // 1 つの見直し役が A と B をほぼ同時に始めた
      await writeTranscript(path.join(projectDir, "s1.jsonl"), [
        mention(0),
        mentionOf(B, 0),
        assistant("m1", 12, [10, 10, 10, 10]),
      ]);
      const got = await claudeCodeAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others: spans([[B, at(0).replace(".000", ""), at(20)]]) }),
      );
      expect(got.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
      expect(got.model).toBeNull();
      expect(got.warnings).toEqual([]);
    });

    it("別のファイルで始まった Run の ID を 1 分以内に表示しただけでは、その Run に譲らない", async () => {
      const { projectDir, query } = await setup();
      // B は s2 で 10:10 に始めた。s1 は 10:10:30 に一覧などで B の ID を見ただけ
      await writeTranscript(path.join(projectDir, "s1.jsonl"), [
        mention(0),
        assistant("m1", 5, [1, 1, 1, 1]),
        mentionOf(B, 10.5),
        assistant("m2", 12, [10, 10, 10, 10]),
      ]);
      await writeTranscript(path.join(projectDir, "s2.jsonl"), [
        mentionOf(B, 10),
        assistant("n1", 12, [1000, 1000, 1000, 1000]),
      ]);
      const got = await claudeCodeAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others: spans([[B, B_STARTED, null]]) }),
      );
      expect(got.usage.output).toBe(11);
    });

    it("session のファイルで Run が見つかっても、別の session で始まった Run の ID を見ただけでは譲らない", async () => {
      // A は session sa、B は別の session sb で始めた。sa は 10:10:30 に B の ID を見ただけ
      const { projectDir, query } = await setup({ CLAUDE_CODE_SESSION_ID: "sa" });
      await writeTranscript(path.join(projectDir, "sa.jsonl"), [
        mention(0),
        assistant("m1", 5, [1, 1, 1, 1]),
        mentionOf(B, 10.5),
        assistant("m2", 12, [10, 10, 10, 10]),
      ]);
      await writeTranscript(path.join(projectDir, "sb.jsonl"), [
        mentionOf(B, 10),
        assistant("n1", 12, [1000, 1000, 1000, 1000]),
      ]);
      const got = await claudeCodeAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others: spans([[B, B_STARTED, null]]) }),
      );
      expect(got.usage.output).toBe(11);
    });

    it("ほかの agent の Run には、同じファイルで 1 分以内に ID が出ても譲らない", async () => {
      const { projectDir, query } = await setup();
      await writeTranscript(path.join(projectDir, "s1.jsonl"), lines);
      const others = new Map([[B, { started_at: B_STARTED, finished_at: null, agent: "codex" }]]);
      const got = await claudeCodeAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others }),
      );
      expect(got.usage.output).toBe(11);
    });

    it("探す範囲の外（別の worktree）の会話記録で始まった Run の ID を 1 分以内に表示しただけでは、その Run に譲らない", async () => {
      const { home, projectDir, query } = await setup();
      // A は s1、B は別の worktree の projects ディレクトリの s2 で始めた。s1 は 10:10:30 に B の ID を見ただけ
      await writeTranscript(path.join(projectDir, "s1.jsonl"), [
        mention(0),
        assistant("m1", 5, [1, 1, 1, 1]),
        mentionOf(B, 10.5),
        assistant("m2", 12, [10, 10, 10, 10]),
      ]);
      const otherDir = path.join(
        home,
        ".claude",
        "projects",
        projectDirName(path.join(home, "repo.worktrees", "other")),
      );
      await writeTranscript(path.join(otherDir, "s2.jsonl"), [
        mentionOf(B, 10),
        assistant("n1", 12, [1000, 1000, 1000, 1000]),
      ]);
      // finish（A の session）でも refresh（別の session・session なし）でも同じ値になる
      for (const env of [{ CLAUDE_CODE_SESSION_ID: "s1" }, { CLAUDE_CODE_SESSION_ID: "x" }, {}]) {
        const q = query({ finishedAt: at(20), others: spans([[B, B_STARTED, null]]) });
        const got = await claudeCodeAdapter.readTranscriptUsage({
          ...q,
          env: { ...q.env, ...env },
        });
        expect(got.usage.output).toBe(11);
      }
    });

    it("同じファイルで始めた 2 本は片方だけに数え、別のファイルで始まった Run の ID を見ても両方を 0 にしない", async () => {
      const { projectDir, query } = await setup();
      // 1 つの見直し役が s1 で A（10:10:00）と C（10:10:01）を始め（出力に ID は出ない）、10:10:09 の一覧で
      // A・C と、s2 で 10:10:03 に始めた D の ID を見た
      const A_STARTED = "2026-01-01T10:10:00Z";
      const C = "r20260101-101001-cafe";
      const D = "r20260101-101003-dead";
      const sec = (s: number) => 10 + s / 60;
      await writeTranscript(path.join(projectDir, "s1.jsonl"), [
        {
          type: "user",
          timestamp: at(sec(9)),
          message: {
            role: "user",
            content: [{ type: "tool_result", content: `${RUN_ID} ${C} ${D}` }],
          },
        },
        assistant("m1", 12, [10, 10, 10, 10]),
      ]);
      await writeTranscript(path.join(projectDir, "s2.jsonl"), [
        mentionOf(D, sec(4)),
        assistant("n1", 12, [1000, 1000, 1000, 1000]),
      ]);
      const all: Array<[string, string, string | null]> = [
        [RUN_ID, A_STARTED, at(20)],
        [C, "2026-01-01T10:10:01Z", at(20)],
        [D, "2026-01-01T10:10:03Z", null],
      ];
      const others = (self: string) => spans(all.filter(([id]) => id !== self));
      const a = await claudeCodeAdapter.readTranscriptUsage(
        query({
          run: run({ started_at: A_STARTED }),
          finishedAt: at(20),
          others: others(RUN_ID),
        }),
      );
      const c = await claudeCodeAdapter.readTranscriptUsage(
        query({
          run: run({ id: C, started_at: "2026-01-01T10:10:01Z" }),
          finishedAt: at(20),
          others: others(C),
        }),
      );
      expect(a.usage.output).toBe(0);
      expect(c.usage.output).toBe(10);
    });
  });

  it("主の作業ツリーで始めたセッションの記録も探す", async () => {
    const { home, query } = await setup();
    const main = path.join(home, "main");
    const dir = path.join(home, ".claude", "projects", projectDirName(main));
    await writeTranscript(path.join(dir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [1, 1, 1, 1]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(
      query({
        topLevel: path.join(home, "main.worktrees", "feat"),
      }),
    );
    expect(got.usage.input).toBe(1);
  });

  it("CLAUDE_CONFIG_DIR があればそこを探し、session の環境によらず Run の ID が最も早く出たファイルを選ぶ", async () => {
    const { home, query } = await setup();
    const config = path.join(home, "other-config");
    const dir = path.join(config, "projects", "-anywhere");
    await writeTranscript(path.join(dir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [5, 5, 5, 5]),
    ]);
    await writeTranscript(path.join(dir, "s2.jsonl"), [
      mention(-1),
      assistant("m2", 1, [9, 9, 9, 9]),
    ]);
    for (const session of [
      { CLAUDE_CODE_SESSION_ID: "s1" },
      { CLAUDE_CODE_SESSION_ID: "s2" },
      {},
    ]) {
      const env = { HOME: home, CLAUDE_CONFIG_DIR: config, ...session };
      const got = await claudeCodeAdapter.readTranscriptUsage(query({ env }));
      expect(got.usage.input).toBe(9);
    }
  });

  it("ID が出た時刻が同じなら、呼ぶ session によらずファイルのパスの順で選ぶ", async () => {
    const { projectDir, query, home } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [5, 5, 5, 5]),
    ]);
    await writeTranscript(path.join(projectDir, "s2", "subagents", "agent-a.jsonl"), [
      mention(0),
      assistant("m2", 1, [9, 9, 9, 9]),
    ]);
    // パスの順では s1.jsonl が先。どの session から呼んでも同じ（s2 の session から呼んでも s1 を選ぶ）
    for (const session of ["s1", "s2", undefined]) {
      const env =
        session === undefined ? { HOME: home } : { HOME: home, CLAUDE_CODE_SESSION_ID: session };
      const got = await claudeCodeAdapter.readTranscriptUsage(query({ env }));
      expect(got.usage.input).toBe(5);
    }
  });

  it("bindFile は同じ時刻のとき、files の順によらずパスの辞書順で小さい方を選ぶ", async () => {
    const { projectDir, query } = await setup();
    const small = path.join(projectDir, "a.jsonl");
    const large = path.join(projectDir, "b.jsonl");
    await writeTranscript(small, [mention(0)]);
    await writeTranscript(large, [mention(0)]);
    const to = Date.parse(FINISHED) + 999;
    // 大きい方を先に渡しても、小さい方を選ぶ（readdir の順に頼らない）
    expect((await bindFile(query(), [large, small], to, [])).file).toBe(small);
    expect((await bindFile(query(), [small, large], to, [])).file).toBe(small);
  });

  it("HOME など作業ツリーに当たらないディレクトリのセッションでも、Run の ID が最も早く出た記録に結び付ける", async () => {
    const { home, query } = await setup();
    const dir = path.join(home, ".claude", "projects", projectDirName(home));
    await writeTranscript(path.join(dir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [1, 1, 1, 1]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.usage.input).toBe(1);
  });

  it("run start の警告で ID を見ただけの別の session のファイルには、その session の環境から呼んでも結び付けない", async () => {
    const { home, projectDir, query } = await setup();
    // A（RUN_ID）は session sa の親で 10:00 に始めた
    await writeTranscript(path.join(projectDir, "sa.jsonl"), [
      mention(0),
      assistant("m1", 2, [3, 3, 3, 3]),
    ]);
    // 別の session sb のサブエージェントが 10:00:50 に X を run start し、その警告に開いたままの A の ID が載った
    const X = "r20260101-100050-feed";
    const X_STARTED = "2026-01-01T10:00:50Z";
    await writeTranscript(
      path.join(home, ".claude", "projects", "-elsewhere", "sb", "subagents", "agent-x.jsonl"),
      [
        {
          type: "user",
          timestamp: at(50 / 60),
          message: {
            role: "user",
            content: [{ type: "tool_result", content: `{"id":"${X}","warnings":["${RUN_ID}"]}` }],
          },
        },
        assistant("x1", 2, [700, 700, 700, 700]),
      ],
    );
    const others = new Map([[X, { started_at: X_STARTED, finished_at: null }]]);
    for (const env of [{ CLAUDE_CODE_SESSION_ID: "sb" }, { CLAUDE_CODE_SESSION_ID: "sa" }, {}]) {
      const q = query({ finishedAt: at(20), others });
      const got = await claudeCodeAdapter.readTranscriptUsage({ ...q, env: { ...q.env, ...env } });
      expect(got.usage).toEqual({ input: 3, output: 3, cache_read: 3, cache_write: 3 });
    }
  });

  it("ID を探す読み取りは、行の timestamp がすべて上限を過ぎたところでやめ、timestamp のない行ではやめない", async () => {
    const { projectDir } = await setup();
    const file = path.join(projectDir, "s1.jsonl");
    const B = "r20260101-101000-beef";
    await writeTranscript(file, [
      { type: "summary", text: RUN_ID },
      mention(5),
      { type: "user", timestamp: at(40), message: { content: "上限を過ぎた行" } },
      { type: "user", timestamp: at(41), message: { content: B } },
    ]);
    const seen = await sightings(file, [RUN_ID, B], Date.parse(at(30)));
    // timestamp のない行の ID は時刻が分からないので Infinity
    expect(seen).toEqual(new Map([[RUN_ID, Infinity]]));
    const all = await sightings(file, [B], Date.parse(at(50)));
    expect(all).toEqual(new Map([[B, Date.parse(at(41))]]));
  });

  it("呼ぶ session の ID が不正な形でも、その session に Run がなくても、ほかの記録から探す", async () => {
    const { projectDir, query, home } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [7, 7, 7, 7]),
    ]);
    await writeTranscript(path.join(home, ".claude", "projects", "-x", "s9.jsonl"), [
      assistant("o1", 1, [100, 100, 100, 100]),
    ]);
    for (const session of ["../s1", "s9"]) {
      const got = await claudeCodeAdapter.readTranscriptUsage(
        query({ env: { HOME: home, CLAUDE_CODE_SESSION_ID: session } }),
      );
      expect(got.usage.input).toBe(7);
    }
  });

  it("ID が期間の後に出るだけのファイルは選ばず（閉じた後の run refresh）、ほかの記録に結び付ける", async () => {
    const { projectDir, query, home } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [7, 7, 7, 7]),
    ]);
    // 閉じた後に別のセッションで run refresh を呼び、その出力に ID が載った
    await writeTranscript(path.join(home, ".claude", "projects", "-x", "now.jsonl"), [
      assistant("n0", 50, [100, 100, 100, 100]),
      mention(60),
      assistant("n1", 61, [100, 100, 100, 100]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(
      query({ env: { HOME: home, CLAUDE_CODE_SESSION_ID: "now" }, finishedAt: FINISHED }),
    );
    expect(got.warnings).toEqual([]);
    expect(got.usage).toEqual({ input: 7, output: 7, cache_read: 7, cache_write: 7 });
  });

  it("更新日時が started_at より古いファイルは探さない", async () => {
    const { projectDir, query } = await setup();
    const file = path.join(projectDir, "s1.jsonl");
    await writeTranscript(file, [mention(0), assistant("m1", 1, [1, 1, 1, 1])]);
    const old = new Date(Date.parse(STARTED) - 60_000);
    await utimes(file, old, old);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.warnings).toEqual([expect.stringContaining("not found")]);
  });

  it("Run の ID が出る前の行と、subagents/ の外のサブエージェントの行（isSidechain）は数えない", async () => {
    const { projectDir, query } = await setup();
    const side = { ...assistant("x1", 2, [100, 100, 100, 100]), isSidechain: true };
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      assistant("b1", 0.5, [1000, 1000, 1000, 1000]),
      mention(1),
      assistant("m1", 2, [1, 2, 3, 4]),
      side,
    ]);
    // subagents/ のファイルは行がすべて isSidechain なので数える
    await writeTranscript(path.join(projectDir, "s2", "subagents", "agent-a.jsonl"), [
      { ...mention(0), isSidechain: true },
      side,
    ]);
    const parent = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(parent.usage).toEqual({ input: 100, output: 100, cache_read: 100, cache_write: 100 });
    await rm(path.join(projectDir, "s2"), { recursive: true });
    const only = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(only.usage).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
  });

  it("Run の ID を含む記録がなければ、値を null にして警告する", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [assistant("m1", 1, [1, 1, 1, 1])]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: null, output: null, cache_read: null, cache_write: null });
    expect(got.warnings).toEqual([expect.stringContaining("not found")]);
  });

  describe("会話記録の場所（MT-2）", () => {
    const usageOf = async (q: UsageQuery) =>
      (await claudeCodeAdapter.readTranscriptUsage(q)).usage.input;

    it("場所がサブエージェントの記録なら、Run の ID の出現を待たずにファイルの先頭から finished_at まで数える", async () => {
      const { projectDir, query } = await setup();
      const file = path.join(projectDir, "s1", "subagents", "agent-a.jsonl");
      // 見直しを終えた後に run start した見直し役：ID は最後に出る
      await writeTranscript(file, [
        assistant("m1", -10, [100, 1, 1, 1]),
        assistant("m2", 5, [10, 1, 1, 1]),
        mention(20),
        assistant("m3", 40, [1000, 1, 1, 1]), // 期間の後
      ]);
      expect(await usageOf(query({ transcript: file }))).toBe(110);
      // 場所がなければ今の推測（ID が出た後の期間の応答）。ID の後に期間の応答はない
      const guessed = await claudeCodeAdapter.readTranscriptUsage(query());
      expect(guessed.usage.input).toBeNull();
    });

    it("場所が親のセッションの記録なら、ほかの Run と共有するので started_at から数える", async () => {
      const { projectDir, query } = await setup();
      const file = path.join(projectDir, "s1.jsonl");
      await writeTranscript(file, [
        assistant("m0", -5, [1000, 1, 1, 1]), // 開始の前（前の Run の分）
        assistant("m1", 1, [10, 1, 1, 1]),
        assistant("m2", 2, [1, 1, 1, 1]),
      ]);
      expect(await usageOf(query({ transcript: file }))).toBe(11);
    });

    it("同じサブエージェントの記録を先に使って閉じた Run があれば、その finished_at の後から数える", async () => {
      const { projectDir, query } = await setup();
      const file = path.join(projectDir, "s1", "subagents", "agent-a.jsonl");
      await writeTranscript(file, [
        assistant("m1", -20, [100, 1, 1, 1]), // 実装の Run の分
        assistant("m2", 1, [10, 1, 1, 1]), // 続けて頼まれた手直し
      ]);
      const others = new Map([
        [
          "r20260101-093000-0001",
          {
            started_at: at(-30),
            finished_at: at(-10),
            agent: "claude-code",
            transcript: file,
          },
        ],
        // 別のファイルの Run は境目にしない
        [
          "r20260101-093000-0002",
          {
            started_at: at(-30),
            finished_at: at(-1),
            agent: "claude-code",
            transcript: path.join(projectDir, "s2.jsonl"),
          },
        ],
      ]);
      expect(await usageOf(query({ transcript: file, others }))).toBe(10);
    });

    it("同じサブエージェントの記録を先に使った Run が開いたままか開始の後に閉じたなら、この Run の started_at から数える", async () => {
      const { projectDir, query } = await setup();
      const file = path.join(projectDir, "s1", "subagents", "agent-a.jsonl");
      await writeTranscript(file, [
        assistant("m1", -20, [100, 1, 1, 1]), // 前の Run の分
        assistant("m2", 1, [10, 1, 1, 1]),
      ]);
      const earlier = (finished_at: string | null) =>
        new Map([
          [
            "r20260101-093000-0001",
            { started_at: at(-30), finished_at, agent: "claude-code", transcript: file },
          ],
        ]);
      expect(await usageOf(query({ transcript: file, others: earlier(null) }))).toBe(10);
      expect(await usageOf(query({ transcript: file, others: earlier(at(5)) }))).toBe(10);
    });

    it("サブエージェントの記録かは subagents/ の直下かで決め、途中のディレクトリの同じ名前では決めない", async () => {
      const { home, query } = await setup();
      // 設定のディレクトリが subagents という名前の下にあっても、親のセッションの記録は started_at から
      const file = path.join(home, "subagents", ".claude", "projects", "d", "s1.jsonl");
      await writeTranscript(file, [
        assistant("m0", -5, [1000, 1, 1, 1]),
        assistant("m1", 1, [10, 1, 1, 1]),
      ]);
      expect(await usageOf(query({ transcript: file }))).toBe(10);
    });

    it("場所のファイルを読めなければ（別のマシンの記録）、推測に落とさず null にしてパスを書かずに警告する", async () => {
      const { projectDir, query } = await setup();
      // 推測なら見つかる記録があっても使わない
      await writeTranscript(path.join(projectDir, "s1.jsonl"), [
        mention(0),
        assistant("m1", 1, [10, 1, 1, 1]),
      ]);
      const missing = path.join(projectDir, "gone", "subagents", "agent-x.jsonl");
      const got = await claudeCodeAdapter.readTranscriptUsage(query({ transcript: missing }));
      expect(got.usage.input).toBeNull();
      expect(got.warnings).toEqual([expect.stringContaining("Cannot read the file")]);
      expect(got.warnings[0]).not.toContain(projectDir);
    });

    it("場所がなくセッション ID があれば、そのセッションの記録だけから推測する", async () => {
      const { projectDir, query } = await setup();
      // ほかのセッションの記録には ID が先に出ていても選ばない
      await writeTranscript(path.join(projectDir, "other.jsonl"), [
        mention(0),
        assistant("m0", 1, [1000, 1, 1, 1]),
      ]);
      await writeTranscript(path.join(projectDir, "s1", "subagents", "agent-a.jsonl"), [
        mention(1),
        assistant("m1", 2, [10, 1, 1, 1]),
      ]);
      expect(await usageOf(query({ run: run({ session: "s1" }) }))).toBe(10);
    });

    it("セッション ID の記録がこのマシンになければ、null にして警告する", async () => {
      const { projectDir, query } = await setup();
      await writeTranscript(path.join(projectDir, "other.jsonl"), [
        mention(0),
        assistant("m0", 1, [10, 1, 1, 1]),
      ]);
      const got = await claudeCodeAdapter.readTranscriptUsage(
        query({ run: run({ session: "s9" }) }),
      );
      expect(got.usage.input).toBeNull();
      expect(got.warnings).toEqual([expect.stringContaining("another machine")]);
    });

    it("セッションの記録は <session>.jsonl と <session>/subagents/ の下", () => {
      const p = (...parts: string[]) => path.join("/h", ".claude", "projects", "d", ...parts);
      expect(inSession(p("s1.jsonl"), "s1")).toBe(true);
      expect(inSession(p("s1", "subagents", "agent-a.jsonl"), "s1")).toBe(true);
      expect(inSession(p("s10.jsonl"), "s1")).toBe(false);
      expect(inSession(p("s2", "subagents", "agent-a.jsonl"), "s1")).toBe(false);
    });
  });

  describe("待ちの区間（RN-1。t958）", () => {
    /** 入力の行（tool_result を持たない user の行）。origin を省けば origin のない入力（最初の依頼・harness の催促） */
    const input = (minutes: number, origin?: unknown, content: unknown = "入力の文") => ({
      type: "user",
      timestamp: at(minutes),
      ...(origin === undefined ? {} : { origin }),
      message: { role: "user", content },
    });
    const coordinator = { kind: "coordinator" };
    const waitsOf = async (lines: unknown[], over: Partial<UsageQuery> = {}) => {
      const { projectDir, query } = await setup();
      const file = path.join(projectDir, "s1", "subagents", "agent-a.jsonl");
      await writeTranscript(file, lines);
      return claudeCodeAdapter.readTranscriptWaits!(query({ transcript: file, ...over }));
    };
    const span = (from: number, to: number) => ({
      from: Date.parse(at(from)),
      to: Date.parse(at(to)),
    });

    it("親の依頼（origin.kind が coordinator）で続いた空きだけを、前の行の時刻から入力の時刻までの待ちにする", async () => {
      const got = await waitsOf([
        input(0),
        toolUse("m1", 1, [["u1", "Bash"]]),
        toolResult(2, [["u1"]]),
        assistant("m2", 3, [1, 1, 1, 1]), // ターンの終わり
        input(10, coordinator), // 親が続きを頼んだ：3 分〜10 分が待ち
        assistant("m3", 11, [1, 1, 1, 1]),
        input(20, coordinator), // 2 回目の待ち：11 分〜20 分
        assistant("m4", 21, [1, 1, 1, 1]),
      ]);
      expect(got).toEqual({ intervals: [span(3, 10), span(11, 20)], warnings: [] });
    });

    it("ほかの入力（origin のない催促・バックグラウンドのコマンドの通知・人・ほかのエージェント）で続いた空きと、ツールの結果を待つ間は作業にする", async () => {
      const got = await waitsOf([
        input(0),
        toolUse("m1", 1, [["u1", "Bash"]]),
        toolResult(9, [["u1"]]), // 8 分かかったコマンドの結果を待つ間
        assistant("m2", 10, [1, 1, 1, 1]),
        input(15, undefined), // harness の催促
        assistant("m3", 16, [1, 1, 1, 1]),
        input(20, { kind: "task-notification", producer: "session-task" }),
        assistant("m4", 21, [1, 1, 1, 1]),
        input(24, { kind: "human" }),
        input(26, { kind: "peer", from: "a1", body: "報告の文" }),
        // 文字列でなく text のブロックで来る入力も、origin で見分ける
        input(28, undefined, [{ type: "text", text: "入力の文" }]),
      ]);
      expect(got).toEqual({ intervals: [], warnings: [] });
    });

    it("結果の返っていない tool_use が残っている間に来た親の依頼までの空きは作業にし、その後の待ちは数える", async () => {
      const got = await waitsOf([
        input(0),
        toolUse("m1", 1, [["u1", "Edit"]]), // 結果が返らないまま
        input(5, coordinator),
        assistant("m2", 6, [1, 1, 1, 1]),
        input(9, coordinator), // 返らなかった呼び出しは、次の入力からは待たない
      ]);
      expect(got.intervals).toEqual([span(6, 9)]);
    });

    it("知らない形の入力（知らない origin.kind・物でない origin・文字列でも配列でもない content）が 1 つでもあれば、推し量らずに null にして警告する", async () => {
      const waited = [assistant("m1", 1, [1, 1, 1, 1]), input(5, coordinator)];
      for (const unknown of [
        input(8, { kind: "scheduler" }),
        input(8, { producer: "session-task" }),
        input(8, "coordinator"),
        input(8, coordinator, { text: "入力の文" }),
        { type: "user", timestamp: at(8), origin: coordinator },
      ]) {
        const got = await waitsOf([input(0), ...waited, unknown]);
        expect(got.intervals).toBeNull();
        expect(got.warnings).toEqual([expect.stringContaining("unknown form")]);
        expect(got.warnings[0]).toContain(RUN_ID);
        // 入力の文も origin の値も警告に書かない（MT-4）
        expect(got.warnings[0]).not.toMatch(/入力の文|scheduler/);
      }
    });

    it("Run の終わりをまたぐ待ちは区間にし（切るのは閉じる側）、終わりを過ぎた行を 1 つ読んだ後は読まない（その後の知らない形の入力で null にしない）", async () => {
      const got = await waitsOf([
        input(0),
        assistant("m1", 1, [1, 1, 1, 1]),
        input(5, coordinator),
        assistant("m2", 25, [1, 1, 1, 1]),
        input(45, coordinator), // 終わり（30 分）をまたぐ待ち
        assistant("m3", 46, [1, 1, 1, 1]),
        input(50, { kind: "scheduler" }),
        input(60, coordinator),
      ]);
      expect(got).toEqual({ intervals: [span(1, 5), span(25, 45)], warnings: [] });
    });

    it("user・assistant のほかの行と、時刻のない行は、待ちの始まりにも終わりにもしない", async () => {
      const got = await waitsOf([
        input(0),
        assistant("m1", 1, [1, 1, 1, 1]),
        { type: "attachment", timestamp: at(2), attachment: { type: "user" } },
        { type: "api-request", timestamp: at(3), params: { role: "assistant" } },
        { type: "user", message: { role: "user", content: "時刻のない入力" }, origin: coordinator },
        input(5, coordinator),
      ]);
      expect(got.intervals).toEqual([span(1, 5)]);
    });

    it("親のセッションの記録と、場所のない Run（親が自分で開いた Run）は、警告なしで null にする", async () => {
      const { projectDir, query } = await setup();
      const file = path.join(projectDir, "s1.jsonl");
      await writeTranscript(file, [assistant("m1", 1, [1, 1, 1, 1]), input(5, coordinator)]);
      const none = { intervals: null, warnings: [] };
      expect(await claudeCodeAdapter.readTranscriptWaits!(query({ transcript: file }))).toEqual(
        none,
      );
      expect(await claudeCodeAdapter.readTranscriptWaits!(query())).toEqual(none);
    });

    it("場所のファイルを読めなければ null にする（警告は使用量の取り込みが同じ理由で出すので重ねない）", async () => {
      const { projectDir, query } = await setup();
      const missing = path.join(projectDir, "gone", "subagents", "agent-x.jsonl");
      const got = await claudeCodeAdapter.readTranscriptWaits!(query({ transcript: missing }));
      expect(got).toEqual({ intervals: null, warnings: [] });
    });

    it("t929 の手直しの記録の形：報告を返してから親の依頼が入るまでの 4h04m25s が待ちで、催促と通知で続いた空きは入らない", async () => {
      /** t929 の手直しの Run（r20261114-222048-c4ad）の記録の、行の種類・時刻・origin だけを写したもの */
      const stamped = (line: object, timestamp: string) => ({ ...line, timestamp });
      const got = await waitsOf(
        [
          stamped(input(0), "2026-11-14T22:20:47.402Z"),
          stamped(toolUse("m1", 0, [["u1", "Bash"]]), "2026-11-14T22:22:37.763Z"),
          stamped(toolResult(0, [["u1"]]), "2026-11-14T22:23:05.278Z"),
          stamped(assistant("m2", 0, [1, 1, 1, 1]), "2026-11-14T22:23:17.375Z"),
          // 報告を返していないことの harness の催促
          stamped({ ...input(0), isMeta: true }, "2026-11-14T22:23:17.391Z"),
          // 報告を返す呼び出しとその結果。ここでターンが終わる
          stamped(toolUse("m3", 0, [["u2", "SubagentHandback"]]), "2026-11-14T22:23:23.751Z"),
          stamped(toolResult(0, [["u2"]]), "2026-11-14T22:23:23.863Z"),
          // 親が人に質問している間。人の答えを受けて、親が続きを頼んだ
          stamped({ ...input(0, coordinator), isMeta: true }, "2026-11-15T02:27:49.060Z"),
          stamped(toolUse("m4", 0, [["u3", "Bash"]]), "2026-11-15T02:27:53.097Z"),
          stamped(toolResult(0, [["u3"]]), "2026-11-15T02:27:53.354Z"),
          // バックグラウンドのコマンドの通知
          stamped(
            input(0, { kind: "task-notification", producer: "session-task" }),
            "2026-11-15T02:30:31.757Z",
          ),
          stamped(toolUse("m5", 0, [["u4", "Bash"]]), "2026-11-15T02:30:42.315Z"),
          stamped(toolResult(0, [["u4"]]), "2026-11-15T02:30:43.045Z"),
        ],
        {
          run: run({ id: "r20261114-222048-c4ad", started_at: "2026-11-14T22:20:48Z" }),
          finishedAt: "2026-11-15T02:30:44Z",
        },
      );
      expect(got.warnings).toEqual([]);
      expect(got.intervals).toEqual([
        {
          from: Date.parse("2026-11-14T22:23:23.863Z"),
          to: Date.parse("2026-11-15T02:27:49.060Z"),
        },
      ]);
      // 閉じる側が範囲で切って足す値（4h04m25s）。経過時間は 4h09m56s のままで、作業は 5m31s
      const waited = waitedSeconds(got.intervals, "2026-11-14T22:20:48Z", "2026-11-15T02:30:44Z");
      expect(waited).toBe(4 * 3600 + 4 * 60 + 25);
      expect(4 * 3600 + 9 * 60 + 56 - waited!).toBe(5 * 60 + 31);
    });
  });
});

describe("待った秒数（waitedSeconds。RN-1）", () => {
  it("区間を started_at から finished_at の範囲で切って足し、秒に丸める", () => {
    const intervals = [
      { from: ms(-10), to: ms(2) }, // 開始の前から（同じ記録を先に使った Run の待ち）：2 分だけ
      { from: ms(5), to: ms(6) + 400 }, // 60.4 秒
      { from: ms(25), to: ms(45) }, // 終了の後まで：5 分だけ
      { from: ms(50), to: ms(60) }, // 範囲の外
    ];
    expect(waitedSeconds(intervals, STARTED, FINISHED)).toBe(120 + 60 + 300);
  });

  it("重なる区間は二重に数えず、実行時間を超えない", () => {
    const intervals = [
      { from: ms(-5), to: ms(20) },
      { from: ms(10), to: ms(40) },
    ];
    expect(waitedSeconds(intervals, STARTED, FINISHED)).toBe(30 * 60);
  });

  it("区間が 0 個なら 0（待たなかった）、数えられていなければ（null）0 でなく null", () => {
    expect(waitedSeconds([], STARTED, FINISHED)).toBe(0);
    expect(waitedSeconds(null, STARTED, FINISHED)).toBeNull();
    expect(waitedSeconds([{ from: ms(1), to: ms(2) }], "いつか", FINISHED)).toBeNull();
  });
});

describe("待ちの取り込み（RN-1）", () => {
  const config = (read: boolean) => ({ metrics: { read_transcripts: read } });
  const none = { intervals: null, warnings: [] };

  it("待ちを数えない Adapter・Adapter のない agent・読む許可のないときは、警告なしで null にする", async () => {
    const { query } = await setup();
    const spy = vi.spyOn(claudeCodeAdapter, "readTranscriptWaits");
    for (const agent of ["codex", "copilot", "someone"])
      expect(await collectRunWaits(config(true), query({ run: run({ agent }) }))).toEqual(none);
    expect(await collectRunWaits(config(false), query())).toEqual(none);
    const refused = await setup({ DEGUBOARD_NO_TRANSCRIPTS: "1" });
    expect(await collectRunWaits(config(true), refused.query())).toEqual(none);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Adapter が例外を投げたら null にし、メッセージでなくコードだけを警告に出す", async () => {
    const { query } = await setup();
    const error = Object.assign(new Error("/home/someone/secret を読めない"), { code: "EACCES" });
    vi.spyOn(claudeCodeAdapter, "readTranscriptWaits").mockRejectedValue(error);
    const got = await collectRunWaits(config(true), query());
    expect(got.intervals).toBeNull();
    expect(got.warnings).toEqual([expect.stringContaining("EACCES")]);
    expect(got.warnings.join("")).not.toContain("secret");
  });
});

describe("使用量の取り込み（MT-2）", () => {
  const config = (read: boolean, checks: string[] = []) => ({
    ...defaultConfig(),
    metrics: { read_transcripts: read, check_commands: checks },
  });
  const nulls = { input: null, output: null, cache_read: null, cache_write: null };

  it("read_transcripts が false か DEGUBOARD_NO_TRANSCRIPTS=1 なら（設定が true でも）会話記録を読まず、null にして警告する", async () => {
    const off = await setup();
    const offSpy = vi.spyOn(claudeCodeAdapter, "readTranscriptUsage");
    const byConfig = await collectRunUsage(config(false), off.query());
    expect(offSpy).not.toHaveBeenCalled();
    expect(byConfig.usage).toEqual(nulls);
    expect(byConfig.warnings).toEqual([expect.stringContaining("metrics.read_transcripts")]);

    const env = await setup({ DEGUBOARD_NO_TRANSCRIPTS: "1" });
    const envSpy = vi.spyOn(claudeCodeAdapter, "readTranscriptUsage");
    const byEnv = await collectRunUsage(config(true), env.query());
    expect(envSpy).not.toHaveBeenCalled();
    expect(byEnv.usage).toEqual(nulls);
    expect(byEnv.warnings).toEqual([expect.stringContaining("DEGUBOARD_NO_TRANSCRIPTS")]);
  });

  it("DEGUBOARD_NO_TRANSCRIPTS が 0 か空なら拒否にならず読む", async () => {
    for (const v of ["0", ""]) {
      const { query } = await setup({ DEGUBOARD_NO_TRANSCRIPTS: v });
      const spy = vi.spyOn(claudeCodeAdapter, "readTranscriptUsage");
      await collectRunUsage(config(true), query());
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });

  it("Adapter が例外を投げたら、メッセージでなくコードだけを警告に出す", async () => {
    const { query } = await setup();
    const error = Object.assign(new Error("/home/someone/secret を読めない"), { code: "EACCES" });
    vi.spyOn(claudeCodeAdapter, "readTranscriptUsage").mockRejectedValue(error);
    const got = await collectRunUsage(config(true), query());
    expect(got.usage).toEqual(nulls);
    expect(got.warnings).toEqual([expect.stringContaining("EACCES")]);
    expect(got.warnings.join("")).not.toContain("secret");
  });

  it("Adapter のない agent は null にして警告し、Adapter のある agent は Run の agent の値で選ぶ", async () => {
    const { query } = await setup();
    const got = await collectRunUsage(config(true), query({ run: run({ agent: "someone" }) }));
    expect(got.usage).toEqual(nulls);
    expect(got.warnings).toEqual([expect.stringContaining("someone")]);
    expect(agentNames()).toContain(claudeCodeAdapter.name);
  });

  it("検査とテストに数えるコマンドを config から決めて Adapter に渡し、区間を返す。読まなかったときと数えない Adapter は null", async () => {
    const { projectDir, query } = await setup();
    await writeTranscript(path.join(projectDir, "s1.jsonl"), [
      mention(0),
      bash("m1", 1, [["u1", "mise run test:related"]]),
      toolResult(3, [["u1"]]),
    ]);
    const got = await collectRunUsage(config(true, ["mise run test:related"]), query());
    expect(got.checks).toEqual([{ from: ms(1), to: ms(3) }]);
    // 既定（actions.test が空で、足したコマンドもない）では、同じコマンドを数えない。0 個の区間は「回さなかった」
    expect((await collectRunUsage(config(true), query())).checks).toEqual([]);
    expect((await collectRunUsage(config(false), query())).checks).toBeNull();
    const other = await collectRunUsage(config(true), query({ run: run({ agent: "codex" }) }));
    expect(other.checks).toBeNull();
  });
});

describe("環境変数からの agent の判定（AG-5）", () => {
  it("Claude Code は CLAUDECODE=1 か、AI_AGENT が claude-code の形なら判定する", () => {
    for (const env of [
      { CLAUDECODE: "1" },
      { AI_AGENT: "claude-code_2-1-310_agent" },
      { AI_AGENT: "claude-code" },
    ]) {
      expect(detectAgent(env)).toEqual({ agent: "claude-code", matched: ["claude-code"] });
    }
  });

  it("Codex は CODEX_THREAD_ID が空でなければ判定する", () => {
    expect(detectAgent({ CODEX_THREAD_ID: "0199a213-81c0-7800-8aa1-bbab2a035a53" })).toEqual({
      agent: "codex",
      matched: ["codex"],
    });
    expect(detectAgent({ CODEX_THREAD_ID: "" })).toEqual({ agent: null, matched: [] });
  });

  it("似た名前の変数や、判定しない Adapter（Copilot）の製品の変数だけでは判定しない", () => {
    for (const env of [
      {},
      { CLAUDECODE: "0" },
      { AI_AGENT: "claude-codex" },
      { AI_AGENT: "github_copilot_vscode_agent" },
      { CODEX_HOME: "/tmp/codex", CODEX_SANDBOX: "seatbelt" },
      { COPILOT_MODEL: "gpt-5", COPILOT_HOME: "/tmp/copilot", COPILOT_DEBUG_NONCE: "x" },
    ]) {
      expect(detectAgent(env)).toEqual({ agent: null, matched: [] });
    }
  });

  it("2 つ以上の Adapter が自分と判定したら（エージェントの中から別のエージェントを呼んだなど）どれとも決めない", () => {
    expect(detectAgent({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" })).toEqual({
      agent: null,
      matched: ["claude-code", "codex"],
    });
  });
});

describe("Core の汎用部分は特定の AI 製品を知らない（AG-5）", () => {
  it("agents の外のコードは AI 製品の名前を書かず、agents/adapters を import しない", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const offenders: string[] = [];
    const files = await readdir(root, { recursive: true });
    for (const file of files.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      if (file.split(path.sep)[0] === "agents") continue;
      const text = await readFile(path.join(root, file), "utf8");
      if (/claude|codex|anthropic|openai/i.test(text)) offenders.push(`${file}: 製品名`);
      if (/from\s+["'](\.\.?\/)+agents\/adapters/.test(text)) offenders.push(`${file}: import`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Claude Code のフックの入力（AG-5・AG-9）", () => {
  const hooks = claudeCodeAdapter.hooks!;
  const parent = "/h/.claude/projects/d/s1.jsonl";

  it("SessionStart は CLAUDE_ENV_FILE を、PostToolUse（Agent）はサブエージェントの記録のパスと前景かを読む", () => {
    expect(
      hooks.parse(
        "SessionStart",
        { session_id: "s1", transcript_path: parent },
        { CLAUDE_ENV_FILE: "/e" },
      ),
    ).toEqual({ kind: "session_start", session: "s1", transcript: parent, envFile: "/e" });
    const base = {
      session_id: "s1",
      transcript_path: parent,
      tool_name: "Agent",
      tool_input: { prompt: "deguboard: ticket=t1 step=review" },
    };
    expect(
      hooks.parse(
        "PostToolUse",
        { ...base, tool_response: { status: "async_launched", agentId: "a1" } },
        {},
      ),
    ).toMatchObject({
      kind: "subagent_launched",
      agentId: "a1",
      transcript: path.join("/h/.claude/projects/d", "s1", "subagents", "agent-a1.jsonl"),
      finished: false,
    });
    expect(
      hooks.parse(
        "PostToolUse",
        {
          ...base,
          tool_response: {
            status: "completed",
            agentId: "a1",
            totalDurationMs: 5,
          },
        },
        {},
      ),
    ).toMatchObject({ finished: true, durationMs: 5 });
    // Agent 以外のツールと、agentId のない応答は扱わない
    expect(hooks.parse("PostToolUse", { ...base, tool_name: "Bash" }, {})).toBeUndefined();
    expect(hooks.parse("PostToolUse", { ...base, tool_response: {} }, {})).toBeUndefined();
  });

  it("SubagentStop・SessionEnd を読み、扱わないイベントと session_id のない入力は undefined", () => {
    expect(
      hooks.parse(
        "SubagentStop",
        {
          session_id: "s1",
          agent_id: "a1",
          agent_transcript_path: "/x.jsonl",
          last_assistant_message: "m",
        },
        {},
      ),
    ).toEqual({
      kind: "subagent_stopped",
      session: "s1",
      agentId: "a1",
      transcript: "/x.jsonl",
    });
    // PreToolUse は Bash のコマンドと、書くツールのパスを読む（t532）
    expect(
      hooks.parse(
        "PreToolUse",
        { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w" },
        {},
      ),
    ).toEqual({
      kind: "tool_requested",
      session: "s1",
      tool: "bash",
      command: "ls",
      path: null,
      cwd: "/w",
    });
    expect(
      hooks.parse(
        "PreToolUse",
        { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "a.md" } },
        {},
      ),
    ).toMatchObject({ tool: "write", path: "a.md" });
    expect(
      hooks.parse("PreToolUse", { session_id: "s1", tool_name: "Read", tool_input: {} }, {}),
    ).toBeUndefined();
    expect(hooks.parse("SessionEnd", { session_id: "s1" }, {})).toEqual({
      kind: "session_end",
      session: "s1",
    });
    // SubagentStart は再開を続きとして扱うのに読む（RN-7）。記録のパスは親の記録の隣
    expect(
      hooks.parse(
        "SubagentStart",
        { session_id: "s1", agent_id: "a1", transcript_path: "/h/.claude/projects/d/s1.jsonl" },
        {},
      ),
    ).toEqual({
      kind: "subagent_started",
      session: "s1",
      agentId: "a1",
      transcript: path.join("/h/.claude/projects/d", "s1", "subagents", "agent-a1.jsonl"),
    });
    expect(hooks.parse("SessionEnd", {}, {})).toBeUndefined();
  });

  it("設定のファイルと会話記録の置き場所は CLAUDE_CONFIG_DIR か ~/.claude の下", () => {
    expect(hooks.settings.project("/repo")).toBe(path.join("/repo", ".claude", "settings.json"));
    expect(hooks.settings.personal({ HOME: "/h" })).toBe(
      path.join("/h", ".claude", "settings.json"),
    );
    expect(hooks.transcriptRoot({ CLAUDE_CONFIG_DIR: "/c" })).toBe(path.join("/c", "projects"));
  });
});
