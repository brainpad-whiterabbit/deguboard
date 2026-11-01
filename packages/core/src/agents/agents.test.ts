import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../model/run.js";
import { claudeCodeAdapter, projectDirName, searchRoots } from "./adapters/claude-code.js";
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
  usage: { input: null, output: null, cache_read: null, cache_write: null },
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
      warnings: [],
    });
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
