import { describe, expect, it } from "vitest";
import { measureRuns, placeRun, runDurationSeconds, summarizeRuns } from "./metrics.js";
import { emptyUsage, type Run } from "./run.js";
import type { Ticket } from "./ticket.js";

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id: `r20261031-0400${id}-0001` as Run["id"],
    ticket: "t1",
    step: "implement",
    agent: "claude-code",
    model: "opus",
    started_at: "2026-10-31T04:00:00Z",
    finished_at: "2026-10-31T04:01:00Z",
    result: "success",
    error: null,
    retries: 0,
    retry_reasons: [],
    usage: { input: 100, output: 10, cache_read: 0, cache_write: 5 },
    tools: null,
    session: null,
    review: null,
    waiting_since: null,
    settling_since: null,
    ...over,
  };
}

const ticket = (id: string, over: Partial<Ticket> = {}) => ({ id, ...over }) as unknown as Ticket;

describe("Run の集計", () => {
  it("null の値は 0 として足さず、欠けた Run の数を missing に数える。すべて欠ければ合計も null", () => {
    const m = summarizeRuns([
      run("00"),
      run("01", { usage: { ...emptyUsage(), input: 50 }, finished_at: null, result: null }),
      run("02", { usage: emptyUsage(), result: "failure", retries: 2 }),
    ]);
    expect(m).toMatchObject({
      runs: 3,
      results: { success: 1, failure: 1, interrupted: 0, unfinished: 1 },
      retries: 2,
      duration_seconds: 120,
      input: 150,
      output: 10,
      missing: { duration_seconds: 1, input: 1, output: 2, cache_read: 2, cache_write: 2 },
      estimated_runs: 0,
    });
    const none = summarizeRuns([run("03", { usage: emptyUsage() })]);
    expect(none.input).toBeNull();
    expect(none.missing.input).toBe(1);
    expect(summarizeRuns([])).toMatchObject({ runs: 0, input: null, duration_seconds: null });
  });

  it("ツールの回数は種類ごとに足し、null の Run は足さずに missing.tools に数える。すべて欠ければ null", () => {
    const tools = (n: number) => ({
      read: n,
      search: n,
      write: n,
      bash: n,
      other: n,
      read_before_write: n,
      search_before_write: n,
    });
    const m = summarizeRuns([
      run("00", { tools: tools(1) }),
      run("01"),
      run("02", { tools: { ...tools(2), write: 0 } }),
    ]);
    expect(m.tools).toEqual({ ...tools(3), write: 1 });
    expect(m.missing.tools).toBe(1);
    const none = summarizeRuns([run("03")]);
    expect(none.tools).toBeNull();
    expect(none.missing.tools).toBe(1);
  });

  it("推定の値を含む Run の数を estimated_runs で示す", () => {
    const m = summarizeRuns([
      run("00", { usage: { ...emptyUsage(), input: 1, estimated: true } }),
      run("01"),
    ]);
    expect(m.estimated_runs).toBe(1);
    expect(m.input).toBe(101);
  });

  it("実行時間は終わっていないか日時が前後していれば欠けたものとする", () => {
    expect(runDurationSeconds(run("00", { finished_at: "2026-10-31T04:00:01.500Z" }))).toBe(1.5);
    expect(runDurationSeconds(run("00", { finished_at: null }))).toBeNull();
    expect(runDurationSeconds(run("00", { finished_at: "2026-10-31T03:00:00Z" }))).toBeNull();
  });

  it("すべての単位（Run・Ticket・Epic・Iteration・Agent/Model・Step）で絞り込み、単位ごとに集計する", () => {
    const tickets: Record<string, Ticket> = {
      t1: ticket("t1", { epic: "e1", iteration: "s1" }),
      t2: ticket("t2", { epic: "e1" }),
      t10: ticket("t10", { iteration: "s1" }),
    };
    const runs = [
      run("00"),
      run("01", { ticket: "t2", agent: "codex", model: null }),
      run("02", { ticket: "t10", model: "sonnet" }),
      run("03", { ticket: "t9", step: "review" }), // 消えたチケット
    ];
    const placed = runs.map((r) => ({ r, at: placeRun(r, tickets[r.ticket]) }));
    const all = placed.map(({ r, at }) => ({ run: r, at }));
    const count = (filter: Parameters<typeof measureRuns>[1]) =>
      measureRuns(all, filter).total.runs;

    expect(count({})).toBe(4);
    expect(count({ run: runs[1]!.id })).toBe(1);
    expect(count({ ticket: "t1" })).toBe(1);
    expect(count({ epic: "e1" })).toBe(2);
    expect(count({ iteration: "s1" })).toBe(2);
    expect(count({ agent: "claude-code" })).toBe(3);
    expect(count({ model: "opus" })).toBe(2);
    expect(count({ agent: "claude-code", model: "sonnet" })).toBe(1);
    expect(count({ epic: "e1", agent: "codex" })).toBe(1);
    expect(count({ step: "review" })).toBe(1);
    expect(count({ step: "implement", agent: "codex" })).toBe(1);

    const keys = (by: Parameters<typeof measureRuns>[2]) =>
      measureRuns(all, {}, by).groups.map((g) => [g.key, g.runs]);
    expect(keys("ticket")).toEqual([
      ["t1", 1],
      ["t2", 1],
      ["t9", 1],
      ["t10", 1],
    ]);
    expect(keys("epic")).toEqual([
      ["e1", 2],
      [null, 2],
    ]);
    expect(keys("iteration")).toEqual([
      ["s1", 2],
      [null, 2],
    ]);
    expect(keys("agent")).toEqual([
      ["claude-code", 3],
      ["codex", 1],
    ]);
    expect(keys("model")).toEqual([
      ["opus", 2],
      ["sonnet", 1],
      [null, 1],
    ]);
    expect(keys("step")).toEqual([
      ["implement", 3],
      ["review", 1],
    ]);
    expect(keys("run").map(([k]) => k)).toEqual(runs.map((r) => r.id));
    // 絞り込んでから単位ごとに集計する
    expect(measureRuns(all, { epic: "e1" }, "agent").groups.map((g) => g.key)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(measureRuns(all, {}).groups).toEqual([]);
  });

  it("変更行数はチケットごとに 1 回だけ足し、1 行あたりのトークンを output と input+cache に分けて出す。行数のないチケットは計算から外して数える（MT-6）", () => {
    const usage = (input: number, output: number) => ({
      input,
      output,
      cache_read: input * 2,
      cache_write: null,
    });
    const runs = [
      // t1（+80 -20）：実装と手直し
      run("00", { usage: usage(1000, 300) }),
      run("01", { step: "fix", usage: usage(500, 200) }),
      // t2：行数なし（PR の要らない作業・マージ前）
      run("02", { ticket: "t2", usage: usage(9000, 9000) }),
      // t3（+50 -0）：使用量のない Run だけ
      run("03", { ticket: "t3", usage: emptyUsage() }),
    ];
    const lines: Record<string, { additions: number; deletions: number }> = {
      t1: { additions: 80, deletions: 20 },
      t3: { additions: 50, deletions: 0 },
    };
    const m = summarizeRuns(runs, (id) => lines[id]);
    // 行数は t1 と t3 の合計。t1 は Run が 2 件でも 1 回だけ足す
    expect(m.lines).toEqual({
      tickets: 2,
      additions: 130,
      deletions: 20,
      missing: 1,
      // t2 のトークンは足さない。値のある Run のない t3 の行数は分母に入れない：output 500 / 100、input+cache 4500 / 100
      per_line: { output: 5, input_cache: 45 },
    });

    // 工程ごとの集計でも、その工程の Run のトークンをチケットの行数で割る
    const placed = runs.map((r) => ({ run: r, at: placeRun(r, undefined) }));
    const byStep = measureRuns(placed, {}, "step", (id) => lines[id]).groups;
    expect(byStep.map((g) => [g.key, g.lines.per_line.output, g.lines.missing])).toEqual([
      ["fix", 2, 0],
      ["implement", 3, 1],
    ]);

    // 行数のあるチケットがなければ行数も 1 行あたりも null。linesOf を省いても同じ
    expect(summarizeRuns([runs[2]!]).lines).toEqual({
      tickets: 0,
      additions: null,
      deletions: null,
      missing: 1,
      per_line: { output: null, input_cache: null },
    });
    // 行数が 0 の PR（追加も削除もない）では割らない
    expect(
      summarizeRuns([runs[0]!], () => ({ additions: 0, deletions: 0 })).lines.per_line,
    ).toEqual({ output: null, input_cache: null });
    // capture: none の記録のトークンは足さず、小数第 1 位に丸める
    const rounded = summarizeRuns(
      [
        run("04", { usage: usage(10, 10) }),
        run("05", { step: "review", capture: "none", usage: usage(999, 999) }),
      ],
      () => ({ additions: 3, deletions: 0 }),
    );
    expect(rounded.lines.per_line).toEqual({ output: 3.3, input_cache: 10 });
  });
});
