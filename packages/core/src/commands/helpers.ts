// コマンドの実装で共通に使う小さな関数

import { z } from "zod";
import { UsageError } from "../errors.js";
import { compareIds, parseId, type IdKind, type IdOf, type TicketId } from "../model/id.js";
import { toIsoDateTime } from "../model/common.js";
import type { Plan } from "../model/plan.js";
import type { Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { Store } from "../storage/store.js";
import type { CommandContext } from "./define.js";

export const nowIso = (ctx: CommandContext): string => toIsoDateTime(ctx.now());

/** `t12` でも `12` でも受け付ける参照 */
/**
 * 今あるかは確かめず、ID の形だけを確かめて整える（消えた・閉じたものの記録も引けるように）。
 * 未指定なら undefined、形が違えば UsageError
 */
export function idShapeOf<K extends IdKind>(ref: string | undefined, kind: K): IdOf<K> | undefined {
  if (ref === undefined) return undefined;
  const id = parseId(ref, kind);
  if (!id) throw new UsageError(`${ref} は ${kind} の ID ではない`);
  return id;
}

export const ticketRef = z.string().min(1).describe("チケットの ID（t12 または 12）");
export const epicRef = z.string().min(1).describe("Epic の ID（e3 または 3）");
export const iterationRef = z.string().min(1).describe("Iteration の ID（s3 または 3）");
export const planRef = z.string().min(1).describe("Plan の ID（p7 または 7）");

export function projectOf(ctx: CommandContext, project: string | undefined): string {
  return project ?? ctx.config.default_project;
}

export function sortedDocs<T extends { id: string }>(docs: Iterable<Doc<T>>): Doc<T>[] {
  return [...docs].sort((a, b) => compareIds(a.id, b.id));
}

export function ticketsInEpic(store: Store, epicId: string): Doc<Ticket>[] {
  return sortedDocs([...store.tickets.values()].filter((t) => t.data.epic === epicId));
}

const PRIORITY_RANK: Record<Ticket["priority"], number> = { high: 0, medium: 1, low: 2 };

/** Iteration の中の並び（IT-2）。優先度の高い順、同じなら番号順 */
export function ticketsInIteration(store: Store, iterationId: string): Doc<Ticket>[] {
  return sortedDocs(
    [...store.tickets.values()].filter((t) => t.data.iteration === iterationId),
  ).sort((a, b) => PRIORITY_RANK[a.data.priority] - PRIORITY_RANK[b.data.priority]);
}

/** 本文つきの表示用の形 */
export function withBody<T>(doc: Doc<T>): T & { body: string } {
  return { ...doc.data, body: doc.body };
}

export function dependents(store: Store, id: TicketId): TicketId[] {
  return sortedDocs([...store.tickets.values()].filter((t) => t.data.depends_on.includes(id))).map(
    (t) => t.data.id,
  );
}

/** 開いた（closed_at のない）Plan のうち、チケットを含むもの。PL-3 で高々 1 つ */
export function openPlanOf(store: Store, ticket: TicketId): Doc<Plan> | undefined {
  for (const plan of store.plans.values()) {
    if (plan.data.closed_at === undefined && plan.data.tickets.includes(ticket)) return plan;
  }
  return undefined;
}
