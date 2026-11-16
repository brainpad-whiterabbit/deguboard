// 列ごとの WIP の上限（workflow.yaml の wip。要件 WF-8）。最初の版は着手を拒否せず、超えた列を知らせて先の列を進めるよう返す。
// config の work.parallel（同時に動かすサブエージェントの数）とは別のもので、ここでは読まない

import { STATUSES, type Status } from "../model/common.js";
import type { Ticket } from "../model/ticket.js";
import type { ResolvedWorkflow } from "./resolve.js";

/** 上限を超えた（着手すると超える）列 */
export interface WipOver {
  status: Status;
  /** 今その列にあるチケットの数 */
  count: number;
  limit: number;
  /** 今は上限ちょうどで、着手すると超える（starting のときの in_progress だけ） */
  at_limit: boolean;
}

/**
 * 上限を超えた列を STATUSES の順に返す。上限のない列は見ない。
 * starting は、todo のチケットに着手する（claim で in_progress に入る）手を返すとき。in_progress は 1 件増えるので、
 * 上限ちょうどでも超えるとみなす
 */
export function wipOverOf(
  tickets: Iterable<Pick<Ticket, "status">>,
  wip: ResolvedWorkflow["wip"],
  opts: { starting?: boolean } = {},
): WipOver[] {
  const counts = new Map<Status, number>();
  for (const t of tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  return STATUSES.flatMap((status) => {
    const limit = wip[status];
    if (limit === undefined) return [];
    const count = counts.get(status) ?? 0;
    const atLimit = opts.starting === true && status === "in_progress" && count === limit;
    return count > limit || atLimit ? [{ status, count, limit, at_limit: atLimit }] : [];
  });
}

/** 超えた列の警告（1 列に 1 文） */
export function wipWarningsOf(over: readonly WipOver[], labels: ResolvedWorkflow["labels"]) {
  return over.map((o) =>
    o.at_limit
      ? `The ${labels[o.status]} column (${o.status}) is at its WIP limit (${o.count} of ${o.limit}, wip in workflow.yaml), so starting another ticket goes over it`
      : `The ${labels[o.status]} column (${o.status}) is over its WIP limit (${o.count} for a limit of ${o.limit}, wip in workflow.yaml)`,
  );
}

/** 終わった列（done・abandoned）は先の列に入れない */
const ACTIVE: readonly Status[] = ["todo", "in_progress", "review"];

/**
 * 先の列を進める手（1 文）。一番手前の超えた列とその先の進行中の列のチケットを挙げる。超えた列がなければ null。
 * 拒否はしないので、着手するかは呼んだ側が決める
 */
export function wipAdvanceStepOf(
  over: readonly WipOver[],
  tickets: Iterable<Pick<Ticket, "id" | "status">>,
  /** 進める手を返すコマンド（dg next <id> の形） */
  nextCommand: string,
): string | null {
  const first = over[0];
  if (!first) return null;
  const from = Math.max(STATUSES.indexOf(first.status), STATUSES.indexOf("in_progress"));
  const columns = STATUSES.filter((s, i) => i >= from && ACTIVE.includes(s));
  const list = [...tickets];
  const groups = columns
    .map((s) => {
      const ids = list.filter((t) => t.status === s).map((t) => t.id);
      return ids.length > 0 ? `${s}: ${ids.join(", ")}` : null;
    })
    .filter((g): g is string => g !== null);
  const names = over.map((o) => o.status).join(", ");
  return `WIP limit (${names}): rather than starting new work, first advance a ticket in a column further along${groups.length > 0 ? ` (${groups.join("; ")})` : ""} with ${nextCommand}. Starting is not refused`;
}
