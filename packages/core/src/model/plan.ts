// Plan（plans/p7.yaml。requirements.md 5.7）。コマンドはまだなく、スキーマだけ

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import { planIdSchema, ticketIdSchema } from "./id.js";

export const planSchema = z.looseObject({
  id: planIdSchema,
  project: slugSchema,
  tickets: z.array(ticketIdSchema).default([]),
  // 計画内だけの待ち。キーのチケットは値のチケットの後に進める
  after: z.record(ticketIdSchema, z.array(ticketIdSchema)).default({}),
  pending_approval: z.boolean().default(true),
  approved_by: z.string().optional(),
  approved_at: isoDateTime.optional(),
  details: z
    .record(
      ticketIdSchema,
      z.looseObject({ scope: z.string().optional(), approach: z.string().optional() }),
    )
    .default({}),
  closed_at: isoDateTime.optional(),
});
export type Plan = z.output<typeof planSchema>;
