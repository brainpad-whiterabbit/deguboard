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
/** チェックリストの 1 行。[1] が印、[2] が文 */
const CHECK_ITEM = /^- \[([ xX])\] (.*\S)[ \t]*$/gm;

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
  const range = acceptanceRange(body);
  return range && body.slice(range.start, range.end);
}

/** 節の本文の位置（見出しの次の文字から、次の見出しの手前か末尾まで） */
function acceptanceRange(body: string): { start: number; end: number } | undefined {
  const m = ACCEPTANCE_HEADING.exec(body);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const next = /^## /m.exec(body.slice(start));
  return { start, end: next ? start + next.index : body.length };
}

/**
 * `## 受け入れ条件` の節の項目を items で置き換えた本文を返す。他の節は変えない。
 * 同じ文の項目が済み（`- [x]`）なら印を保つ（TK-5）。節がなければ末尾に足す
 */
export function replaceAcceptance(body: string, items: readonly string[]): string {
  const range = acceptanceRange(body);
  const current = range ? body.slice(range.start, range.end) : "";
  const checked = new Set(
    [...current.matchAll(CHECK_ITEM)].filter((m) => m[1] !== " ").map((m) => m[2]),
  );
  const lines = items.map((raw) => {
    const text = raw.trim();
    return `- [${checked.has(text) ? "x" : " "}] ${text}`;
  });
  const section = `\n\n${lines.join("\n")}\n`;
  if (!range) {
    const sep = body === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return `${body}${sep}## 受け入れ条件${section}`;
  }
  // 次の節が続くなら空行で区切る
  const tail = range.end < body.length ? "\n" : "";
  return body.slice(0, range.start) + section + tail + body.slice(range.end);
}
