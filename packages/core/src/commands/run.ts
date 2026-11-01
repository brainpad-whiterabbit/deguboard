// Run の操作（requirements.md 5.9、6.6 MT-1、6.7 EX-2、ADR-005）。記録の置き場所とロックは run/record.ts

import { z } from "zod";
import { UsageError } from "../errors.js";
import { isRunId, RUN_RESULTS, type Run } from "../model/run.js";
import { finishRun, readRunningRuns, startRun } from "../run/record.js";
import { defineCommand, ok } from "./define.js";
import { ticketRef } from "./helpers.js";

/** 一覧の 1 件。running は deguboard-local/runs/ にだけある終わっていない Run */
export type RunView = Run & { running: boolean };

export const runStart = defineCommand({
  name: "run.start",
  positionals: ["ticket", "step"],
  group: "run",
  summary:
    "Run を始める。実行中の記録は deguboard-local/runs/ にだけ置き、Git には入れない。同じチケットと step の Run が実行中なら拒否する",
  input: z.object({
    ticket: ticketRef,
    step: z.string().min(1).describe("工程（implement・review など）"),
    agent: z.string().min(1).describe("エージェント名（claude-code など）"),
    model: z.string().min(1).optional().describe("モデル名。分からなければ省く（null で残す）"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket);
    const run = await startRun(ctx.repo, {
      ticket: ticket.data.id,
      step: input.step,
      agent: input.agent,
      model: input.model,
      now: ctx.now(),
    });
    return ok(run);
  },
});

export const runFinish = defineCommand({
  name: "run.finish",
  positionals: ["run"],
  group: "run",
  summary:
    "実行中の Run を閉じ、完了時の集計を runs/ に書く（commit.mode に従ってコミット）。止まった Run は --result interrupted で閉じる。使用量は自己申告を受けず、取れなければ null のまま",
  input: z.object({
    run: z.string().min(1).describe("Run の ID（r20261031-041500-3fa2）"),
    result: z.enum(RUN_RESULTS).describe("success・failure・interrupted"),
    error: z.string().min(1).optional().describe("失敗・中断の理由"),
    retries: z.number().int().nonnegative().optional().describe("リトライの回数"),
    model: z.string().min(1).optional().describe("モデル名。start で渡さなかったとき"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (!isRunId(input.run))
      throw new UsageError(`${input.run} は Run の ID の形（r20261031-041500-3fa2）でない`);
    const { run, write } = await finishRun(ctx, input.run, {
      result: input.result,
      error: input.error,
      retries: input.retries,
      model: input.model,
      now: ctx.now(),
    });
    return ok(run, write);
  },
});

export const runList = defineCommand({
  name: "run.list",
  group: "run",
  summary:
    "Run を開始の順に出す。終わっていない Run（running: true。このマシンの deguboard-local/runs/）も出す",
  input: z.object({
    ticket: ticketRef.optional().describe("このチケットの Run だけ"),
    running: z.boolean().optional().describe("終わっていない Run だけ"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = input.ticket ? ctx.store.require("ticket", input.ticket).data.id : undefined;
    const local = await readRunningRuns(ctx.repo);
    const items: RunView[] = [
      // runs/ に集計がある Run は終わっている（記録を消す前に止まったもの）
      ...local.runs
        .filter((d) => !ctx.store.runs.has(d.data.id))
        .map((d) => ({ ...d.data, running: true })),
      ...(input.running
        ? []
        : [...ctx.store.runs.values()].map((d) => ({ ...d.data, running: false }))),
    ]
      .filter((r) => !ticket || r.ticket === ticket)
      .sort((a, b) => a.id.localeCompare(b.id));
    const warnings = local.issues.map((i) => `deguboard-local/${i.path}: ${i.message}`);
    return ok(items, undefined, warnings);
  },
});

export const runCommands = [runStart, runFinish, runList];
