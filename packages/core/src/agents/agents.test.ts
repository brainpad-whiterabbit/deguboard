import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../model/run.js";
import { claudeCodeAdapter, projectDirName } from "./adapters/claude-code.js";
import { searchRoots } from "./adapters/transcript.js";
import { agentNames, collectRunUsage, type UsageQuery } from "./index.js";

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
    commonDir: path.join(topLevel, ".git"),
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
      },
      warnings: [],
    });
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

  it("主の作業ツリーで始めたセッションの記録も、worktree の作業ツリーから探す", async () => {
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
        commonDir: path.join(main, ".git"),
      }),
    );
    expect(got.usage.input).toBe(1);
  });

  it("CLAUDE_CODE_SESSION_ID があればその session の記録だけを、CLAUDE_CONFIG_DIR があればそこを探す", async () => {
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
    const env = { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "s1" };
    const got = await claudeCodeAdapter.readTranscriptUsage(query({ env }));
    expect(got.usage.input).toBe(5);
  });

  it("探す作業ディレクトリは主の作業ツリーの親までで、HOME とその上は探さない", async () => {
    const { home, query } = await setup();
    expect(searchRoots("/h/u/repo.worktrees/feat/x", "/h/u/repo/.git", "/h/u").sort()).toEqual([
      "/h/u/repo",
      "/h/u/repo.worktrees",
      "/h/u/repo.worktrees/feat",
      "/h/u/repo.worktrees/feat/x",
    ]);
    expect(searchRoots("/w/repo", "/w/repo/.git", "/h/u").sort()).toEqual(["/w", "/w/repo"]);
    // HOME の会話記録に Run があっても読まない
    const dir = path.join(home, ".claude", "projects", projectDirName(home));
    await writeTranscript(path.join(dir, "s1.jsonl"), [
      mention(0),
      assistant("m1", 1, [1, 1, 1, 1]),
    ]);
    const got = await claudeCodeAdapter.readTranscriptUsage(query());
    expect(got.usage.input).toBeNull();
  });

  it("CLAUDE_CODE_SESSION_ID が不正な形か、その session に Run がなければ作業ツリーから探す", async () => {
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

  it("CLAUDE_CODE_SESSION_ID の session に Run の ID が期間の後に出るだけなら（閉じた後の run refresh）、作業ツリーから探す", async () => {
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
    expect(got.warnings).toEqual([expect.stringContaining("見つからない")]);
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
    expect(got.warnings).toEqual([expect.stringContaining("見つからない")]);
  });
});

describe("使用量の取り込み（MT-2）", () => {
  const config = (read: boolean) => ({ metrics: { read_transcripts: read } });
  const nulls = { input: null, output: null, cache_read: null, cache_write: null };

  it("read_transcripts が false なら会話記録を読まず、null にして警告する", async () => {
    const { query } = await setup();
    const spy = vi.spyOn(claudeCodeAdapter, "readTranscriptUsage");
    const got = await collectRunUsage(config(false), query());
    expect(spy).not.toHaveBeenCalled();
    expect(got.usage).toEqual(nulls);
    expect(got.warnings).toEqual([expect.stringContaining("metrics.read_transcripts")]);
  });

  it("DEGUBOARD_NO_TRANSCRIPTS=1 のマシンでは read_transcripts が true でも読まない", async () => {
    const { query } = await setup({ DEGUBOARD_NO_TRANSCRIPTS: "1" });
    const spy = vi.spyOn(claudeCodeAdapter, "readTranscriptUsage");
    const got = await collectRunUsage(config(true), query());
    expect(spy).not.toHaveBeenCalled();
    expect(got.usage).toEqual(nulls);
    expect(got.warnings).toEqual([expect.stringContaining("DEGUBOARD_NO_TRANSCRIPTS")]);
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
