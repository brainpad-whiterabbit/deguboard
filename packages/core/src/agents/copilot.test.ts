import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../model/run.js";
import { copilotAdapter } from "./adapters/copilot.js";
import { agentNames, collectRunUsage, type UsageQuery } from "./index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const RUN_ID = "r20260101-100000-abcd";
const STARTED = "2026-01-01T10:00:00Z";
const FINISHED = "2026-01-01T10:30:00Z";
const at = (minutes: number) => new Date(Date.parse(STARTED) + minutes * 60_000).toISOString();

const run = (over: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  ticket: "t1",
  step: "implement",
  agent: "copilot",
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
  waiting_since: null,
  settling_since: null,
  ...over,
});

/** session.start の行。gitRoot で作業ツリーに結び付ける */
const sessionStart = (sessionId: string, gitRoot: string) => ({
  type: "session.start",
  data: {
    sessionId,
    version: 1,
    producer: "copilot-agent",
    context: { cwd: gitRoot, gitRoot, repository: "o/r", branch: "main" },
  },
  id: "e0",
  timestamp: at(-120),
});

interface UsageOver {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  model?: string;
  /** false にすると cacheWriteTokens を省く（古い・欠けた記録） */
  withCacheWrite?: boolean;
}

/** session.usage_record の行。数とモデル名のほかに、写してはいけない値（cost・パス）も混ぜる */
function usageRecord(minutes: number, over: UsageOver = {}) {
  const {
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    model = "gpt-test",
    withCacheWrite = true,
  } = over;
  return {
    type: "session.usage_record",
    data: {
      usage: {
        model,
        modelDisplayName: "GPT Test",
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        ...(withCacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
        cost: 1.5,
        apiCallId: "SECRET-API-CALL-ID",
        accounting: { sourceSessionId: "/home/secret/path" },
      },
    },
    id: "u",
    timestamp: at(minutes),
  };
}

/** Run の ID を含む行（dg run start の出力を受け取ったツールの結果） */
const mention = (minutes: number) => ({
  type: "tool.execution_complete",
  data: {
    toolCallId: "c1",
    success: true,
    result: { content: `[dg] $ dg run start\n{"id":"${RUN_ID}"}` },
  },
  id: "t",
  timestamp: at(minutes),
});

async function writeEvents(file: string, lines: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** HOME を一時ディレクトリにした問い合わせと session-state のパス */
async function setup(env: Record<string, string> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dg-copilot-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, ".copilot", "session-state");
  const topLevel = path.join(home, "repo");
  const eventsFile = (session: string) => path.join(stateDir, session, "events.jsonl");
  const query = (over: Partial<UsageQuery> = {}): UsageQuery => ({
    run: run(),
    finishedAt: FINISHED,
    env: { HOME: home, ...env },
    topLevel,
    ...over,
  });
  return { home, stateDir, topLevel, eventsFile, query };
}

describe("Copilot の Adapter", () => {
  it("Run の ID の後の session.usage_record を合計し、input はキャッシュの読み書きを引く", async () => {
    const { eventsFile, topLevel, query } = await setup({ COPILOT_AGENT_SESSION_ID: "sess-1" });
    await writeEvents(eventsFile("sess-1"), [
      sessionStart("sess-1", topLevel),
      usageRecord(-10, { input: 9999, output: 9999, cacheRead: 9999, cacheWrite: 9999 }), // Run の前
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 0, cacheWrite: 90 }),
      usageRecord(2, { input: 500, output: 30, cacheRead: 90, cacheWrite: 400 }),
      usageRecord(40, { input: 8888, output: 8888, cacheRead: 8888, cacheWrite: 8888 }), // 期間の後
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    // input = (100+500) - (0+90) - (90+400) = 20、output = 50、cache_read = 90、cache_write = 490
    expect(got).toEqual({
      usage: { input: 20, output: 50, cache_read: 90, cache_write: 490 },
      model: "gpt-test",
      // ツールの回数は数えない
      tools: null,
      warnings: [],
    });
  });

  it("数とモデル名だけを返し、cost・apiCallId・パスは返さない（MT-4）", async () => {
    const { eventsFile, topLevel, query } = await setup({ COPILOT_AGENT_SESSION_ID: "sess-1" });
    await writeEvents(eventsFile("sess-1"), [
      sessionStart("sess-1", topLevel),
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 0, cacheWrite: 80 }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    const serialized = JSON.stringify(got);
    expect(serialized).not.toContain("SECRET-API-CALL-ID");
    expect(serialized).not.toContain("/home/secret/path");
    expect(serialized).not.toContain("1.5");
    expect(Object.keys(got)).toEqual(["usage", "model", "tools", "warnings"]);
  });

  it("いちばん多くの応答のモデルを選ぶ", async () => {
    const { eventsFile, topLevel, query } = await setup({ COPILOT_AGENT_SESSION_ID: "sess-1" });
    await writeEvents(eventsFile("sess-1"), [
      sessionStart("sess-1", topLevel),
      mention(0),
      usageRecord(1, { input: 10, model: "model-a" }),
      usageRecord(2, { input: 10, model: "model-b" }),
      usageRecord(3, { input: 10, model: "model-b" }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.model).toBe("model-b");
  });

  it("ID が同じ時刻に出る 2 つの session では、パスの順で小さい session の記録に結び付ける", async () => {
    const { eventsFile, topLevel, query } = await setup();
    // 大きいパスの session を先に書く（書いた順や列挙の順に頼らないため）
    await writeEvents(eventsFile("sess-b"), [
      sessionStart("sess-b", topLevel),
      mention(0),
      usageRecord(1, { input: 900 }),
    ]);
    await writeEvents(eventsFile("sess-a"), [
      sessionStart("sess-a", topLevel),
      mention(0),
      usageRecord(1, { input: 100 }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage.input).toBe(100);
  });

  it("Run の ID を含まない session があっても、ほかの session から探す", async () => {
    const { eventsFile, topLevel, query } = await setup();
    // sess-empty には Run がない
    await writeEvents(eventsFile("sess-empty"), [
      sessionStart("sess-empty", topLevel),
      usageRecord(1),
    ]);
    // 同じ作業ツリーの別の session に Run がある
    await writeEvents(eventsFile("sess-other"), [
      sessionStart("sess-other", topLevel),
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 0, cacheWrite: 80 }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 20, output: 20, cache_read: 0, cache_write: 80 });
  });

  it("ID が期間の後に出るだけの記録は選ばず（閉じた後の run refresh）、ほかの session に結び付ける", async () => {
    const { eventsFile, topLevel, query } = await setup();
    await writeEvents(eventsFile("sess-now"), [
      sessionStart("sess-now", topLevel),
      mention(60),
      usageRecord(61, { input: 999, output: 999 }),
    ]);
    await writeEvents(eventsFile("sess-run"), [
      sessionStart("sess-run", topLevel),
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 0, cacheWrite: 80 }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 20, output: 20, cache_read: 0, cache_write: 80 });
  });

  it("同じ作業ツリーでも親の Run ID を含まない別 session（サブエージェント）の使用量は合算しない", async () => {
    // すべての session から探す（別 session の記録は Run の ID を含まないので数えない）
    const { eventsFile, topLevel, query } = await setup();
    await writeEvents(eventsFile("sess-parent"), [
      sessionStart("sess-parent", topLevel),
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 0, cacheWrite: 80 }),
    ]);
    // 同じ gitRoot の別 session。Run の ID を含まないので数えない
    await writeEvents(eventsFile("sess-sub"), [
      sessionStart("sess-sub", topLevel),
      usageRecord(1, { input: 7000, output: 7000, cacheRead: 0, cacheWrite: 0 }),
    ]);
    // 同じ gitRoot で、自分で別の Run を run start した session も数えない
    await writeEvents(eventsFile("sess-sub-run"), [
      sessionStart("sess-sub-run", topLevel),
      {
        ...mention(0),
        data: {
          toolCallId: "c2",
          success: true,
          result: { content: '[dg] $ dg run start\n{"id":"r20260101-100500-ffff"}' },
        },
      },
      usageRecord(1, { input: 9000, output: 9000, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 20, output: 20, cache_read: 0, cache_write: 80 });
  });

  it("作業ツリーの外の session でも、Run の ID を最も早く含む記録に、session の環境によらず結び付ける", async () => {
    const { eventsFile, query, home } = await setup();
    await writeEvents(eventsFile("sess-start"), [
      sessionStart("sess-start", "/elsewhere/other-dir"),
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 0, cacheWrite: 80 }),
    ]);
    // 別の session が 10:00:30 に run start の警告などで ID を見ただけ
    await writeEvents(eventsFile("sess-warn"), [
      sessionStart("sess-warn", "/elsewhere/other-dir"),
      mention(0.5),
      usageRecord(1, { input: 9000, output: 9000, cacheRead: 0, cacheWrite: 0 }),
    ]);
    for (const env of [{ COPILOT_AGENT_SESSION_ID: "sess-warn" }, {}]) {
      const got = await copilotAdapter.readTranscriptUsage(query({ env: { HOME: home, ...env } }));
      expect(got.usage).toEqual({ input: 20, output: 20, cache_read: 0, cache_write: 80 });
    }
  });

  it("cacheWriteTokens のない記録では cache_write を null にして警告する", async () => {
    const { eventsFile, topLevel, query } = await setup({ COPILOT_AGENT_SESSION_ID: "sess-1" });
    await writeEvents(eventsFile("sess-1"), [
      sessionStart("sess-1", topLevel),
      mention(0),
      usageRecord(1, { input: 100, output: 20, cacheRead: 10, withCacheWrite: false }),
    ]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage.cache_write).toBeNull();
    // cache_write が取れないので input は cacheRead だけを引く（100 - 10 = 90）
    expect(got.usage).toEqual({ input: 90, output: 20, cache_read: 10, cache_write: null });
    expect(got.warnings).toEqual([expect.stringContaining("cache_write")]);
  });

  it("Run が見つからなければ null にして警告する", async () => {
    const { eventsFile, topLevel, query } = await setup({ COPILOT_AGENT_SESSION_ID: "sess-1" });
    await writeEvents(eventsFile("sess-1"), [sessionStart("sess-1", topLevel), usageRecord(1)]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: null, output: null, cache_read: null, cache_write: null });
    expect(got.warnings).toEqual([expect.stringContaining("見つからない")]);
  });

  it("期間に使用量の記録がなければ null にして警告する", async () => {
    const { eventsFile, topLevel, query } = await setup({ COPILOT_AGENT_SESSION_ID: "sess-1" });
    await writeEvents(eventsFile("sess-1"), [sessionStart("sess-1", topLevel), mention(0)]);
    const got = await copilotAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: null, output: null, cache_read: null, cache_write: null });
    expect(got.warnings).toEqual([expect.stringContaining("session.usage_record")]);
  });
});

