// 操作の権限の判定（WF-1・WF-7・WF-9・ST-2・EX-7、ADR-003）。Workflow と Core の固定から引いた方針（workflow/resolve.ts の operationPolicy）を主体に当て、
// 人の承認（--approved-by）・人の強制（--override）・聞かずに進める流れ（--auto）を確かめる。主体は自己申告（--actor）なので、ここは誤操作を防ぐ手すりで、
// dg を経由しない操作はフック（AG-10）が止める

import { z } from "zod";
import { OperationError } from "../errors.js";
import { isAgentActorId, resolveActorRef } from "../model/actor.js";
import { autoApplies, evaluateAll, judgeDecisions, type Facts } from "../workflow/conditions.js";
import {
  DEFAULT_WORKFLOW,
  coreFixedPolicy,
  operationPolicy,
  type Operation,
  type OperationPolicy,
} from "../workflow/resolve.js";
import type { CommandContext } from "./define.js";

/** 権限を判定するコマンドが受ける入力（--approved-by と --override） */
export const permissionFields = {
  approved_by: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The person who approved this operation: human (yourself, the user) or a user name. An agent passes it when the Workflow asks for a person's approval (always_ask, and ask_unless_auto outside a flow started with --auto); a person's instruction counts as the approval. An agent's ID is rejected. The approver is recorded in the commit message (dg history shows it)",
    ),
  override: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A person forces the operation, with the reason: --override "reason". It passes a value of agent_only and unmet requires of a boundary. Only a person can use it (an agent is rejected). The reason is recorded in the commit message (dg history shows it)',
    ),
  auto: z
    .boolean()
    .optional()
    .describe(
      "An agent goes ahead without asking, in a flow that a person started with --auto (dg flow next --auto). It works only where the value that judges this operation is ask_unless_auto, and the agent is recorded as the approver. Anywhere else it is rejected (always_ask, human_only, and the approvals fixed in Core are never skipped; where no approval is asked, leave it out). It cannot be combined with --approved-by or --override, and a person does not use it",
    ),
};

/** Iteration・Epic への出し入れの判定の案内（iteration add / remove・epic add / remove・ticket update の --help に出す） */
export const ASSIGN_NOTE =
  "The Workflow's flow.assign judges putting tickets into and out of an Iteration or Epic (ask_unless_auto by default; see dg workflow show --help for the values): an agent passes --approved-by after a person approved it, or --auto in a flow that a person started with --auto, and the approver is recorded in the commit message. Outside it: --iteration and --epic of dg ticket create and import (creating is judged by governance.create), and the Iteration that dg ticket claim adds by itself (it follows config's lint.require_iteration)";

export interface PermissionInput {
  approved_by?: string | undefined;
  override?: string | undefined;
  auto?: boolean | undefined;
}

/**
 * 通った判定の記録。approver は承認した人（--auto で聞かずに進めたときは、進めたエージェント）、override は人が強制した理由
 * （どちらもなければ null）。auto は --auto で聞かずに進めたか
 */
export interface Granted {
  approver: string | null;
  override: string | null;
  auto: boolean;
}

/**
 * --auto が渡されたか。渡せるのはエージェントだけで、人の承認（--approved-by）や人の強制（--override）とは一緒に渡せない
 * （聞かずに進めた操作に、承認した人を残さないように）
 */
export function autoOf(ctx: CommandContext, input: PermissionInput): boolean {
  if (input.auto !== true) return false;
  if (ctx.actor.kind === "human")
    throw new OperationError(
      "VALIDATION_FAILED",
      "--auto is for an agent in a flow that goes ahead without asking, and a person does not need it",
      "Run the command again without --auto",
    );
  if (input.approved_by !== undefined || input.override !== undefined)
    throw new OperationError(
      "VALIDATION_FAILED",
      "--auto cannot be combined with --approved-by or --override",
      "Pass --approved-by only when a person approved this operation, and --auto only when going ahead without asking in a flow that a person started with --auto",
    );
  return true;
}

const AUTO_SCOPE = "--auto goes ahead without asking only where the value is ask_unless_auto";

