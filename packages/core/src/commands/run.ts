// Run の操作（requirements.md 5.9、6.6 MT-1・MT-2、6.7 EX-2、ADR-005）。記録の置き場所とロックは run/record.ts、
// 使用量の取り込みは agents（Run の agent の値で Adapter を選ぶ。特定の AI 製品をここに書かない。AG-5）

import { z } from "zod";
import { agentNames, collectRunUsage } from "../agents/index.js";
import { toIsoDateTime } from "../model/common.js";
import { OperationError, UsageError } from "../errors.js";
import { isRunId, RUN_RESULTS, type Run } from "../model/run.js";
import { finishRun, readRunningRuns, startRun } from "../run/record.js";
import { findStep } from "../workflow/resolve.js";
import { defineCommand, ok } from "./define.js";
import { ticketRef } from "./helpers.js";

/** 一覧の 1 件。running は deguboard-local/runs/ にだけある終わっていない Run */
export type RunView = Run & { running: boolean };

/** 空白・改行を含まない 1 語。step の語彙は run.start がチケットの Workflow の steps（WF-5）で確かめる */
const token = z.string().regex(/^\S+$/, "空白・改行を含まない 1 語");

export const runStart = defineCommand({
  name: "run.start",
  positionals: ["ticket", "step"],
  group: "run",
  summary:
    "Run を始める。実行中の記録は deguboard-local/runs/ にだけ置き、Git には入れない。同じチケットと step の Run が実行中か、step がチケットの Workflow の steps にないなら拒否する",
  input: z.object({
    ticket: ticketRef,
    step: token.describe("工程。チケットの Workflow の steps の id（dg workflow show で見る）"),
    agent: token.describe(
      `エージェント名。${agentNames().join("・")} なら finish が会話記録から使用量を取り込む（metrics.read_transcripts）`,
    ),
    model: z.string().min(1).optional().describe("モデル名。分からなければ省く（null で残す）"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket);
    const warnings: string[] = [];
    const workflow = ctx.store.workflowFor(ticket.data);
    if (workflow) {
      const found = findStep(workflow.resolved, input.step);
      if (!found.ok) {
        throw new OperationError(
          "VALIDATION_FAILED",
          `step ${input.step} は Workflow ${workflow.resolved.id} の steps にない（${found.known.join("・")}）`,
        );
      }
    } else {
      warnings.push(
        `${ticket.data.id} の Workflow が見つからないか読めないので、step ${input.step} を確かめていない`,
      );
    }
    const run = await startRun(ctx.repo, {
      ticket: ticket.data.id,
      step: input.step,
      agent: input.agent,
      model: input.model,
      now: ctx.now(),
    });
    return ok(run, undefined, warnings);
  },
});

export const runFinish = defineCommand({
  name: "run.finish",
  positionals: ["run"],
  group: "run",
  summary:
    "実行中の Run を閉じ、完了時の集計を runs/ に書く（commit.mode に従ってコミット）。止まった Run は --result interrupted で閉じる。使用量は自己申告を受けず、agent の Adapter が会話記録から取り込む。取れなければ null のまま警告する",
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
    const now = ctx.now();
    // 実行中の記録がなければ取り込まず、finishRun が見つからない・終わっていると拒否する
    const running = (await readRunningRuns(ctx.repo)).runs.find((r) => r.id === input.run);
    const collected = running
      ? await collectRunUsage(ctx.config, {
          run: running.data,
          finishedAt: toIsoDateTime(now),
          env: ctx.env ?? process.env,
          topLevel: ctx.repo.topLevel,
          commonDir: ctx.repo.commonDir,
        })
      : undefined;
    const { run, write } = await finishRun(ctx, input.run, {
      result: input.result,
      error: input.error,
      retries: input.retries,
      // 明示したモデル名 > 実行中の記録のモデル名 > 会話記録のモデル名
      model: input.model ?? (running?.data.model ? undefined : (collected?.model ?? undefined)),
      usage: collected?.usage,
      now,
    });
    return ok(run, write, collected?.warnings ?? []);
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
      // runs/ に集計がある実行中の記録（記録を消す前に止まった finish の残り）は readRunningRuns が消す
      ...local.runs.map((d) => ({ ...d.data, running: true })),
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
