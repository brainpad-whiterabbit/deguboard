// Iteration（iterations/s3.yaml。requirements.md 5.6）。所属はチケットの iteration で表し、ここに一覧は持たない（IT-2）

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import { iterationIdSchema } from "./id.js";

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
