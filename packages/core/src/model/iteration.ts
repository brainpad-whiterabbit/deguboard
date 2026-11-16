// Iteration（iterations/s3.yaml。requirements.md 5.6、期間は実績だけを持つ判断は ADR-009）。所属はチケットの iteration で表し、ここに一覧は持たない（IT-2）

import { z } from "zod";
import { isoDateTime, RETIRED_PROJECT_KEYS } from "./common.js";
import { compareIds, iterationIdSchema } from "./id.js";

export const ITERATION_STATUSES = ["planned", "active", "closed"] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

/**
 * 関所を持つ流れの段階（dg checkpoint が受ける名前）。plan は Plan の承認の記録（approved_by）が受け持つので、関所を持たない
 */
export const CHECKPOINT_STAGES = ["assign", "check", "audit", "release", "retro"] as const;
export type CheckpointStage = (typeof CHECKPOINT_STAGES)[number];

/**
 * 関所を通った記録（dg checkpoint が足す。EX-8）。basis は通ったときに見たもの（根拠）で、段階ごとに 1 つ：
 * assign は割り当ての候補、check はチケットの事実のハッシュ、audit は done だったチケット。release・retro は根拠を持たない。
 * dg flow next は、根拠が今の事実に合う記録だけを数える（commands/flow-records.ts）
 */
export const checkpointSchema = z.looseObject({
  // 名前は文字列で読む（新しい版の dg が足した段階の記録で、古い版の読みを止めない）
  name: z.string().min(1),
  at: isoDateTime,
  /** 関所を呼んだ主体（`eiki` か `eiki/agent`） */
  by: z.string().min(1),
  /** 承認した人（--auto で聞かずに進めたときは、進めたエージェント）。承認の要らない呼び出しにはない */
  approved_by: z.string().min(1).optional(),
  basis: z
    .looseObject({
      candidates: z.array(z.string()).optional(),
      facts: z.string().optional(),
      done: z.array(z.string()).optional(),
    })
    .optional(),
});
export type Checkpoint = z.output<typeof checkpointSchema>;

const iterationFields = z.looseObject({
  id: iterationIdSchema,
  name: z.string().min(1),
  goal: z.string().default(""),
  status: z.enum(ITERATION_STATUSES).default("planned"),
  // 期間は実績だけを持つ：active になった日時（iteration start と claim の自動の開始で書き、reopen では変えない）と閉じた日時。
  // started_at を書く前に始めた Iteration にはない
  started_at: isoDateTime.optional(),
  closed_at: isoDateTime.optional(),
  // 再開した日時（iteration reopen が書く）。これより前の関所の記録は数えない
  reopened_at: isoDateTime.optional(),
  // 閉じたときの件数（closed のときだけ）
  completed: z.number().int().nonnegative().optional(),
  carried_over: z.number().int().nonnegative().optional(),
  // 関所を通った記録。消さずに足す（無効になった記録も残す）。関所を通るまではない
  checkpoints: z.array(checkpointSchema).optional(),
});

/** 予定の開始日・終了日と Project として前に書いていたキー。読むときは値に出さず、Iteration を書くたびにファイルから消す（Store の retired） */
export const RETIRED_ITERATION_KEYS = ["start", "end", ...RETIRED_PROJECT_KEYS] as const;

// 予定の期間と Project は持たない。古いファイルの start・end・project は形を問わず読み飛ばす
export const iterationSchema = iterationFields.transform(
  ({ start: _start, end: _end, project: _project, ...it }) => it,
);
export type Iteration = z.output<typeof iterationSchema>;

/**
 * 数える関所の記録（古い順）。iteration reopen より前の記録は数えない（日時で判定し、記録は消さない）。
 * 時刻は秒までなので、再開と同じ秒の記録は再開のあとに数える（閉じた Iteration を再開した直後に通った関所を落とさない。
 * 再開の前の記録が同じ秒になるには、同じ秒のうちに閉じて再開する必要がある）
 */
export function countedCheckpoints(
  it: Pick<Iteration, "checkpoints" | "reopened_at">,
): Checkpoint[] {
  const reopened = it.reopened_at === undefined ? undefined : Date.parse(it.reopened_at);
  return (it.checkpoints ?? []).filter(
    (c) => reopened === undefined || Date.parse(c.at) >= reopened,
  );
}

type ActiveCheck = Pick<Iteration, "id" | "status">;

/**
 * ほかに active の Iteration（IT-1。active はカンバンに 1 つ）。自分自身は数えない。
 * いくつもあれば番号の小さいもの。開始・再開の拒否（iteration.start・reopen）に使う
 */
export function otherActiveOf<T extends ActiveCheck>(
  iterations: Iterable<T>,
  it: Pick<Iteration, "id">,
): T | undefined {
  return [...iterations]
    .filter((i) => i.id !== it.id && i.status === "active")
    .sort((a, b) => compareIds(a.id, b.id))[0];
}

/** ほかに active があって開始・再開を拒否するときの理由 */
export function otherActiveMessage(otherId: string, itId: string, verb: string): string {
  return `${otherId} is active, so ${itId} cannot be ${verb} (only one Iteration can be active). Close ${otherId} first (a person decides whether to close it)`;
}
