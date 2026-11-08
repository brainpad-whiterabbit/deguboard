// Run の集計（requirements.md 6.6 MT-3、ADR-029）。集計値は保存せず、表示のたびに Run から求める純粋関数

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
   * 見直しの結果（review。ADR-025）。recorded は結果のある Run の数、passed はそのうち通った数、heavy・light は指摘の数の合計。
   * 結果のない Run（見直し以外の step と、結果を記録せずに終わった見直し）は数えない
   */
  reviews: { recorded: number; passed: number; heavy: number; light: number };
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

export function summarizeRuns(runs: readonly Run[]): RunMetrics {
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

/** 絞り込んだ Run の集計と、単位ごとの集計 */
export function measureRuns(
  placed: readonly { run: Run; at: RunPlacement }[],
  filter: MetricFilter = {},
  by?: MetricUnit,
): MetricsReport {
  const matched = filterRuns(placed, filter);
  const total = summarizeRuns(matched.map((p) => p.run));
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
    .map(([key, runs]) => ({ key, ...summarizeRuns(runs) }));
  return { total, groups };
}
