// ticket list の絞り込み。画面のバックログ（web の filterBacklog）は画面だけの条件（Epic なし・自分など）を持つので別に書き、
// 検索語の当て方（matchesQuery）だけを web の ticketMatchesQuery に写す（同じ結果になることを web の types.test.ts で確かめる）

import { z } from "zod";
import { STATUSES } from "../model/common.js";
import { PRIORITIES, type Ticket } from "../model/ticket.js";
import type { Store } from "../storage/store.js";

export const ticketFilterSchema = z.object({
  project: z.string().optional().describe("Filter by Project. Omit for all"),
  status: z.array(z.enum(STATUSES)).optional().describe("Filter by Status"),
  priority: z.array(z.enum(PRIORITIES)).optional().describe("Filter by priority"),
  iteration: z.string().optional().describe("Filter by Iteration ID"),
  epic: z.string().optional().describe("Filter by Epic ID"),
  label: z.array(z.string()).optional().describe("Has any of these labels"),
  assignee: z
    .string()
    .optional()
    .describe("Filter by assignee ID (human for yourself, agent for your own AI)"),
  created_by: z
    .string()
    .optional()
    .describe("Filter by creator ID (human for yourself, agent for your own AI)"),
  ready: z
    .boolean()
    .optional()
    .describe(
      "Only tickets that can be started (todo with all dependencies done or abandoned). Assignment is not checked (filter with assignee)",
    ),
  include_abandoned: z
    .boolean()
    .optional()
    .describe("Include abandoned (when status is not given)"),
  query: z.string().optional().describe("Partial match on number, title, or label"),
});
export type TicketFilter = z.output<typeof ticketFilterSchema>;

function isReady(store: Store, t: Ticket): boolean {
  return t.status === "todo" && store.depsDone(t);
}

export function matchesFilter(store: Store, t: Ticket, f: TicketFilter): boolean {
  if (f.project && t.project !== f.project) return false;
  if (f.status) {
    if (!f.status.includes(t.status)) return false;
  } else if (t.status === "abandoned" && !f.include_abandoned) return false;
  if (f.priority && !f.priority.includes(t.priority)) return false;
  if (f.iteration && t.iteration !== f.iteration) return false;
  if (f.epic && t.epic !== f.epic) return false;
  if (f.label && !f.label.some((l) => t.labels.includes(l))) return false;
  if (f.assignee && t.assignee !== f.assignee) return false;
  if (f.created_by && t.created_by !== f.created_by) return false;
  if (f.ready && !isReady(store, t)) return false;
  if (f.query && !matchesQuery(t, f.query)) return false;
  return true;
}

/**
 * 検索語に当たるか：番号・タイトル（labels なら加えてラベル）の部分一致。前後の空白は除き、大文字小文字は区別しない。
 * 空の検索語はすべてに当たる。ticket list の query と、画面のバックログ・履歴の検索の当て方の正本
 */
export function matchesQuery(
  t: Pick<Ticket, "id" | "title" | "labels">,
  query: string,
  labels = true,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    t.id.toLowerCase().includes(q) ||
    t.title.toLowerCase().includes(q) ||
    (labels && t.labels.some((l) => l.toLowerCase().includes(q)))
  );
}
