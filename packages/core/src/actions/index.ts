// 登録済みの Action の一覧と実行（AG-6・AG-7、ADR-007）。
// CLI・MCP・画面のコマンドにはしない。core の公開から出すのは ACTION_NAMES だけで、ほかは core の中のライブラリに留める（ADR-007）

import { prettifyError } from "zod";
import { OperationError, UsageError } from "../errors.js";
import type { ActionContext, AnyAction } from "./define.js";
import { shellAction } from "./shell.js";
import { softwareActions } from "./software.js";

export * from "./define.js";

export const actions: readonly AnyAction[] = [...softwareActions, shellAction] as AnyAction[];

/** 登録済みの Action の名前。入口が openContext・createLocalClient に渡し、Workflow の steps の検証に使う */
export const ACTION_NAMES: readonly string[] = actions.map((a) => a.name);

export interface ActionInfo {
  name: string;
  summary: string;
  /** 実行の前に確認するか */
  confirm: boolean;
  /** いまの設定で使えるか。使えなければ理由 */
  available: boolean;
  reason: string | null;
}

/** Action の名前と、設定に照らして使えるかの一覧 */
export function listActions(config: ActionContext["config"]): ActionInfo[] {
  return actions.map((a) => {
    const reason = a.allowed?.(config) ?? null;
    return {
      name: a.name,
      summary: a.summary,
      confirm: a.confirm,
      available: reason === null,
      reason,
    };
  });
}

function findAction(name: string): AnyAction | undefined {
  return actions.find((a) => a.name === name);
}

/**
 * 名前で Action を引き、入力の検証 → 設定の検査 → 確認 → 実行の順に進める。
 * 設定で許されていないものと、確認が得られなかったものは実行せずに REJECTED で拒否する
 */
export async function runAction(
  ctx: ActionContext,
  name: string,
  rawInput: unknown = {},
): Promise<unknown> {
  const def = findAction(name);
  if (!def) throw new OperationError("NOT_FOUND", `Action ${name} は登録されていない`);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new UsageError(`Action ${name} の入力が正しくない`, prettifyError(parsed.error));
  }
  const denied = def.allowed?.(ctx.config) ?? null;
  if (denied !== null) throw new OperationError("REJECTED", denied);
  const cwd = ctx.cwd ?? ctx.repo.topLevel;
  if (def.confirm) {
    const confirmed = ctx.confirm
      ? await ctx.confirm({ action: name, input: parsed.data, cwd })
      : false;
    if (!confirmed) {
      throw new OperationError("REJECTED", `Action ${name} は確認が得られなかったので実行しない`);
    }
  }
  return def.run({ ...ctx, cwd }, parsed.data);
}
