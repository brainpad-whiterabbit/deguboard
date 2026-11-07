import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../model/run.js";
import { codexAdapter } from "./adapters/codex.js";
import { agentNames, collectRunUsage, type UsageQuery } from "./index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const RUN_ID = "r20260101-100000-abcd";
const STARTED = "2026-01-01T10:00:00Z";
const FINISHED = "2026-01-01T10:30:00Z";
const at = (minutes: number) => new Date(Date.parse(STARTED) + minutes * 60_000).toISOString();

const run = (): Run => ({
  id: RUN_ID,
  ticket: "t1",
  step: "implement",
  agent: "codex",
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
});

/** token_count の行。tokens は累計の [input（キャッシュを含む）, cached, output, cache_write]。cache_write がなければ古い版の形 */
function tokenCount(minutes: number, tokens: number[]) {
  const [input = 0, cached = 0, output = 0, cacheWrite] = tokens;
  const usage = {
    input_tokens: input,
    cached_input_tokens: cached,
    ...(cacheWrite === undefined ? {} : { cache_write_input_tokens: cacheWrite }),
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
  return {
    timestamp: at(minutes),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 272000 },
      rate_limits: null,
    },
  };
}

const turnContext = (minutes: number, model: string) => ({
  timestamp: at(minutes),
  type: "turn_context",
  payload: { cwd: "/somewhere/else", approval_policy: "on-request", model, summary: "auto" },
});

/** Run の ID を含む行（dg run start の出力を受け取ったツールの結果） */
const mention = (minutes: number) => ({
  timestamp: at(minutes),
  type: "response_item",
  payload: { type: "function_call_output", call_id: "c1", output: `{"id":"${RUN_ID}"}` },
});

const meta = (minutes: number) => ({
  timestamp: at(minutes),
  type: "session_meta",
  payload: { id: "s1", timestamp: at(minutes), cwd: "/somewhere/else", originator: "codex_cli_rs" },
});

/** HOME を一時ディレクトリにした問い合わせと、その日の sessions/ のディレクトリ */
async function setup(env: Record<string, string> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dg-codex-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions", "2026", "01", "01");
  const query = (over: Partial<UsageQuery> = {}): UsageQuery => ({
    run: run(),
    finishedAt: FINISHED,
    env: { HOME: home, ...env },
    topLevel: path.join(home, "repo"),
    ...over,
  });
  return { home, sessions, query };
}