describe("Copilot の使用量の取り込みの許可（MT-2）", () => {
  const config = (read: boolean) => ({ metrics: { read_transcripts: read } });
  const nulls = { input: null, output: null, cache_read: null, cache_write: null };

  it("read_transcripts が false なら Copilot の session 記録を読まない", async () => {
    const { query } = await setup();
    const spy = vi.spyOn(copilotAdapter, "readTranscriptUsage");
    const got = await collectRunUsage(config(false), query());
    expect(spy).not.toHaveBeenCalled();
    expect(got.usage).toEqual(nulls);
    expect(got.warnings).toEqual([expect.stringContaining("metrics.read_transcripts")]);
  });

  it("DEGUBOARD_NO_TRANSCRIPTS=1 のマシンでは読まない", async () => {
    const { query } = await setup({ DEGUBOARD_NO_TRANSCRIPTS: "1" });
    const spy = vi.spyOn(copilotAdapter, "readTranscriptUsage");
    const got = await collectRunUsage(config(true), query());
    expect(spy).not.toHaveBeenCalled();
    expect(got.usage).toEqual(nulls);
    expect(got.warnings).toEqual([expect.stringContaining("DEGUBOARD_NO_TRANSCRIPTS")]);
  });

  it("agent が copilot の Run は copilot の Adapter で取り込む", async () => {
    expect(agentNames()).toContain(copilotAdapter.name);
  });
});
