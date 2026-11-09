// Run（runs/r20261031-041500-3fa2.json。requirements.md 5.9、ADR-034・ADR-029）。
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
 * 書かずに終わった Run では、最初に書くまでの回数は全体の回数と同じ。手引き（dg guide）を変えたときに調べる量が減ったかを
 * Run で比べるために持つ（チケット本文の参考節の効果は親の側に出るので Run では比べない）。種類の分け方は Adapter のコード
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

/** 見直し役の見直しの step（同梱の Workflow の steps。ADR-025） */
export const REVIEW_STEP = "review";

/**
 * 見直しの結果（ADR-025）。重い・軽い指摘の数と、通ったか（重い指摘が残っていない）。
 * 見直し役が `run review-result` で見直しの Run に書く。見直し以外の Run と、書かれていない Run は null
 */
const runReviewSchema = z.looseObject({
  heavy: toolCount,
  light: toolCount,
  passed: z.boolean(),
});
export type RunReview = z.output<typeof runReviewSchema>;

/** 見直しの指摘の重さ。heavy は受け入れ条件の漏れ・不具合・文書との食い違い・規約の違反、light は言い回し・好み・前からのずれ */
export const FINDING_SEVERITIES = ["heavy", "light"] as const;

/**
 * 見直しの指摘の 1 件（run review-result --findings-file）。見直し役が一覧で返し、dg が数と通ったかを求める。
 * 知らない項目は誤りにする（書き間違えた項目名で reason や fix が落ちないように）
 */
export const reviewFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES).describe("heavy か light"),
  category: z
    .string()
    .min(1)
    .describe(
      "指摘の種類（受け入れ条件の漏れ・不具合・文書との食い違い・規約の違反・参考節との食い違いなど）",
    ),
  file: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe("リポジトリのルートからのパス。なければ null"),
  line: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe("1 始まりの行。なければ null"),
  reason: z.string().min(1).describe("なぜ指摘するか"),
  fix: z.string().min(1).nullable().default(null).describe("直し方。なければ null"),
});
export type ReviewFinding = z.output<typeof reviewFindingSchema>;

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
  /**
   * 会話記録のセッション ID（ADR-029）。開くときに渡されなければ null。記録のパスはマシンごとに違い、ホームのパスとユーザ名を含むので
   * Git に入る Run には書かず、deguboard-local/transcripts/ に置く（run/record.ts）。この項目より前に書いた Run にはキーがないので、読むときに null にそろえる
   */
  session: z.string().min(1).nullable().default(null),
  /** 見直しの結果。この項目より前に書いた Run にはキーがないので、読むときに null にそろえる */
  review: runReviewSchema.nullable().default(null),
  /**
   * 止まって待っている印（ADR-025）。サブエージェントが step を終えた事実のないまま止まった時刻（親への質問など）。
   * 実行中の記録にだけ置き、閉じた Run（Git）には書かない。再開（同じ agent_id の起動）で消す。この項目より前の記録とは null にそろえる
   */
  waiting_since: isoDateTime.nullable().default(null),
  /**
   * 記録の書き終わりを待つ印（ADR-025）。step を終えた事実はあるが、止まった時に最後の応答がまだ書かれていなかった時刻。
   * 次のフック・dg sync・SessionEnd が書き終わりを見て閉じる。止まって待っている印とは別で、実行中の記録にだけ置く
   */
  settling_since: isoDateTime.nullable().default(null),
});
export type Run = z.output<typeof runSchema>;

/** どれも取れていない使用量 */
export function emptyUsage(): RunUsage {
  return { input: null, output: null, cache_read: null, cache_write: null };
}
