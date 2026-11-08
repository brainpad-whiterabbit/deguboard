// コマンドの実装で共通に使う小さな関数

import { z } from "zod";
import { UsageError } from "../errors.js";
import { compareIds, parseId, type IdKind, type IdOf, type TicketId } from "../model/id.js";
import { isTerminal, toIsoDateTime, type Status } from "../model/common.js";
import type { Plan } from "../model/plan.js";
import type { Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { Store } from "../storage/store.js";
import type { CommandContext } from "./define.js";

export const nowIso = (ctx: CommandContext): string => toIsoDateTime(ctx.now());

/** 手元の暦日（YYYY-MM-DD）。Iteration の期限は利用者の暦で数える（web の periodNote と同じ） */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 終了日（YYYY-MM-DD か日時）が today より前か。終了日の当日は過ぎていない。終了日がなければ false */
export function isOverdue(end: string | undefined, today: string): boolean {
  return end !== undefined && end.slice(0, 10) < today;
}

/**
 * Iteration の中のチケットの Status から、完了（1 件以上で全件が終わり）と期限切れ（active で終了日を過ぎて未完了あり）を求める。
 * iteration.show の next と ask の候補が同じ判定を使う正本
 */
export function iterationReadiness(
  it: { status: string; end?: string | undefined },
  statuses: readonly (Status | undefined)[],
  today: string,
): { complete: boolean; overdue: boolean; unfinished: number } {
  const unfinished = statuses.filter((st) => st === undefined || !isTerminal(st)).length;
  return {
    complete: statuses.length > 0 && unfinished === 0,
    overdue: it.status === "active" && isOverdue(it.end, today) && unfinished > 0,
    unfinished,
  };
}

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

/** `t12` でも `12` でも受け付ける参照 */
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

/** Iteration の中の並び（IT-3）。優先度の高い順、同じなら番号順 */
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