async function writeRollout(file: string, lines: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("Codex の Adapter", () => {
  it("Run の ID の前の累計と finished_at までの累計の差を取り、input はキャッシュから読んだ分を引く", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-2026-01-01T09-00-00-s1.jsonl"), [
      meta(-60),
      turnContext(-60, "gpt-old"),
      tokenCount(-30, [1000, 400, 100, 10]), // Run の前
      tokenCount(-1, [2000, 800, 200, 20]), // Run の前の最後
      mention(0),
      turnContext(1, "gpt-test"),
      tokenCount(1, [3000, 1500, 260, 25]),
      { timestamp: at(2), type: "event_msg", payload: { type: "token_count", info: null } },
      "書きかけの行",
      tokenCount(3, [4000, 2000, 300, 30]),
      turnContext(40, "gpt-later"),
      tokenCount(40, [9000, 9000, 9000, 90]), // 期間の後
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got).toEqual({
      usage: { input: 800, output: 100, cache_read: 1200, cache_write: 10 },
      model: "gpt-test",
      // ツールの回数は数えない
      tools: null,
      warnings: [],
    });
  });

  it("ID が同じ時刻に出る 2 つのファイルでは、パスの順で小さい方に結び付ける", async () => {
    const { sessions, query } = await setup();
    // 大きいパスのファイルを先に書く（書いた順や列挙の順に頼らないため）
    const rollout = (input: number) => [
      meta(-60),
      turnContext(-60, "gpt-test"),
      tokenCount(-1, [0, 0, 0, 0]),
      mention(0),
      tokenCount(1, [input, 0, 0, 0]),
    ];
    await writeRollout(path.join(sessions, "rollout-2026-01-01T09-00-00-b.jsonl"), rollout(900));
    await writeRollout(path.join(sessions, "rollout-2026-01-01T09-00-00-a.jsonl"), rollout(100));
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage.input).toBe(100);
  });

  describe("同じ会話記録で期間が重なる Run", () => {
    // A（RUN_ID、10:00 開始）を開いたまま、同じ session で B（10:10 開始）を始めた記録
    const B = "r20260101-101000-beef";
    const B_STARTED = at(10).replace(".000", "");
    const mentionOf = (id: string, minutes: number) => ({
      timestamp: at(minutes),
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c2", output: `{"id":"${id}"}` },
    });
    const lines = [
      mention(0),
      turnContext(1, "gpt-a"),
      tokenCount(5, [10, 4, 1, 1]),
      mentionOf(B, 10),
      turnContext(11, "gpt-b"),
      tokenCount(12, [30, 10, 11, 2]),
      tokenCount(25, [130, 50, 111, 3]),
    ];
    const runB = (): Run => ({ ...run(), id: B, started_at: B_STARTED });
    const spans = (entries: Array<[string, string, string | null]>) =>
      new Map(entries.map(([id, started_at, finished_at]) => [id, { started_at, finished_at }]));

    it("先に閉じた側（A）は B の ID の後の累計の増えを除き、後に閉じた側（B）は A と重ならずに数える", async () => {
      const { sessions, query } = await setup();
      await writeRollout(path.join(sessions, "rollout-a.jsonl"), lines);
      const a = await codexAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others: spans([[B, B_STARTED, null]]) }),
      );
      const b = await codexAdapter.readTranscriptUsage(
        query({ run: runB(), others: spans([[RUN_ID, STARTED, at(20)]]) }),
      );
      expect(a.usage).toEqual({ input: 6, output: 1, cache_read: 4, cache_write: 1 });
      expect(a.model).toBe("gpt-a");
      expect(b.usage).toEqual({ input: 74, output: 110, cache_read: 46, cache_write: 2 });
      expect(b.model).toBe("gpt-b");
    });

    it("後に始めた B を先に閉じても、A は B の期間の増えだけを除く", async () => {
      const { sessions, query } = await setup();
      await writeRollout(path.join(sessions, "rollout-a.jsonl"), lines);
      const b = await codexAdapter.readTranscriptUsage(
        query({ run: runB(), finishedAt: at(15), others: spans([[RUN_ID, STARTED, null]]) }),
      );
      const a = await codexAdapter.readTranscriptUsage(
        query({ others: spans([[B, B_STARTED, at(15)]]) }),
      );
      expect(b.usage.output).toBe(10);
      expect(a.usage).toEqual({ input: 66, output: 101, cache_read: 44, cache_write: 2 });
    });

    it("別のファイルで始まった Run の ID を 1 分以内に表示しただけでは、その Run に譲らない", async () => {
      const { sessions, query } = await setup();
      // B は rollout-b で 10:10 に始めた。rollout-a は 10:10:30 に一覧などで B の ID を見ただけ
      await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
        mention(0),
        tokenCount(5, [10, 4, 1, 1]),
        mentionOf(B, 10.5),
        tokenCount(12, [30, 10, 11, 2]),
      ]);
      await writeRollout(path.join(sessions, "rollout-b.jsonl"), [
        mentionOf(B, 10),
        tokenCount(12, [1000, 1000, 1000, 1000]),
      ]);
      const got = await codexAdapter.readTranscriptUsage(
        query({ finishedAt: at(20), others: spans([[B, B_STARTED, null]]) }),
      );
      expect(got.usage).toEqual({ input: 20, output: 11, cache_read: 10, cache_write: 2 });
    });

    it("同じファイルで始めた 2 本は片方だけに数え、別のファイルで始まった Run の ID を見ても両方を 0 にしない", async () => {
      const { sessions, query } = await setup();
      // 1 つの見直し役が rollout-a で A（10:10:00）と C（10:10:01）を始め（出力に ID は出ない）、10:10:09 の一覧で
      // A・C と、rollout-d で 10:10:03 に始めた D の ID を見た
      const A_STARTED = "2026-01-01T10:10:00Z";
      const C_STARTED = "2026-01-01T10:10:01Z";
      const C = "r20260101-101001-cafe";
      const D = "r20260101-101003-dead";
      const sec = (s: number) => 10 + s / 60;
      await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
        tokenCount(9, [5, 0, 5, 0]),
        {
          timestamp: at(sec(9)),
          type: "response_item",
          payload: { type: "function_call_output", call_id: "c3", output: `${RUN_ID} ${C} ${D}` },
        },
        tokenCount(12, [35, 10, 15, 2]),
      ]);
      await writeRollout(path.join(sessions, "rollout-d.jsonl"), [
        mentionOf(D, sec(4)),
        tokenCount(12, [1000, 1000, 1000, 1000]),
      ]);
      const all: Array<[string, string, string | null]> = [
        [RUN_ID, A_STARTED, at(20)],
        [C, C_STARTED, at(20)],
        [D, "2026-01-01T10:10:03Z", null],
      ];
      const others = (self: string) => spans(all.filter(([id]) => id !== self));
      const a = await codexAdapter.readTranscriptUsage(
        query({
          run: { ...run(), started_at: A_STARTED },
          finishedAt: at(20),
          others: others(RUN_ID),
        }),
      );
      const c = await codexAdapter.readTranscriptUsage(
        query({
          run: { ...run(), id: C, started_at: C_STARTED },
          finishedAt: at(20),
          others: others(C),
        }),
      );
      expect(a.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
      expect(c.usage).toEqual({ input: 20, output: 10, cache_read: 10, cache_write: 2 });
    });
  });

  it("Run の ID の前に累計がなければ session の始まりから数え、turn がなければ前のモデル名を入れる", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      turnContext(0, "gpt-test"),
      mention(0),
      tokenCount(1, [100, 40, 7, 0]),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 60, output: 7, cache_read: 40, cache_write: 0 });
    expect(got.model).toBe("gpt-test");
  });

  it("payload.type が token_count でない event_msg の量は数えない", async () => {
    const { sessions, query } = await setup();
    /** 行の文字列に "type":"token_count" を含むが、token_count の行ではない */
    const decoy = (minutes: number) => {
      const real = tokenCount(minutes, [9000, 0, 9000, 0]);
      return {
        ...real,
        payload: { ...real.payload, type: "agent_message", note: { type: "token_count" } },
      };
    };
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      tokenCount(-2, [100, 0, 10, 0]),
      mention(0),
      tokenCount(1, [300, 0, 40, 0]),
      decoy(2),
      decoy(3),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 200, output: 30, cache_read: 0, cache_write: 0 });
  });

  it("ID の前の最後の行が token_count でない・info が null・モデル名が空なら、手前の累計とモデル名を使う", async () => {
    const { sessions, query } = await setup();
    const decoy = (minutes: number) => {
      const real = tokenCount(minutes, [9000, 0, 9000, 0]);
      return {
        ...real,
        payload: { ...real.payload, type: "agent_message", note: { type: "token_count" } },
      };
    };
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      turnContext(-5, "gpt-before"),
      tokenCount(-4, [100, 0, 10, 0]),
      { timestamp: at(-3), type: "event_msg", payload: { type: "token_count", info: null } },
      decoy(-2),
      { timestamp: at(-1), type: "turn_context", payload: { cwd: "/somewhere/else", model: "" } },
      mention(0),
      tokenCount(1, [300, 0, 40, 0]),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 200, output: 30, cache_read: 0, cache_write: 0 });
    expect(got.model).toBe("gpt-before");
  });

  it("Codex の書く順（ツールの結果の後にその応答の token_count）では、run start を呼んだ応答を含め、run finish を呼んだ応答を含めない", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      tokenCount(-1, [100, 0, 10, 0]), // Run の前の応答
      mention(0), // dg run start の出力
      tokenCount(0, [250, 0, 30, 0]), // dg run start を呼んだ応答
      tokenCount(10, [400, 0, 50, 0]), // 作業の応答
      tokenCount(31, [600, 0, 70, 0]), // dg run finish を呼んだ応答（finish の後に書かれる）
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 300, output: 40, cache_read: 0, cache_write: 0 });
  });

  it("cache_write_input_tokens を書かない版の記録では cache_write を null にして警告する", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      tokenCount(-1, [100, 50, 10]),
      mention(0),
      tokenCount(1, [300, 100, 30]),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 150, output: 20, cache_read: 50, cache_write: null });
    expect(got.warnings).toEqual([expect.stringContaining("cache_write")]);
  });

  it("累計が減っていれば、その値は取れないので null にして警告する", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      tokenCount(-1, [1000, 500, 100, 0]),
      mention(0),
      tokenCount(1, [200, 100, 150, 0]),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: null, output: 50, cache_read: null, cache_write: 0 });
    expect(got.warnings).toEqual([expect.stringContaining("input・cache_read")]);
  });

  it("Run の ID を最初に含む記録を選び、ID を含まない並行の記録と ID を後から受け取った記録は数えない", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-worker.jsonl"), [
      mention(0),
      tokenCount(1, [10, 0, 1, 0]),
    ]);
    await writeRollout(path.join(sessions, "rollout-other.jsonl"), [
      tokenCount(1, [5000, 0, 500, 0]),
    ]);
    // 前の日に始めて ID を報告で後から受け取った記録
    await writeRollout(
      path.join(sessions, "..", "..", "..", "2025", "12", "31", "rollout-p.jsonl"),
      [tokenCount(1, [700, 0, 70, 0]), mention(20), tokenCount(21, [900, 0, 90, 0])],
    );
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: 10, output: 1, cache_read: 0, cache_write: 0 });
  });

  it("CODEX_HOME があればその下を探し、更新日時が started_at より古いファイルと日付の階層の外は探さない", async () => {
    const { home, query } = await setup();
    const codexHome = path.join(home, "codex-home");
    const day = path.join(codexHome, "sessions", "2026", "01", "01");
    await writeRollout(path.join(day, "rollout-a.jsonl"), [
      mention(0),
      tokenCount(1, [3, 0, 3, 0]),
    ]);
    const env = { HOME: home, CODEX_HOME: codexHome };
    expect((await codexAdapter.readTranscriptUsage(query({ env }))).usage.input).toBe(3);

    const old = new Date(Date.parse(STARTED) - 60_000);
    await utimes(path.join(day, "rollout-a.jsonl"), old, old);
    await writeRollout(path.join(codexHome, "sessions", "rollout-flat.jsonl"), [
      mention(0),
      tokenCount(1, [5, 0, 5, 0]),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query({ env }));
    expect(got.usage.input).toBeNull();
    expect(got.warnings).toEqual([expect.stringContaining("見つからない")]);
  });

  it("Run の ID はあるが期間の token_count がなければ、値を null にして警告する", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      tokenCount(-1, [100, 0, 10, 0]),
      mention(0),
      tokenCount(40, [200, 0, 20, 0]),
    ]);
    const got = await codexAdapter.readTranscriptUsage(query());
    expect(got.usage).toEqual({ input: null, output: null, cache_read: null, cache_write: null });
    expect(got.model).toBeNull();
    expect(got.warnings).toEqual([expect.stringContaining("token_count")]);
  });

  it("run finish の取り込みは agent が codex の Run で Codex の Adapter を選ぶ", async () => {
    const { sessions, query } = await setup();
    await writeRollout(path.join(sessions, "rollout-a.jsonl"), [
      mention(0),
      tokenCount(1, [4, 0, 4, 0]),
    ]);
    expect(agentNames()).toEqual(expect.arrayContaining(["claude-code", "codex"]));
    const got = await collectRunUsage({ metrics: { read_transcripts: true } }, query());
    expect(got.usage).toEqual({ input: 4, output: 4, cache_read: 0, cache_write: 0 });
  });
});
