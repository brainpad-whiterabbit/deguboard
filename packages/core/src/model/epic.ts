// Epic の frontmatter（epics/e3.md。requirements.md 5.5）

import { z } from "zod";
import { isoDateTime } from "./common.js";
import { epicIdSchema } from "./id.js";
import { BODY_HEADINGS } from "./ticket.js";

export const EPIC_STATUSES = ["open", "closed"] as const;
export type EpicStatus = (typeof EPIC_STATUSES)[number];

const epicFrontmatter = z.looseObject({
  id: epicIdSchema,
  title: z.string().min(1),
  status: z.enum(EPIC_STATUSES),
  labels: z.array(z.string()).default([]),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  closed_at: isoDateTime.optional(),
});
// やめた project は値に出さない（common.ts の RETIRED_PROJECT_KEYS）
export const epicSchema = epicFrontmatter.transform(({ project: _project, ...e }) => e);
export type Epic = z.output<typeof epicSchema>;

/** 本文の雛形（EP-1）。`## Summary` に summary を置く */
export function epicBodyTemplate(summary = ""): string {
  return `## ${BODY_HEADINGS.summary.en}\n\n${summary}\n`;
}
