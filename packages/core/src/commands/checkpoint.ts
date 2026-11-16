// 流れの段階の関所（EX-8、ADR-030）。コマンドで止められない段階の判断（点検の指摘を直す・見直しの指摘を起票する・
// リリースの手順・振り返りの改善を起票する・独自の段階の判断）と割り当ての終わりを、手順がここを呼んで段階の値で判定し、通った記録を Iteration に足す。
// 記録は消さずに足し、dg flow next が根拠と合わせて段階を終えたかを決める（flow-records.ts）

import { z } from "zod";
import { OperationError, UsageError } from "../errors.js";
import { withWrite } from "../git/write.js";
import type { IterationId } from "../model/id.js";
import { CHECKPOINT_STAGES, type Checkpoint, type CheckpointStage } from "../model/iteration.js";
import { DEFAULT_WORKFLOW } from "../workflow/resolve.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import {
  basisOf,
  readFlowLocal,
  resolveFlowTarget,
  writeFlowLocal,
  type FlowTarget,
} from "./flow-records.js";
import { nowIso } from "./helpers.js";
import { grantedNote, permissionFields, requireOperation, type Granted } from "./permission.js";

/** dg checkpoint の出力 */
export interface CheckpointResult {
  /** 通った段階（同梱の段階か、独自の段階の名前） */
  stage: string;
  /** 記録を足した Iteration。Iteration の決まらない流れの割り当て（記録はこのマシンだけ）は null */
  iteration: string | null;
  /** 足した記録 */
  checkpoint: Checkpoint;
  /** 記録を deguboard-local に書いた（共有しない） */
  local: boolean;
}

/** 通った関所の記録。名前・日時・主体・承認者・根拠の順に書く（経過は `- name:` の行で拾う。git/history.ts） */
function recordOf(
  ctx: CommandContext,
  stage: string,
  granted: Granted,
  target: FlowTarget,
): Checkpoint {
  const basis = basisOf(stage, ctx.store, target);
  return {
    name: stage,
    at: nowIso(ctx),
    by: ctx.actor.id,
    ...(granted.approver === null ? {} : { approved_by: granted.approver }),
    ...(basis === undefined ? {} : { basis }),
  };
}

export const checkpoint = defineCommand({
  name: "checkpoint",
  positionals: ["stage", "targets"],
  group: "checkpoint",
  summary:
    "Pass the checkpoint of a stage of the flow, and record it on the Iteration. The steps of a stage (dg guide check, audit, release, and retro, and the assign stage of dg guide all) call it for the decisions that dg cannot stop with a command: fixing the rows of a check, filing the findings of an audit, going on with the release steps, and filing the improvements of a retrospective, and for the end of an assignment. " +
    "The Workflow's value of the stage judges it (flow.assign, flow.check, flow.audit, flow.release, flow.retro; see dg workflow show --help for the values): an agent passes --approved-by after a person approved the stage's decision, or --auto in a flow that a person started with --auto where the value is ask_unless_auto, and with human_only only a person can pass it. A rejected call records nothing. " +
    "When it passes, a record is added to checkpoints of the Iteration (never removed or replaced), committed and pushed at once: name (the stage), at, by (who called it), approved_by (the approver, when one was needed), and basis (what the stage saw). The basis is candidates for assign (the assignment candidates left at that time), facts for check (a hash of the tickets), and done for audit (the done tickets); release and retro have none. " +
    "dg flow next reads the records to decide whether a stage is finished, and counts a record only while its basis holds and only if it is not from before dg iteration reopen (see dg flow next --help). dg history --iteration shows the passed checkpoints. " +
    "A stage of your own (a stage in flow of workflow.yaml with decide, after, and guide) has a checkpoint under its name: its decide judges the call, its steps (the document in guide) say when to call it, and its record has no basis. " +
    "The target is the same as for dg flow next (one Iteration, one Plan, or one or more tickets), and the record goes to the target's Iteration. The plan stage has no checkpoint (dg plan approve records the approval). When the tickets have no single Iteration, only assign can be passed, and its record is kept on this machine only (deguboard-local/flow/, not shared)",
  input: z.object({
    // 独自の段階の名前は workflow.yaml で決まるので、文字列で受けて run で確かめる
    stage: z
      .string()
      .min(1)
      .describe(
        "Stage whose checkpoint to pass: assign, check, audit, release, or retro, or the name of a stage of your own in flow of workflow.yaml",
      ),
    targets: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Target, the same as given to dg flow next: one Iteration (s3), one Plan (p7), or one or more tickets (t12)",
      ),
    ...permissionFields,
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const stage = input.stage;
    const bundled = (CHECKPOINT_STAGES as readonly string[]).includes(stage);
    // 独自の段階は workflow.yaml の flow にあるものだけを受ける（requireOperation と同じ Workflow を読む）
    const custom = (ctx.store.workflow?.resolved ?? DEFAULT_WORKFLOW).flow.custom;
    if (!bundled && !custom.some((c) => c.id === stage))
      throw new UsageError(
        `No stage ${stage} has a checkpoint. Use one of: ${[...CHECKPOINT_STAGES, ...custom.map((c) => c.id)].join(" / ")}`,
      );
    // 拒否された呼び出しは何も記録しない（ここで TRANSITION_REJECTED を投げる）
    const granted = requireOperation(
      ctx,
      bundled
        ? { command: "checkpoint", stage: stage as CheckpointStage }
        : { command: "checkpoint", customStage: stage },
      input,
      `passing the ${stage} checkpoint`,
    );
    const first = resolveFlowTarget(ctx.store, input.targets);
    if (first.iteration === null) {
      if (stage !== "assign")
        throw new OperationError(
          "REJECTED",
          `No single Iteration is determined for ${first.key}, so there is no place to record the ${stage} checkpoint`,
          "Put the tickets into one Iteration first (dg iteration add), or give the tickets of one Iteration",
        );
      // Iteration の決まらない流れの割り当ての記録だけは、止まる判定と同じこのマシンの置き場所に足す
      const record = recordOf(ctx, stage, granted, first);
      const local = await readFlowLocal(ctx.repo.localDir, first.key);
      await writeFlowLocal(ctx.repo.localDir, first.key, {
        ...local,
        assign: [...(local.assign ?? []), record],
      });
      return ok<CheckpointResult>({ stage, iteration: null, checkpoint: record, local: true });
    }
    const result = await withWrite(
      ctx,
      async () => {
        // ロックの中で取り込んだ後のデータから、対象と根拠を求め直す
        const target = resolveFlowTarget(ctx.store, input.targets);
        const it =
          target.iteration === null
            ? undefined
            : ctx.store.iterations.get(target.iteration as IterationId);
        if (!it)
          throw new OperationError(
            "REJECTED",
            `No single Iteration is determined for ${target.key}, so there is no place to record the ${stage} checkpoint`,
          );
        const record = recordOf(ctx, stage, granted, target);
        await ctx.store.update("iteration", it.id, {
          checkpoints: [...(it.data.checkpoints ?? []), record],
        });
        return { iteration: it.id, record };
      },
      {
        message: (r) => `Checkpoint ${stage} of ${r.iteration}${grantedNote(ctx, granted)}`,
        // 共有する判断の記録なので、まとめ待ちにせずその場でコミットして push する
        immediate: true,
      },
    );
    return ok<CheckpointResult>(
      {
        stage,
        iteration: result.value.iteration,
        checkpoint: result.value.record,
        local: false,
      },
      result.write,
    );
  },
});

export const checkpointCommands = [checkpoint];
