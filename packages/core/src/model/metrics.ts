// Run の集計（requirements.md 6.6 MT-3、ADR-029）。集計値は保存せず、表示のたびに Run から求める純粋関数

import { isAgentActorId } from "./actor.js";
import { idNumber } from "./id.js";
import { TOOL_KINDS, type Run, type RunTools } from "./run.js";
import type { Ticket } from "./ticket.js";

/** 集計と絞り込みの単位。Agent/Model は agent と model に分けて持つ。step は Run の step（implement・review など） */
export const METRIC_UNITS = [
  "run",
  "ticket",
  "epic",
  "iteration",
  "project",
  "agent",
  "model",
  "step",
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** 足し合わせる数。どれも Run に null があれば足さず、missing に数える（RN-2） */
const METRIC_VALUES = ["duration_seconds", "input", "output", "cache_read", "cache_write"] as const;
export type MetricValue = (typeof METRIC_VALUES)[number];

const TOOL_VALUES = [...TOOL_KINDS, "read_before_write", "search_before_write"] as const;

export interface RunMetrics {
  runs: number;
  /** unfinished は result が null（実行中か、結果を記録せずに終わった）の Run */
  results: { success: number; failure: number; interrupted: number; unfinished: number };
  retries: number;
  /** 実行時間（started_at〜finished_at）の合計。値のある Run がなければ null */
  duration_seconds: number | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** ツールの回数の合計。値のある Run がなければ null */
  tools: RunTools | null;
  /** 値が欠けていて足さなかった Run の数。tools はツールの回数（tools）が null の Run */
  missing: Record<MetricValue | "tools", number>;
  /** 推定の値（usage.estimated）を含む Run の数。0 でなければ合計も推定を含む */
  estimated_runs: number;
  /**
   * 見直しの結果（review。RN-9）。recorded は結果のある Run の数、passed はそのうち通った数、heavy・light は指摘の数の合計。
   * 結果のない Run（見直し以外の step と、結果を記録せずに終わった見直し）は数えない
   */
  reviews: { recorded: number; passed: number; heavy: number; light: number };
  lines: LineMetrics;
}

/**
 * 変更行数と 1 行あたりのトークン（MT-6）。行数は Run のチケットに記録された、マージされた PR の追加・削除（Ticket の lines）。
 * 同じチケットの Run がいくつあっても、行数は 1 回だけ足す
 */
export interface LineMetrics {
  /** 行数のあるチケットの数 */
  tickets: number;
  /** 行数のあるチケットの追加・削除の合計。行数のあるチケットがなければ null */
  additions: number | null;
  deletions: number | null;
  /** 行数がなく（PR の要らない作業・マージ前・見つからないチケット）、1 行あたりのトークンの計算から外したチケットの数 */
  missing: number;
  /**
   * 1 行（追加 + 削除）あたりのトークン。cache_read が大半を占めるので合計では割らず、output と、読んだ文脈
   * （input + cache_read + cache_write）に分ける。分子は行数のあるチケットの Run のうち値のあるものの合計、
   * 分母は値のある Run が 1 件でもあるチケットの行数の合計（値のない Run だけのチケットの行数で薄めない）。
   * 分母が 0 なら null。小数第 1 位に丸める
   */
  per_line: { output: number | null; input_cache: number | null };
}

/** チケットに記録された行数（Ticket の lines と同じ形） */
export interface TicketLines {
  additions: number;
  deletions: number;
}

/** 読んだ文脈のトークン（input + cache_read + cache_write）。3 つとも null なら null、ほかは値のあるものだけを足す */
function inputCacheOf(run: Run): number | null {
  const parts = [run.usage.input, run.usage.cache_read, run.usage.cache_write].filter(
    (v): v is number => v !== null,
  );
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

function summarizeLines(
  runs: readonly Run[],
  linesOf: (ticket: string) => TicketLines | undefined,
): LineMetrics {
  const tickets = [...new Set(runs.map((r) => r.ticket))];
  const withLines = tickets.flatMap((id) => {
    const lines = linesOf(id);
    return lines ? [{ id, lines }] : [];
  });
  const perLine = (valueOf: (run: Run) => number | null): number | null => {
    let tokens = 0;
    let changed = 0;
    for (const { id, lines } of withLines) {
      // capture: none の記録は使用量を持たない（summarizeRuns と同じく外す）
      const values = runs
        .filter((r) => r.ticket === id && r.capture !== "none")
        .map(valueOf)
        .filter((v): v is number => v !== null);
      if (values.length === 0) continue;
      tokens += values.reduce((a, b) => a + b, 0);
      changed += lines.additions + lines.deletions;
    }
    return changed === 0 ? null : Math.round((tokens / changed) * 10) / 10;
  };
  return {
    tickets: withLines.length,
    additions: withLines.length === 0 ? null : withLines.reduce((a, t) => a + t.lines.additions, 0),
    deletions: withLines.length === 0 ? null : withLines.reduce((a, t) => a + t.lines.deletions, 0),
    missing: tickets.length - withLines.length,
    per_line: { output: perLine((r) => r.usage.output), input_cache: perLine(inputCacheOf) },
  };
}

/** Run の各単位の値。Epic・Iteration・Project はチケットの今の値からたどる。チケットがなければ null */
export type RunPlacement = Record<MetricUnit, string | null>;

export function placeRun(run: Run, ticket: Ticket | undefined): RunPlacement {
  return {
    run: run.id,
    ticket: run.ticket,
    epic: ticket?.epic ?? null,
    iteration: ticket?.iteration ?? null,
    project: ticket?.project ?? null,
    agent: run.agent,
    model: run.model,
    step: run.step,
  };
}

/** 実行時間（秒）。終わっていないか、日時が前後していれば null */
export function runDurationSeconds(run: Run): number | null {
  if (run.finished_at === null) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

/** linesOf はチケットの ID から記録された行数を引く。省けばどのチケットも行数なしとして数える */
export function summarizeRuns(
  runs: readonly Run[],
  linesOf: (ticket: string) => TicketLines | undefined = () => undefined,
): RunMetrics {
  const sums: Record<MetricValue, number | null> = {
    duration_seconds: null,
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
  };
  const missing: Record<MetricValue | "tools", number> = {
    duration_seconds: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    tools: 0,
  };
  let tools: RunTools | null = null;
  const results = { success: 0, failure: 0, interrupted: 0, unfinished: 0 };
  let retries = 0;
  let estimated = 0;
  const reviews = { recorded: 0, passed: 0, heavy: 0, light: 0 };
  for (const run of runs) {
    if (run.review !== null) {
      reviews.recorded += 1;
      if (run.review.passed) reviews.passed += 1;
      reviews.heavy += run.review.heavy;
      reviews.light += run.review.light;
    }
    results[run.result ?? "unfinished"] += 1;
    retries += run.retries;
    // 会話記録を取らずに作った見直しの記録（capture: none）は、見直しの回としてだけ数え、使用量と時間は集計から外す（t702）。
    // 無いのは取れなかった値ではないので、missing にも数えない
    if (run.capture === "none") continue;
    if (run.usage.estimated === true) estimated += 1;
    const values: Record<MetricValue, number | null> = {
      duration_seconds: runDurationSeconds(run),
      input: run.usage.input,
      output: run.usage.output,
      cache_read: run.usage.cache_read,
      cache_write: run.usage.cache_write,
    };
    for (const key of METRIC_VALUES) {
      const v = values[key];
      if (v === null) missing[key] += 1;
      else sums[key] = (sums[key] ?? 0) + v;
    }
    if (run.tools === null) missing.tools += 1;
    else {
      const t: RunTools = tools ?? (Object.fromEntries(TOOL_VALUES.map((k) => [k, 0])) as RunTools);
      for (const key of TOOL_VALUES) t[key] += run.tools[key];
      tools = t;
    }
  }
  return {
    runs: runs.length,
    results,
    retries,
    ...sums,
    tools,
    missing,
    estimated_runs: estimated,
    reviews,
    lines: summarizeLines(runs, linesOf),
  };
}

export type MetricFilter = Partial<Record<MetricUnit, string>>;

export interface MetricGroup extends RunMetrics {
  /** 単位の値。チケットが見つからないか、Epic などに入っていなければ null */
  key: string | null;
}

export interface MetricsReport {
  total: RunMetrics;
  /** by を指定したときの単位ごとの集計。指定しなければ空 */
  groups: MetricGroup[];
}

/** ID は番号の順、それ以外は文字列の順。null は最後 */
function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const na = idNumber(a);
  const nb = idNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a[0] === b[0]) return na - nb;
  return a < b ? -1 : 1;
}

/** 絞り込み。すべての条件に合う Run を残す */
export function filterRuns<P extends { at: RunPlacement }>(
  placed: readonly P[],
  filter: MetricFilter = {},
): P[] {
  const conditions = Object.entries(filter).filter(([, v]) => v !== undefined) as [
    MetricUnit,
    string,
  ][];
  return placed.filter((p) => conditions.every(([unit, v]) => p.at[unit] === v));
}

/**
 * 絞り込みに合う done のチケットのうち、エージェントが claim して、実装の Run（implementStepOf が返す step）が
 * 1 件もないもの（MT-3）。人の claim と --no-run は Run を開かない（RN-5）ので、欠けたものには数えない。
 * Run の条件（run・agent・model・step）があれば、Run のないチケットはどれにも合わないので示さない。
 * 絞り込みは チケットの今の値（ticket・Epic・Iteration・Project）で見る。欠けたのは Run なので、Run の数は足さない
 */
export function doneTicketsWithoutImplementRun(
  tickets: readonly Ticket[],
  runs: readonly Run[],
  implementStepOf: (ticket: Ticket) => string,
  filter: MetricFilter = {},
): string[] {
  if ((["run", "agent", "model", "step"] as const).some((u) => filter[u] !== undefined)) return [];
  const stepsOf = new Map<string, Set<string>>();
  for (const r of runs) {
    const steps = stepsOf.get(r.ticket);
    if (steps) steps.add(r.step);
    else stepsOf.set(r.ticket, new Set([r.step]));
  }
  return tickets
    .filter(
      (t) =>
        t.status === "done" &&
        t.assignee !== undefined &&
        isAgentActorId(t.assignee) &&
        !stepsOf.get(t.id)?.has(implementStepOf(t)),
    )
    .filter(
      (t) =>
        (filter.ticket === undefined || filter.ticket === t.id) &&
        (filter.epic === undefined || filter.epic === (t.epic ?? null)) &&
        (filter.iteration === undefined || filter.iteration === (t.iteration ?? null)) &&
        (filter.project === undefined || filter.project === t.project),
    )
    .map((t) => t.id)
    .sort((a, b) => idNumber(a) - idNumber(b));
}

/**
 * 題と本文に書かれた、ほかのチケットの ID（MT-8）。`t12` の形で、前後が英数字・`_` でないものを、出た順に重ねずに返す。
 * 自分の ID と、exists が偽の ID（チケットのない番号。例に書いた ID や別の語の一部）は外す。
 * 書かれているかだけを返し、参照の意味（依存・由来・例）は読み手が決める
 */
export function referencedTickets(
  ticket: { id: string; title: string; body: string },
  exists: (id: string) => boolean,
): string[] {
  const found = `${ticket.title}\n${ticket.body}`.match(
    /(?<![A-Za-z0-9_])t[1-9]\d*(?![A-Za-z0-9_])/g,
  );
  return [...new Set(found ?? [])].filter((id) => id !== ticket.id && exists(id));
}

/** 絞り込んだ Run の集計と、単位ごとの集計 */
export function measureRuns(
  placed: readonly { run: Run; at: RunPlacement }[],
  filter: MetricFilter = {},
  by?: MetricUnit,
  linesOf?: (ticket: string) => TicketLines | undefined,
): MetricsReport {
  const matched = filterRuns(placed, filter);
  const total = summarizeRuns(
    matched.map((p) => p.run),
    linesOf,
  );
  if (!by) return { total, groups: [] };
  const buckets = new Map<string | null, Run[]>();
  for (const p of matched) {
    const key = p.at[by];
    const list = buckets.get(key);
    if (list) list.push(p.run);
    else buckets.set(key, [p.run]);
  }
  const groups = [...buckets.entries()]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([key, runs]) => ({ key, ...summarizeRuns(runs, linesOf) }));
  return { total, groups };
}
