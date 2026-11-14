// Plan（plans/p7.yaml。requirements.md 5.7）。操作は commands/plan.ts

import { z } from "zod";
import { isoDateTime } from "./common.js";
import { planIdSchema, ticketIdSchema } from "./id.js";

/** チケットの難しさの段階。config の models.* でモデル名に対応させる（モデル名は Plan に書かない） */
export const PLAN_TIERS = ["light", "standard", "heavy"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

const planFields = z.looseObject({
  id: planIdSchema,
  tickets: z.array(ticketIdSchema).default([]),
  // 計画内だけの待ち。キーのチケットは値のチケットの後に進める
  after: z.record(ticketIdSchema, z.array(ticketIdSchema)).default({}),
  pending_approval: z.boolean().default(true),
  approved_by: z.string().optional(),
  approved_at: isoDateTime.optional(),
  details: z
    .record(
      ticketIdSchema,
      z.looseObject({
        scope: z.string().optional(),
        approach: z.string().optional(),
        tier: z.enum(PLAN_TIERS).optional(),
      }),
    )
    .default({}),
  closed_at: isoDateTime.optional(),
});
// やめた project は値に出さない（common.ts の RETIRED_PROJECT_KEYS）
export const planSchema = planFields.transform(({ project: _project, ...p }) => p);
export type Plan = z.output<typeof planSchema>;
