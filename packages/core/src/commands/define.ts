// コマンド定義の形。CLI・HTTP・Webview はこの定義を写すだけで、ロジックを持たない（ADR-007）

import type { z } from "zod";
import { UsageError } from "../errors.js";
import type { WriteContext, WriteOutcome } from "../git/write.js";
import type { WorktreeOrigin } from "../git/worktree.js";

/** 操作の主体。入口が決める（CLI は環境変数かオプション、UI は常に human） */
export interface ActorInfo {
  kind: "human" | "agent";
  /** `eiki@laptop` の形。claimed_by に記録する */
  id: string;
}

export interface CommandContext extends WriteContext {
  actor: ActorInfo;
  now: () => Date;
  /** openContext が worktree を作ったときだけ入る（init の結果に使う） */
  worktree?: WorktreeOrigin | undefined;
}

export interface CommandResult<O> {
  data: O;
  write?: WriteOutcome | undefined;
  warnings: string[];
}

export interface CommandDef<I extends z.ZodType, O> {
  /** `ticket.create` のように群と操作をドットでつなぐ */
  name: string;
  group: string;
  summary: string;
  input: I;
  /** データを書き換えるか */
  write: boolean;
  /** repo：初期化前でも動く（init）。store：deguboard worktree が要る */
  needs: "repo" | "store";
  run(ctx: CommandContext, input: z.output<I>): Promise<CommandResult<O>>;
}

// 入口がコマンドを型を気にせず列挙するための形
export type AnyCommand = CommandDef<z.ZodType, unknown>;

export function defineCommand<I extends z.ZodType, O>(def: CommandDef<I, O>): CommandDef<I, O> {
  return def;
}

export function ok<O>(data: O, write?: WriteOutcome, warnings: string[] = []): CommandResult<O> {
  return { data, write, warnings: [...(write?.warnings ?? []), ...warnings] };
}

/** 入力を検証してから実行する。形の誤りは UsageError（終了コード 2） */
export async function runCommand<I extends z.ZodType, O>(
  def: CommandDef<I, O>,
  ctx: CommandContext,
  rawInput: unknown,
): Promise<CommandResult<O>> {
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    const { prettifyError } = await import("zod");
    throw new UsageError(`${def.name} の入力が正しくない`, prettifyError(parsed.error));
  }
  return def.run(ctx, parsed.data);
}
