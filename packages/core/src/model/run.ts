// Run（runs/r20261031-041500-3fa2.json。requirements.md 5.9、ADR-029）。
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
  .regex(RUN_ID, "An ID like r20261031-041500-3fa2") as unknown as z.ZodType<RunId>;

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
 * Run で比べるために持つ（チケット本文の参考節の効果は親の側に出るので Run では比べない）。種類の分け方は Adapter のコード。
 * errors は失敗したツールの呼び出しの数（落ちたコマンド、当たらなかった Edit、断られた・拒まれた呼び出し）。成功した Run の中の
 * 遠回りを数えるために持つ。失敗の印を読めない Adapter・会話記録の Run と、この項目より前の Run にはキーがなく、0 で補わない（RN-2）
 */
const runToolsSchema = z.looseObject({
  read: toolCount,
  search: toolCount,
  write: toolCount,
  bash: toolCount,
  other: toolCount,
  read_before_write: toolCount,
  search_before_write: toolCount,
  errors: toolCount.optional(),
});
export type RunTools = z.output<typeof runToolsSchema>;

/**
 * Run の step の語彙と表示名（WF-5）。Core が固定で持ち、workflow.yaml には書かない：`run start` は語彙にない step を拒否する。
 * 前の版が記録した Run の step はそのまま読む（スキーマは語を縛らない）
 */
export const RUN_STEPS = [
  { id: "investigate", label: "Investigate" },
  { id: "implement", label: "Implement" },
  { id: "review", label: "Review" },
  { id: "fix", label: "Fix" },
  { id: "merge", label: "Merge" },
] as const;
export type RunStep = (typeof RUN_STEPS)[number]["id"];

export function isRunStep(step: string): step is RunStep {
  return RUN_STEPS.some((s) => s.id === step);
}

/** 見直し役の見直しの step */
export const REVIEW_STEP = "review" satisfies RunStep;

/**
 * Run を開くチケットの操作（RN-5）。claim は todo のチケットの claim（実装）、
 * reclaim は自分が claim 済みで PR のあるチケットのもう一度の claim（見直しの修正ループと人のレビューの後の手直し）
 */
export type StepOpener = "claim" | "reclaim";

/** チケットの操作が開く Run の step（RN-5）。閉じる側（findOpenedRun）も同じ step を探す */
export const OPENED_STEPS = {
  claim: "implement",
  reclaim: "fix",
} as const satisfies Record<StepOpener, RunStep>;

/**
 * 見直しの指摘の、手戻りの原因の種類。成果物のどこが悪いか（category）とは別に、なぜそうなったかを見直し役が 1 件ごとに付ける。
 * ticket は受け入れ条件か範囲がその場面を書いていなかったもので、PR が受け入れ条件を満たしていない category の「受け入れ条件の漏れ」とは別。
 * 種類を固定するのは、Run をまたいで数を足せるようにするため（自由な文では数えられない）。分からないときは unknown にし、推し量らせない
 */
export const FINDING_CAUSES = [
  "ticket",
  "plan",
  "implementation",
  "tests",
  "documents",
  "environment",
  "unknown",
] as const;
export type FindingCause = (typeof FINDING_CAUSES)[number];

/** 原因ごとの指摘の数。指摘のない原因も 0 で持つ（足し合わせる側がキーの有無を見なくてすむ） */
const causeCountsSchema = z.looseObject(
  Object.fromEntries(FINDING_CAUSES.map((c) => [c, toolCount])) as Record<
    FindingCause,
    typeof toolCount
  >,
);
export type CauseCounts = z.output<typeof causeCountsSchema>;

/** どの原因も 0 の数 */
export function emptyCauseCounts(): CauseCounts {
  return Object.fromEntries(FINDING_CAUSES.map((c) => [c, 0])) as CauseCounts;
}

/**
 * 見直しの結果（RN-9）。重い・軽い指摘の数と、通ったか（重い指摘が残っていない）。
 * 見直し役が `run review-result` で見直しの Run に書く。見直し以外の Run と、書かれていない Run は null
 */
const runReviewSchema = z.looseObject({
  heavy: toolCount,
  light: toolCount,
  passed: z.boolean(),
  /**
   * 重い指摘と軽い指摘のそれぞれの、原因ごとの数（それぞれの合計は heavy・light と同じ）。指摘の一覧から dg が数える。
   * この項目より前の Run と、数だけを渡す前の形の結果にはキーを書かない（省けば原因は測れていない。集計は missing に数える）
   */
  causes: z.looseObject({ heavy: causeCountsSchema, light: causeCountsSchema }).optional(),
});
export type RunReview = z.output<typeof runReviewSchema>;

/** 見直しの指摘の重さ。heavy は受け入れ条件の漏れ・不具合・文書との食い違い・規約の違反、light は言い回し・好み・前からのずれ */
export const FINDING_SEVERITIES = ["heavy", "light"] as const;

/**
 * 見直しの指摘の 1 件（run review-result --findings-file）。見直し役が一覧で返し、dg が数と通ったかを求める。
 * 知らない項目は誤りにする（書き間違えた項目名で reason や fix が落ちないように）
 */