/** 何も判定しない呼び出し（個人の設定・題だけの編集など）に --auto が渡されたら拒否する。--auto が効く場面はない */
export function rejectUnjudgedAuto(ctx: CommandContext, input: PermissionInput, what: string) {
  if (!autoOf(ctx, input)) return;
  throw new OperationError(
    "TRANSITION_REJECTED",
    `${AUTO_SCOPE}, and ${what} asks for no approval`,
    "Run the command again without --auto",
  );
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
 * 渡さなければ条件は見ない（事実を作る操作：pr ready・pr merge）。
 * --auto（聞かずに進める流れ）は、値が ask_unless_auto の場面でだけ通し、承認者に進めたエージェントを記録する。
 * ほかの場面の --auto は拒否する（always_ask・human_only・Core の固定を --auto で越えさせず、聞かない場面に付けたままにもさせない）
 */
export function requirePermission(
  ctx: CommandContext,
  policy: OperationPolicy,
  input: PermissionInput,
  what: string,
  opts: { facts?: Facts | undefined } = {},
): Granted {
  const human = ctx.actor.kind === "human";
  rejectAgentOverride(ctx, input);
  const auto = autoOf(ctx, input);
  const approver = approverOf(ctx, input.approved_by, what);
  const override = input.override ?? null;
  const values = `${policy.name}: ${policy.decisions.join(", ")}`;
  // Core に固定の値は workflow.yaml を書き換えても変わらないので、Workflow の値と言い分ける
  const judge = policy.source === "core" ? "dg" : "The Workflow";
  const fixed = policy.source === "core" ? ". workflow.yaml cannot change this value" : "";
  const scene = autoApplies(policy.decisions);
  if (auto && !scene) {
    const without = judgeDecisions(policy.decisions, ctx.actor.kind);
    throw new OperationError(
      "TRANSITION_REJECTED",
      `${AUTO_SCOPE}, and ${what} is not such a place (${values})`,
      without === "allow"
        ? "No approval is asked here, so run the command again without --auto"
        : without === "approval"
          ? `--auto never skips this approval. Ask a person, and only when the person approves, run the command again with --approved-by human and without --auto${fixed}`
          : `Ask a person to run the command (without --actor agent)${fixed}`,
    );
  }
  switch (judgeDecisions(policy.decisions, ctx.actor.kind, auto)) {
    case "reject":
      throw new OperationError(
        "TRANSITION_REJECTED",
        `${judge} limits ${what} to a person (${values})`,
        `Ask a person to run the command (without --actor agent)${fixed}`,
      );
    case "approval":
      if (approver === null)
        throw new OperationError(
          "TRANSITION_REJECTED",
          `${judge} asks for a person's approval for ${what} (${values})`,
          `Ask a person, and only when the person approves, run the command again with --approved-by human. A person's instruction to do exactly this counts as the approval. Never pass --approved-by without it${fixed}${
            scene
              ? ". In a flow that a person started with --auto (dg flow next --auto), run the command again with --auto instead, which goes ahead without asking and records the agent as the approver"
              : ""
          }`,
        );
      break;
    case "override":
      if (override === null)
        throw new OperationError(
          "TRANSITION_REJECTED",
          `${judge} leaves ${what} to an agent (${values})`,
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
  return { approver: auto ? ctx.actor.id : approver, override, auto };
}

/**
 * 流れの段階の操作（flow）・カンバンの管理の操作（governance）・Core に固定の操作を、今の主体に当てる（WF-7）。
 * Core に固定の操作は Workflow を読まずに判定する（workflow.yaml に誤りがあっても、workflow set で直せるように）。
 * 流れの段階とカンバンの管理の操作は、workflow.yaml に誤りがあって読めなければ Core の既定の値で判定する
 * （割り当て・起票・チケットを消す・チームの設定は Status の動きと違って Workflow のほかの項目に依らないので、
 * 定義を直すまで人もエージェントも止めることはしない）
 */
export function requireOperation(
  ctx: CommandContext,
  op: Operation,
  input: PermissionInput,
  what: string,
): Granted {
  const policy =
    coreFixedPolicy(op) ?? operationPolicy(ctx.store.workflow?.resolved ?? DEFAULT_WORKFLOW, op);
  return requirePermission(ctx, policy, input, what);
}

/**
 * 入口（runCommand）が判定したコマンドの記録。入力の --approved-by・--override・--auto から作る
 * （判定は済んでいるので、ここでは値を直すだけ。--auto の承認者は進めたエージェント）
 */
export function recordOf(ctx: CommandContext, input: PermissionInput): Granted {
  const auto = input.auto === true;
  return {
    approver: auto ? ctx.actor.id : approverOf(ctx, input.approved_by, "this operation"),
    override: input.override ?? null,
    auto,
  };
}

/** 入口（runCommand）が判定したコマンドが、自分のコミットメッセージに足す記録 */
export function recordNote(ctx: CommandContext, input: PermissionInput): string {
  return grantedNote(ctx, recordOf(ctx, input));
}

/** コミットメッセージに足す記録（承認者と、強制した人と理由）。なければ空 */
export function grantedNote(ctx: CommandContext, granted: Granted): string {
  const notes: string[] = [];
  if (granted.approver !== null)
    notes.push(`approved by ${granted.approver}${granted.auto ? " with --auto" : ""}`);
  if (granted.override !== null)
    notes.push(`override by ${ctx.actor.id}: ${granted.override.replace(/\s+/g, " ").trim()}`);
  return notes.length > 0 ? ` (${notes.join("; ")})` : "";
}

/** 承認か強制か --auto が渡されたか（渡されたら、まとめ待ちにせずその操作のコミットに記録を残す） */
export function hasRecord(input: PermissionInput): boolean {
  return input.approved_by !== undefined || input.override !== undefined || input.auto === true;
}
