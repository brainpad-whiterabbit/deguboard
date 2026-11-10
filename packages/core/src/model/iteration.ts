// Iteration（iterations/s3.yaml。requirements.md 5.6）。所属はチケットの iteration で表し、ここに一覧は持たない（IT-2）

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import { compareIds, iterationIdSchema } from "./id.js";

export const ITERATION_STATUSES = ["planned", "active", "closed"] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

const isoDate = z.iso.date();

export const iterationSchema = z.looseObject({
  id: iterationIdSchema,
  project: slugSchema,
  name: z.string().min(1),
  goal: z.string().default(""),
  start: isoDate.optional(),
  end: isoDate.optional(),
  status: z.enum(ITERATION_STATUSES).default("planned"),
  closed_at: isoDateTime.optional(),
  // 閉じたときの件数（closed のときだけ）
  completed: z.number().int().nonnegative().optional(),
  carried_over: z.number().int().nonnegative().optional(),
});
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