export const reviewFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES).describe("heavy or light"),
  category: z
    .string()
    .min(1)
    .describe(
      "What is wrong in the deliverable (a missed acceptance criterion, a bug, a mismatch with the documents, a convention violation, a mismatch with a reference section, and so on)",
    ),
  // 種類の一覧と意味は run review-result のヘルプ（commands/run.ts）が正本。ここは値の一覧だけを書き、意味はヘルプに任せる
  cause: z
    .enum(FINDING_CAUSES)
    .describe(
      `Why the finding came about, apart from category: one of ${FINDING_CAUSES.join(", ")} (the meaning of each is in dg run review-result --help)`,
    ),
  file: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe("Path from the repository root, or null if there is none"),
  line: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe("Line number starting at 1, or null if there is none"),
  reason: z.string().min(1).describe("Why this is a finding"),
  fix: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe("How to fix it, or null if there is none"),
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
   * 会話記録のセッション ID（RN-1）。開くときに渡されなければ null。記録のパスはマシンごとに違い、ホームのパスとユーザ名を含むので
   * Git に入る Run には書かず、deguboard-local/transcripts/ に置く（run/record.ts）。この項目より前に書いた Run にはキーがないので、読むときに null にそろえる
   */
  session: z.string().min(1).nullable().default(null),
  /** 見直しの結果。この項目より前に書いた Run にはキーがないので、読むときに null にそろえる */
  review: runReviewSchema.nullable().default(null),
  /**
   * 見直した状態：見直しの Run を開いたとき（保留から書いた記録は結果を書いたとき）の作業ブランチのローカルの先端の SHA（RN-10。t763）。
   * dg gate の review と dg next の段階は、この SHA がリモートの先端と同じかで見直しの新しさを判定する。
   * 見直し以外の Run・読めなかった Run・この項目より前の Run にはキーを書かない（省けば、見直しの開始とリモートの先端のコミットの時刻を比べる）
   */
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  /**
   * 会話記録を取らずに作った記録の印（RN-1）。none は、フックが届かず持ち主のないまま残った見直しの結果（保留）から
   * dg sync・dg pr ready が書いた見直しの記録（commands/orphan-review.ts）。ほかの Run にはキーを書かない（省けば会話記録を取る Run）。
   * 前景の見直し役が動いている間に書いた記録は、返ったときに起動のフックが会話記録を結び付けてキーを外す（t701）
   */
  capture: z.literal("none").optional(),
  /**
   * 親の依頼を待った秒数（RN-1）。閉じるときに Adapter が会話記録から数えた待ちの区間を、started_at〜finished_at で切って足した値。
   * 実行時間（finished_at − started_at）はこの待ちを含み、作業時間は表示と集計のたびに実行時間から引いて出す（model/metrics.ts）。
   * 数えられない Run（実行中、親が自分で開いた Run、待ちを数えない Adapter の Run、記録を読めなかった Run）は null で、0 で補わない（RN-2）。
   * この項目より前に書いた Run にはキーがないので、読むときに null にそろえる
   */
  waited_seconds: z.number().int().nonnegative().nullable().default(null),
  /**
   * 検査とテストのコマンドを前景で回していた秒数（RN-1）。閉じるときに Adapter が会話記録から数えた、数えるコマンド
   * （agents/check-commands.ts）の Bash の呼び出しから結果までの区間を、started_at〜finished_at で切って足した値。
   * 数えられない Run（実行中、コマンドを読まない Adapter の Run、記録を読めなかった Run）は null で、0 で補わない（RN-2）。
   * この項目より前に書いた Run にはキーがないので、読むときに null にそろえる
   */
  check_seconds: z.number().int().nonnegative().nullable().default(null),
  /**
   * 止まって待っている印（RN-7）。サブエージェントが step を終えた事実のないまま止まった時刻（親への質問など）。
   * 実行中の記録にだけ置き、閉じた Run（Git）には書かない。再開（同じ agent_id の起動）で消す。この項目より前の記録とは null にそろえる
   */
  waiting_since: isoDateTime.nullable().default(null),
  /**
   * 記録の書き終わりを待つ印（RN-7）。step を終えた事実はあるが、止まった時に最後の応答がまだ書かれていなかった時刻。
   * 次のフック・dg sync・SessionEnd が書き終わりを見て閉じる。止まって待っている印とは別で、実行中の記録にだけ置く
   */
  settling_since: isoDateTime.nullable().default(null),
});
export type Run = z.output<typeof runSchema>;

/** 待ちの区間と、検査とテストを回していた区間。時刻はエポックからのミリ秒で、from < to */
export interface WaitInterval {
  from: number;
  to: number;
}

/**
 * 待ちの区間を Run の範囲（started_at〜finished_at）で切って足した秒数（四捨五入）。区間が数えられていない（null）か、
 * 範囲の時刻が読めなければ null。重なる区間は二重に数えない。範囲で切るので、実行時間を超えない。
 * 検査とテストを回していた区間（check_seconds）も同じ切り方で足す（並べて回したコマンドの重なりを二重に数えない）
 */
export function waitedSeconds(
  intervals: readonly WaitInterval[] | null,
  startedAt: string,
  finishedAt: string,
): number | null {
  if (intervals === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  let total = 0;
  let covered = start;
  for (const { from, to } of [...intervals].sort((a, b) => a.from - b.from)) {
    const lo = Math.max(from, covered);
    const hi = Math.min(to, end);
    if (hi <= lo) continue;
    total += hi - lo;
    covered = hi;
  }
  return Math.round(total / 1000);
}

/** どれも取れていない使用量 */
export function emptyUsage(): RunUsage {
  return { input: null, output: null, cache_read: null, cache_write: null };
}
