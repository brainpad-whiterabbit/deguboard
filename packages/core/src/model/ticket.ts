// Ticket の frontmatter（tickets/t12.md。requirements.md 5.4）

import { z } from "zod";
import { isoDateTime, slugSchema, statusSchema } from "./common.js";
import { epicIdSchema, iterationIdSchema, ticketIdSchema } from "./id.js";

export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

// スキーマにないキーは looseObject で残す（DT-2）。Workflow の fields の値もここを通る
export const ticketSchema = z.looseObject({
  id: ticketIdSchema,
  project: slugSchema,
  title: z.string().min(1),
  status: statusSchema,
  priority: z.enum(PRIORITIES).default("medium"),
  labels: z.array(z.string()).default([]),
  iteration: iterationIdSchema.optional(),
  epic: epicIdSchema.optional(),
  depends_on: z.array(ticketIdSchema).default([]),
  workflow: slugSchema.optional(),
  claimed_by: z.string().optional(),
  branch: z.string().optional(),
  pr: z.number().int().positive().optional(),
  runs: z.array(z.string()).default([]),
  provisional: z.boolean().optional(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type Ticket = z.output<typeof ticketSchema>;

/** 本文の雛形（TK-3）。`## 概要` と `## 受け入れ条件` を推奨する */
export function ticketBodyTemplate(summary = ""): string {
  return `## 概要\n\n${summary}\n\n## 受け入れ条件\n\n- [ ] \n`;
}
