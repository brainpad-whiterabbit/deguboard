// 画面が使う型。core からは型だけを取り、実行時のコードは取り込まない（web は core の型と CommandClient にだけ依存する。ADR-007）

import type {
  Epic,
  FieldDefinition,
  Iteration,
  Priority,
  Status,
  Ticket,
  WorkflowDefinition,
} from "@deguboard/core";

export type { Epic, FieldDefinition, Iteration, Priority, Status, Ticket, WorkflowDefinition };

/** カンバンの列の順。abandoned は既定で隠す（UI-2） */
export const STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
  "abandoned",
] as const satisfies readonly Status[];
export const BOARD_STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
] as const satisfies readonly Status[];
export const PRIORITIES = ["low", "medium", "high"] as const satisfies readonly Priority[];

export interface Project {
  id: string;
  name: string;
  description: string;
  workflow: string;
  status: "active" | "archived";
}

/** epic.list の 1 行（進捗は都度求める。EP-3） */
export interface EpicProgress {
  total: number;
  done: number;
  by_status: Record<Status, number>;
}
export type EpicRow = Epic & { progress: EpicProgress };
export type EpicDetail = EpicRow & { body: string; tickets: Ticket[] };
export type IterationDetail = Iteration & { items: Ticket[] };
export type TicketDetail = Ticket & { body: string; dependents: string[]; deps_done: boolean };
export interface WorkflowView {
  definition: WorkflowDefinition;
  labels: Record<Status, string>;
  transitions: { from: Status; to: Status; by: string[]; requires: string[] }[];
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function ticketNumber(id: string): number {
  return Number(id.slice(1));
}

/** 優先度（high → low）、同じなら番号の順（UI-3、IT-2） */
export function byPriorityThenNumber(a: Ticket, b: Ticket): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || ticketNumber(a.id) - ticketNumber(b.id)
  );
}

export function byNumber(a: { id: string }, b: { id: string }): number {
  return ticketNumber(a.id) - ticketNumber(b.id);
}
