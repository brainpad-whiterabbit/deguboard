// ticket list の絞り込み。UI のバックログと共用する

import { z } from "zod";
import { STATUSES } from "../model/common.js";
import { PRIORITIES, type Ticket } from "../model/ticket.js";
import type { Store } from "../storage/store.js";

export const ticketFilterSchema = z.object({
  project: z.string().optional().describe("Project で絞る。省略時はすべて"),
  status: z.array(z.enum(STATUSES)).optional().describe("Status で絞る"),
  priority: z.array(z.enum(PRIORITIES)).optional(),
  iteration: z.string().optional().describe("Iteration の ID で絞る"),
  epic: z.string().optional().describe("Epic の ID で絞る"),
  label: z.array(z.string()).optional().describe("いずれかのラベルを持つ"),
  assignee: z.string().optional().describe("担当者の ID で絞る（human で自分、agent で自分の AI）"),
  created_by: z
    .string()
    .optional()
    .describe("起票者の ID で絞る（human で自分、agent で自分の AI）"),
  ready: z
    .boolean()
    .optional()
    .describe(
      "着手できる（todo で依存先が全部 done か abandoned）ものだけ。担当者の有無は見ない（assignee で絞る）",
    ),
  include_abandoned: z
    .boolean()
    .optional()
    .describe("abandoned も含める（status を指定しないとき）"),
  query: z.string().optional().describe("番号・タイトル・ラベルの部分一致"),
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
  if (f.query) {
    const q = f.query.toLowerCase();
    const hit =
      t.id.includes(q) ||
      t.title.toLowerCase().includes(q) ||
      t.labels.some((l) => l.toLowerCase().includes(q));
    if (!hit) return false;
  }
  return true;
}
