// 画面が使う型。core からは型だけを取り、実行時のコードは取り込まない（web は core の型と CommandClient にだけ依存する。ADR-007）

import type {
  Epic,
  FieldDefinition,
  HistoryChange,
  HistoryEvent,
  HistoryLog,
  Iteration,
  MetricGroup,
  MetricUnit,
  MetricsView,
  Priority,
  RunMetrics,
  RunView,
  Status,
  Ticket,
  WorkflowDefinition,
} from "@deguboard/core";

export type {
  Epic,
  FieldDefinition,
  HistoryChange,
  HistoryEvent,
  HistoryLog,
  Iteration,
  MetricGroup,
  MetricUnit,
  MetricsView,
  Priority,
  RunMetrics,
  RunView,
  Status,
  Ticket,
  WorkflowDefinition,
};

/**
 * 集計の単位の表示名（core の METRIC_UNITS の順）。web は core の実行時のコードを取り込まないので写し、
 * Record で core の MetricUnit の全件と照らす（core に単位が増えると型の検査で漏れが分かる）
 */
export const UNIT_LABELS: Record<MetricUnit, string> = {
  run: "Run",
  ticket: "チケット",
  epic: "Epic",
  iteration: "Iteration",
  project: "Project",
  agent: "Agent",
  model: "Model",
};
/** Run の画面で選べる集計の単位。画面は選んだ Project で絞って集計するので project は除く */
export const METRIC_UNITS: readonly MetricUnit[] = (
  Object.keys(UNIT_LABELS) as MetricUnit[]
).filter((u) => u !== "project");

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

/** Iteration と Epic の状態の表示名 */
export const ITERATION_LABELS: Record<Iteration["status"], string> = {
  planned: "予定",
  active: "進行中",
  closed: "終了",
};
export const EPIC_LABELS: Record<Epic["status"], string> = { open: "進行中", closed: "終了" };

/** 絞り込みで「担当者なし」を表す値。主体の ID（`eiki` / `eiki/agent`）とは重ならない */
export const NO_CLAIM = "-";

/** 担当者の短い表示。ID は `eiki` / `eiki/agent` の形でそのまま出す。旧 ID（user@host）は @ の前だけにし、全文はツールチップで読む */
export function actorLabel(id: string): string {
  return id.split("@")[0] || id;
}

/** 担当者の絞り込みの選択肢：出てくる assignee（名前順）と、担当者のないチケットがあれば「なし」 */
export function claimOptions(tickets: readonly Ticket[]): string[] {
  const ids = [...new Set(tickets.flatMap((t) => (t.assignee ? [t.assignee] : [])))].sort();
  if (ids.length === 0) return [];
  return tickets.some((t) => !t.assignee) ? [...ids, NO_CLAIM] : ids;
}

/** 担当者の絞り込み。空はすべて、NO_CLAIM は担当者のないもの */
export function matchesClaim(ticket: Ticket, claim: string): boolean {
  if (!claim) return true;
  if (claim === NO_CLAIM) return !ticket.assignee;
  return ticket.assignee === claim;
}

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
export type TicketDetail = Ticket & {
  body: string;
  dependents: string[];
  deps_done: boolean;
  plan: string | null;
};
export interface WorkflowView {
  definition: WorkflowDefinition;
  labels: Record<Status, string>;
  transitions: { from: Status; to: Status; by?: string[]; requires: string[] }[];
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
