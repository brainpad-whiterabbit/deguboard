// 操作の権限の判定（WF-1・ST-2、ADR-003）。Workflow から引いた方針（workflow/resolve.ts の operationPolicy）を主体に当て、
// 人の承認（--approved-by）と人の強制（--override）を確かめる。主体は自己申告（--actor）なので、ここは誤操作を防ぐ手すりで、
// dg を経由しない操作はフック（AG-10）が止める

import { z } from "zod";
import { OperationError } from "../errors.js";
import { isAgentActorId, resolveActorRef } from "../model/actor.js";
import { evaluateAll, judgeDecisions, type Facts } from "../workflow/conditions.js";
import type { OperationPolicy } from "../workflow/resolve.js";
import type { CommandContext } from "./define.js";

/** 権限を判定するコマンドが受ける入力（--approved-by と --override） */
export const permissionFields = {
  approved_by: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The person who approved this operation: human (yourself, the user) or a user name. An agent passes it when the Workflow asks for a person's approval (always_ask, ask_unless_auto); a person's instruction counts as the approval. An agent's ID is rejected. The approver is recorded in the commit message (dg history shows it)",
    ),
  override: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A person forces the operation, with the reason: --override "reason". It passes a value of agent_only and unmet requires of a boundary. Only a person can use it (an agent is rejected). The reason is recorded in the commit message (dg history shows it)',
    ),
};

export interface PermissionInput {
  approved_by?: string | undefined;
  override?: string | undefined;
}

/** 通った判定の記録。approver は承認した人、override は人が強制した理由（どちらも渡されなければ null） */
export interface Granted {
  approver: string | null;
  override: string | null;
}

/**
 * --approved-by の値を人の ID に直す（human は自分のユーザ本人）。承認するのは人なので、agent の ID は拒む
 * （聞かずに進めた操作に承認者を残さないように）
 */
export function approverOf(
  ctx: CommandContext,
  ref: string | undefined,
  what: string,
): string | null {
  if (ref === undefined) return null;
  const id = resolveActorRef(ctx.actor, ref);
  if (isAgentActorId(id)) {
    throw new OperationError(
      "VALIDATION_FAILED",
      `--approved-by takes the person who approved ${what}, and ${id} is an agent`,
      "Pass human (yourself, the user) or a user name only when a person approved it. For an operation made without asking, leave --approved-by out",
    );
  }
  return id;
}

/** --override は人だけが使える。エージェントが渡したら、方針の値によらず拒否する */
export function rejectAgentOverride(ctx: CommandContext, input: PermissionInput): void {
  if (input.override === undefined || ctx.actor.kind === "human") return;
  throw new OperationError(
    "TRANSITION_REJECTED",
    "--override is for a person only, and an agent cannot use it",
    "Ask a person to run the command with --override and the reason (without --actor agent)",
  );
}

/**
 * 方針を今の主体に当て、通れば承認者と強制の理由を返す。通らなければ TRANSITION_REJECTED。
 * what は操作を表す句（"moving t1 from todo to done" など）。facts は越える条件（requires）の判定に使い、
 * 渡さなければ条件は見ない（事実を作る操作：pr ready・pr merge）。auto は聞かずに進める流れのとき
 */
export function requirePermission(
  ctx: CommandContext,
  policy: OperationPolicy,
  input: PermissionInput,
  what: string,
  opts: { facts?: Facts | undefined; auto?: boolean | undefined } = {},
): Granted {
  const human = ctx.actor.kind === "human";
  rejectAgentOverride(ctx, input);
  const approver = approverOf(ctx, input.approved_by, what);
  const override = input.override ?? null;
  const values = `${policy.name}: ${policy.decisions.join(", ")}`;
  switch (judgeDecisions(policy.decisions, ctx.actor.kind, opts.auto)) {
    case "reject":
      throw new OperationError(
        "TRANSITION_REJECTED",
        `The Workflow limits ${what} to a person (${values})`,
        "Ask a person to run the command (without --actor agent)",
      );
    case "approval":
      if (approver === null)
        throw new OperationError(
          "TRANSITION_REJECTED",
          `The Workflow asks for a person's approval for ${what} (${values})`,
          "Ask a person, and only when the person approves, run the command again with --approved-by human. A person's instruction to do exactly this counts as the approval. Never pass --approved-by without it",
        );
      break;
    case "override":
      if (override === null)
        throw new OperationError(
          "TRANSITION_REJECTED",
          `The Workflow leaves ${what} to an agent (${values})`,
          'A person can force it with --override "reason"',
        );
      break;
    case "allow":
      break;
  }
  if (opts.facts) {
    const { unmet } = evaluateAll(policy.requires, opts.facts);
    if (unmet.length > 0 && override === null)
      throw new OperationError(
        "TRANSITION_REJECTED",
        `The conditions for ${what} are not met: ${unmet.join(", ")} (requires of ${policy.name})`,
        human
          ? // 画面（Web・VS Code）の Status の選択からは理由を渡せないので、CLI の手順だと分かるように書く
            'To go ahead anyway, run the command from the dg CLI with --override "reason" (the board cannot pass it)'
          : 'Only a person can go ahead without them, with --override "reason"',
      );
  }
  return { approver, override };
}

/** コミットメッセージに足す記録（承認者と、強制した人と理由）。なければ空 */
export function grantedNote(ctx: CommandContext, granted: Granted): string {
  const notes: string[] = [];
  if (granted.approver !== null) notes.push(`approved by ${granted.approver}`);
  if (granted.override !== null)
    notes.push(`override by ${ctx.actor.id}: ${granted.override.replace(/\s+/g, " ").trim()}`);
  return notes.length > 0 ? ` (${notes.join("; ")})` : "";
}

/** 承認か強制が渡されたか（渡されたら、まとめ待ちにせずその操作のコミットに記録を残す） */
export function hasRecord(input: PermissionInput): boolean {
  return input.approved_by !== undefined || input.override !== undefined;
}
