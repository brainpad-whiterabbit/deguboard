// 経過（requirements.md 6.1）。deguboard ブランチの git の履歴から、チケット・Epic・Iteration の属性の変化を時刻の順に返す

import { z } from "zod";
import { readHistory, type HistoryEvent, type HistoryLog } from "../git/history.js";
import { defineCommand, ok } from "./define.js";
import { epicRef, idShapeOf, iterationRef, ticketRef } from "./helpers.js";

/**
 * 絞り込み。ticket はそのチケットだけ。epic・iteration はそれ自身と、一度でもそこに入っていたチケットの経過
 * （外されたり持ち越されたりしたチケットも含む）
 */
export function filterHistory(
  log: HistoryLog,
  by: { ticket?: string | undefined; epic?: string | undefined; iteration?: string | undefined },
): HistoryLog {
  const keep = (pred: (e: HistoryEvent) => boolean): HistoryLog => {
    const events = log.events.filter(pred);
    const ids = new Set(events.map((e) => e.id));
    return { ...log, events, incomplete: log.incomplete.filter((id) => ids.has(id)) };
  };
  let result = log;
  if (by.ticket) {
    const id = by.ticket;
    result = keep((e) => e.kind === "ticket" && e.id === id);
  }
  for (const field of ["epic", "iteration"] as const) {
    const target = by[field];
    if (!target) continue;
    const members = new Set(
      result.events
        .filter(
          (e) =>
            e.kind === "ticket" &&
            e.changes.some((c) => c.field === field && (c.from === target || c.to === target)),
        )
        .map((e) => e.id),
    );
    const before = result;
    result = {
      ...before,
      events: before.events.filter(
        (e) => (e.kind === field && e.id === target) || (e.kind === "ticket" && members.has(e.id)),
      ),
    };
    const ids = new Set(result.events.map((e) => e.id));
    result.incomplete = before.incomplete.filter((id) => ids.has(id));
  }
  return result;
}

export const history = defineCommand({
  name: "history",
  group: "history",
  summary:
    "From the history of the deguboard branch, print creation, Status changes, entries to and exits from Iterations and Epics, assignee, and PR number changes in time order. A shallow clone shows what is missing",
  input: z.object({
    ticket: ticketRef.optional().describe("Only the history of this ticket"),
    epic: epicRef.optional().describe("This Epic, and the history of tickets that were ever in it"),
    iteration: iterationRef
      .optional()
      .describe(
        "This Iteration, and the history of tickets that were ever in it (including carried-over ones)",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // 消えたチケットの経過も引けるよう、今あるかは確かめず ID の形だけ整える
    const by = {
      ticket: idShapeOf(input.ticket, "ticket"),
      epic: idShapeOf(input.epic, "epic"),
      iteration: idShapeOf(input.iteration, "iteration"),
    };
    // チケットのときはそのファイルの履歴だけを読む（絞った結果は全体から絞ったものと同じ）
    const log = await (ctx.readHistory ?? readHistory)(ctx.repo.dataDir, { ticket: by.ticket });
    const result = filterHistory(log, by);
    const warnings: string[] = [];
    if (result.shallow)
      warnings.push(
        "履歴が浅い clone なので、古い経過が欠けている（git fetch --unshallow で補える）",
      );
    return ok(result, undefined, warnings);
  },
});

export const historyCommands = [history];
