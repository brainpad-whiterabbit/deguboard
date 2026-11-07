// Epic の frontmatter（epics/e3.md。requirements.md 5.5）

import { z } from "zod";
import { isoDateTime, slugSchema } from "./common.js";
import { epicIdSchema } from "./id.js";

export const EPIC_STATUSES = ["open", "closed"] as const;

export const epicSchema = z.looseObject({
  id: epicIdSchema,
  project: slugSchema,
  title: z.string().min(1),
  status: z.enum(EPIC_STATUSES),
  labels: z.array(z.string()).default([]),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  closed_at: isoDateTime.optional(),
});
export type Epic = z.output<typeof epicSchema>;

export function epicBodyTemplate(summary = ""): string {
  return `## 概要\n\n${summary}\n`;
}
