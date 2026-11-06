// コマンド定義の形。CLI・HTTP・Webview はこの定義を写すだけで、ロジックを持たない（ADR-007）

import type { z } from "zod";
import { OperationError, UsageError } from "../errors.js";
import type { ActorKind, UserSource } from "../model/actor.js";
import type { WriteContext, WriteOutcome } from "../git/write.js";
import type { WorktreeOrigin } from "../git/worktree.js";

/** 操作の主体。入口が決める（CLI は環境変数かオプション、UI は常に human） */
export interface ActorInfo {
  kind: ActorKind;
  /** ユーザ名。既定は git config の deguboard.user、git の user.name、OS のユーザ名の順 */
  user: string;
  /** ユーザ名の出どころ（whoami が返す） */
  userSource: UserSource;
  /** `eiki` か `eiki/agent`。created_by と assignee に記録する（model/actor.ts） */
  id: string;
}

export interface CommandContext extends WriteContext {
  actor: ActorInfo;
  now: () => Date;
  /** openContext が worktree を作ったときだけ入る（init の結果に使う） */
  worktree?: WorktreeOrigin | undefined;
  /** マージドライバとして git に登録する、dg を呼ぶ argv の前置（init と sync が登録する。git/merge.ts） */
  mergeDriver?: readonly string[] | undefined;
  /** 環境変数。Adapter が会話記録の場所と DEGUBOARD_NO_TRANSCRIPTS と run start・ticket claim の agent の判定を、ask が HOME（Skill の置き場所）を見る。省けば process.env */
  env?: Readonly<Record<string, string | undefined>> | undefined;
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
  /** CLI で位置引数にする入力のキー（順に）。最後が配列なら可変長 */
  positionals?: readonly string[] | undefined;
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

/**
 * 入力を検証してから実行する。形の誤りは UsageError（終了コード 2）。
 * config の actor.human_only に入ったコマンドは agent から拒否する（全入口がここを通るので検査は 1 か所）
 */
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
  if (ctx.actor.kind !== "human" && ctx.config.actor.human_only.includes(def.name)) {
    throw new OperationError(
      "TRANSITION_REJECTED",
      `${def.name} は設定（actor.human_only）で人だけに限られている（--actor human で実行する）`,
    );
  }
  return def.run(ctx, parsed.data);
}
