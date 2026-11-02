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
    "deguboard ブランチの履歴から、起票・Status の遷移・Iteration と Epic の出入り・担当者・PR 番号の変化を時刻の順に出す。浅い clone では欠けたことを出す",
  input: z.object({
    ticket: ticketRef.optional().describe("このチケットの経過だけ"),
    epic: epicRef.optional().describe("この Epic と、一度でも入っていたチケットの経過"),
    iteration: iterationRef
      .optional()
      .describe("この Iteration と、一度でも入っていたチケットの経過（持ち越したものも）"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // 消えたチケットの経過も引けるよう、今あるかは確かめず ID の形だけ整える
    const log = await readHistory(ctx.repo.dataDir);
    const result = filterHistory(log, {
      ticket: idShapeOf(input.ticket, "ticket"),
      epic: idShapeOf(input.epic, "epic"),
      iteration: idShapeOf(input.iteration, "iteration"),
    });
    const warnings: string[] = [];
    if (result.shallow)
      warnings.push(
        "履歴が浅い clone なので、古い経過が欠けている（git fetch --unshallow で補える）",
      );
    return ok(result, undefined, warnings);
  },
});

export const historyCommands = [history];
