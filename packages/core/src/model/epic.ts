// Epic の frontmatter（epics/e3.md。requirements.md 5.5）

import { z } from "zod";
import { isoDateTime, RETIRED_PROJECT_KEYS } from "./common.js";
import { epicIdSchema } from "./id.js";
import { BODY_HEADINGS } from "./ticket.js";

export const EPIC_STATUSES = ["open", "closed"] as const;
export type EpicStatus = (typeof EPIC_STATUSES)[number];

/**
 * Epic が前に持っていたキー。読むときは値に出さず、書くたびにファイルから消す（Store の retired）。
 * labels は書くだけで画面・絞り込み・guide のどこも読まず、中のチケットの分野の写しになっていた。ラベルはチケットだけが持つ
 */
export const RETIRED_EPIC_KEYS = [...RETIRED_PROJECT_KEYS, "labels"] as const;

const epicFrontmatter = z.looseObject({
  id: epicIdSchema,
  title: z.string().min(1),
  status: z.enum(EPIC_STATUSES),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  closed_at: isoDateTime.optional(),
});
// やめた project・labels は値に出さない（RETIRED_EPIC_KEYS）。古い labels の形は問わない
export const epicSchema = epicFrontmatter.transform(
  ({ project: _project, labels: _labels, ...e }) => e,
);
export type Epic = z.output<typeof epicSchema>;

/** 本文の雛形（EP-1）。`## Summary` に summary を置く */
export function epicBodyTemplate(summary = ""): string {
  return `## ${BODY_HEADINGS.summary.en}\n\n${summary}\n`;
}
