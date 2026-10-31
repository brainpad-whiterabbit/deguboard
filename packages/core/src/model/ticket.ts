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

/** `## 受け入れ条件` の見出し行。節の切り出しと雛形で共有する */
const ACCEPTANCE_HEADING = /^## 受け入れ条件[ \t]*$/m;

/**
 * 本文の雛形（TK-3）。`## 概要` に summary を、`## 受け入れ条件` に acceptance の項目をチェックリストで置く。
 * 項目がなければ空の `- [ ] ` を 1 行置く（lint が空として指摘する）
 */
export function ticketBodyTemplate(summary = "", acceptance: readonly string[] = []): string {
  const items = acceptance.length === 0 ? ["- [ ] "] : acceptance.map((a) => `- [ ] ${a.trim()}`);
  return `## 概要\n\n${summary}\n\n## 受け入れ条件\n\n${items.join("\n")}\n`;
}

/**
 * 本文から `## 受け入れ条件` の節（見出しの次の行から、次の `## ` 見出しの手前か末尾まで）を返す。
 * 見出しがなければ undefined
 */
export function acceptanceSection(body: string): string | undefined {
  const m = ACCEPTANCE_HEADING.exec(body);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
