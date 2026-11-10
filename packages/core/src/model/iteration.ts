// Iteration（iterations/s3.yaml。requirements.md 5.6、期間は実績だけを持つ判断は ADR-009）。所属はチケットの iteration で表し、ここに一覧は持たない（IT-2）

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import { compareIds, iterationIdSchema } from "./id.js";

export const ITERATION_STATUSES = ["planned", "active", "closed"] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

const iterationFields = z.looseObject({
  id: iterationIdSchema,
  project: slugSchema,
  name: z.string().min(1),
  goal: z.string().default(""),
  status: z.enum(ITERATION_STATUSES).default("planned"),
  // 期間は実績だけを持つ：active になった日時（iteration start と claim の自動の開始で書き、reopen では変えない）と閉じた日時。
  // started_at を書く前に始めた Iteration にはない
  started_at: isoDateTime.optional(),
  closed_at: isoDateTime.optional(),
  // 閉じたときの件数（closed のときだけ）
  completed: z.number().int().nonnegative().optional(),
  carried_over: z.number().int().nonnegative().optional(),
});

/** 予定の開始日・終了日として前に書いていたキー。読むときは値に出さず、Iteration を書くたびにファイルから消す（Store の retired） */
export const RETIRED_ITERATION_KEYS = ["start", "end"] as const;

// 予定の期間は持たない。古いファイルの start・end は形を問わず読み飛ばす
export const iterationSchema = iterationFields.transform(
  ({ start: _start, end: _end, ...it }) => it,
);
export type Iteration = z.output<typeof iterationSchema>;

type ActiveCheck = Pick<Iteration, "id" | "project" | "status">;

/**
 * 同じ Project でほかに active の Iteration（IT-1。active は Project に 1 つ）。自分自身と別の Project のものは数えない。
 * いくつもあれば番号の小さいもの。開始・再開の拒否（iteration.start・reopen）に使う
 */
export function otherActiveOf<T extends ActiveCheck>(
  iterations: Iterable<T>,
  it: Pick<Iteration, "id" | "project">,
): T | undefined {
  return [...iterations]
    .filter((i) => i.id !== it.id && i.project === it.project && i.status === "active")
    .sort((a, b) => compareIds(a.id, b.id))[0];
}

/** ほかに active があって開始・再開を拒否するときの理由 */
export function otherActiveMessage(otherId: string, itId: string, verb: string): string {
  return `${otherId} is active, so ${itId} cannot be ${verb} (only one Iteration per Project can be active). Close ${otherId} first (a person decides whether to close it)`;
}
