// 画面が使う型。core からは型だけを取り、実行時のコードは取り込まない（web は core の型と CommandClient にだけ依存する。ADR-007）

import type {
  AskAction,
  AskCandidate,
  AskFormat,
  AskMenu,
  AskTarget,
  AskView,
  BranchChanges,
  ChangedFile,
  ChangeKind,
  ConfigField,
  ConfigShowView,
  Epic,
  EpicDetail,
  EpicRow,
  FieldDefinition,
  HistoryChange,
  HistoryEvent,
  HistoryLog,
  Iteration,
  IterationDetail,
  MetricGroup,
  MetricUnit,
  MetricsView,
  Plan,
  PlanBrief,
  PlanRow,
  Priority,
  Progress,
  Project,
  RunMetrics,
  RunView,
  Status,
  Ticket,
  TicketDetail,
  TicketRow,
  TransitionConstraint,
  WhoamiView,
  WorkflowDefinition,
} from "@deguboard/core";

export type {
  AskAction,
  AskCandidate,
  AskFormat,
  AskMenu,
  AskTarget,
  AskView,
  BranchChanges,
  ChangedFile,
  ChangeKind,
  ConfigField,
  ConfigShowView,
  Epic,
  EpicDetail,
  EpicRow,
  FieldDefinition,
  HistoryChange,
  HistoryEvent,
  HistoryLog,
  Iteration,
  IterationDetail,
  MetricGroup,
  MetricUnit,
  MetricsView,
  Plan,
  PlanBrief,
  PlanRow,
  Priority,
  Progress,
  Project,
  RunMetrics,
  RunView,
  Status,
  Ticket,
  TicketDetail,
  TicketRow,
  WhoamiView,
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
  step: "工程",
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
/** 終わった Status（done・abandoned）。core の isTerminal の写し（web は core の実行時のコードを取り込まない） */
export function isFinished(status: Status): status is "done" | "abandoned" {
  return status === "done" || status === "abandoned";
}
/**
 * 検索語に当たるか：番号・タイトル（labels なら加えてラベル）の部分一致。前後の空白は除き、大文字小文字は区別しない。
 * 空の検索語はすべてに当たる。core の matchesQuery（ticket list の query）の写しで、同じ結果になることを types.test.ts で確かめる
 */
export function ticketMatchesQuery(
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
/** 文字列が Status の値か（履歴の変更の値は Status とは限らない） */
export function isStatus(value: string | null): value is Status {
  return (STATUSES as readonly string[]).includes(value ?? "");
}
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

/**
 * 担当者が操作している人本人か、その人の agent か。判定は core の whoami が返す own_ids に含まれるかだけで決める
 * （本人とみなす ID は core の ownActorIds が 1 か所で決める）。操作している人が分からない（読み込み前）なら false
 */
export function isOwnAssignee(me: Pick<WhoamiView, "own_ids"> | null, assignee: string): boolean {
  return !!me && me.own_ids.includes(assignee);
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

/** workflow.show の出力のうち画面が使うもの（遷移の制約は core の TransitionConstraint のまま） */
export interface WorkflowView {
  definition: WorkflowDefinition;
  labels: Record<Status, string>;
  transitions: readonly TransitionConstraint[];
}

/**
 * plan.show の出力（core は型に名前を付けて出さないので、形をここに写す）。状態（status）と Plan 全体の待ち（waiting）は持たず、
 * チケットごとの待ちの相手は items[].waiting に、着手できるかは items[].ready にある。items は Plan の順で、消えたチケットは入らない（警告に出る）
 */
export type PlanDetail = Plan & {
  progress: Progress;
  ready: PlanRow["ready"];
  next: PlanRow["next"];
  items: (Ticket & { waiting: string[]; ready: boolean })[];
};

/**
 * Status の選択に並べる Status：今の Status と、今から移れる Status（STATUSES の順）。core の canTransition の写しで、
 * 書かれていない遷移は自由（ADR-003）、by が主体（whoami の kind）を含まない遷移は外す。主体が分からなければ by は見ない。
 * requires は事実を画面で持たないので見ず、満たさないときは ticket.move の拒否で理由を出す
 */
export function movableStatuses(
  current: Status,
  transitions: WorkflowView["transitions"],
  kind: WhoamiView["kind"] | undefined,
): Status[] {
  return STATUSES.filter((to) => {
    if (to === current) return true;
    const by = transitions.find((t) => t.from === current && t.to === to)?.by;
    return !by || (kind ? by.includes(kind) : by.length > 0);
  });
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function ticketNumber(id: string): number {
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
