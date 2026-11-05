// Run（runs/r20261031-041500-3fa2.json。requirements.md 5.9、ADR-002・ADR-005）。
// Git に入れるのは完了時の集計だけ。実行中の記録（deguboard-local/runs/。RN-3）も同じスキーマで置く（run/record.ts）

import { z } from "zod";
import { isoDateTime } from "./common.js";
import { ticketIdSchema } from "./id.js";

export const RUN_RESULTS = ["success", "failure", "interrupted"] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

/** `r` + 開始日時（UTC の年月日-時分秒）+ 16 進 4 桁の乱数。採番しないので push の前に決められる */
const RUN_ID = /^r\d{8}-\d{6}-[0-9a-f]{4}$/;

export type RunId = `r${string}`;

export const runIdSchema = z
  .string()
  .regex(RUN_ID, "r20261031-041500-3fa2 の形の ID") as unknown as z.ZodType<RunId>;

export function isRunId(text: string): text is RunId {
  return RUN_ID.test(text);
}

/** 新しい Run の ID。辞書順が開始の順になる */
export function newRunId(
  startedAt: Date = new Date(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(2)),
): RunId {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").slice(0, 15); // 20261031T041500
  const hex = Array.from(random.subarray(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
  return `r${stamp.slice(0, 8)}-${stamp.slice(9)}-${hex}`;
}

/** トークン数。取れなかったら null（0 で補わない。RN-2） */
const tokens = z.number().int().nonnegative().nullable();

const runUsageSchema = z.looseObject({
  input: tokens,
  output: tokens,
  cache_read: tokens,
  cache_write: tokens,
  /** 推定した値を含むなら true */
  estimated: z.boolean().optional(),
});
export type RunUsage = z.output<typeof runUsageSchema>;

/** ツールの呼び出しの種類。Bash は読むものと書くものに分けない */
export const TOOL_KINDS = ["read", "search", "write", "bash", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

const toolCount = z.number().int().nonnegative();

/**
 * 種類ごとのツールの呼び出しの回数と、最初に書く（write）までの読む・探すの回数。
 * 書かずに終わった Run では、最初に書くまでの回数は全体の回数と同じ
 */
const runToolsSchema = z.looseObject({
  read: toolCount,
  search: toolCount,
  write: toolCount,
  bash: toolCount,
  other: toolCount,
  read_before_write: toolCount,
  search_before_write: toolCount,
});
export type RunTools = z.output<typeof runToolsSchema>;

/** 1 Run 1 ファイル（RN-1）。取れなかった値は null で、キーは省かない */
export const runSchema = z.looseObject({
  id: runIdSchema,
  ticket: ticketIdSchema,
  step: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().nullable(),
  started_at: isoDateTime,
  finished_at: isoDateTime.nullable(),
  /** 実行中は null */
  result: z.enum(RUN_RESULTS).nullable(),
  error: z.string().nullable(),
  retries: z.number().int().nonnegative(),
  /** やり直しの理由（1 件 1 行の要約）。この項目より前に書いた Run にはキーがないので、読むときに空の配列にそろえる */
  retry_reasons: z.array(z.string()).default([]),
  usage: runUsageSchema,
  /** ツールの回数。取れなければ null。この項目より前に書いた Run にはキーがないので、読むときに null にそろえる */
  tools: runToolsSchema.nullable().default(null),
});
export type Run = z.output<typeof runSchema>;

/** どれも取れていない使用量 */
export function emptyUsage(): RunUsage {
  return { input: null, output: null, cache_read: null, cache_write: null };
}
