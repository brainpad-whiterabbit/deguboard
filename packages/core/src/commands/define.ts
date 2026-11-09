// コマンド定義の形。CLI・HTTP・Webview はこの定義を写すだけで、ロジックを持たない（ADR-007）

import type { z } from "zod";
import { OperationError, UsageError } from "../errors.js";
import { checkOutside, describeOutside, outsideError, outsideRemedy } from "../git/outside.js";
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
  /**
   * ストアを開いていない文脈（コマンドの storeless が真のとき openContextFor が作る）。repo の場所（topLevel・commonDir・dataDir・localDir）と
   * now・env だけを持ち、store・config・actor・repo.remote・repo.baseBranch を読むと例外になる
   */
  storeless?: boolean | undefined;
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
  /**
   * 入力がこれを満たすとき、入口（openContextFor）はストアを開かずに場所だけの文脈で呼ぶ（CommandContext の storeless）。
   * 何度も呼ばれて待ちが効く操作のためにある（dg hook の PreToolUse。t554）。config を読まないので actor.human_only も検査しない
   */
  storeless?(input: z.output<I>, env: Readonly<Record<string, string | undefined>>): boolean;
  /**
   * dg の外の変更の検査（ADR-026）を runCommand で行わない。自分で扱うコマンドだけが付ける（取り込む dg adopt と、
   * Stop で確かめてエージェントに返し、ほかのイベントで作業を止めない dg hook）
   */
  ownsOutsideCheck?: boolean;
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
 * config の actor.human_only で、いまの主体に command が禁じられているか。人はいつでも許す。
 * runCommand の拒否と、claim が中で行う操作（iteration.add・iteration.start）の判定がここを使う
 */
export function deniedToAgent(ctx: CommandContext, command: string): boolean {
  return ctx.actor.kind !== "human" && ctx.config.actor.human_only.includes(command);
}

/**
 * 入力を検証してから実行する。形の誤りは UsageError（終了コード 2）。
 * config の actor.human_only に入ったコマンドは agent から拒否する（全入口がここを通るので検査は 1 か所）。
 * ストアを開いていない文脈（storeless）では config がないので検査しない。
 * データのリポジトリに dg の外の変更（ADR-026）があれば、書くコマンドは OUTSIDE_CHANGES で止め、読むだけのコマンドは警告を足す
 * （ストアを開かない文脈・初期化の前に動く needs: repo・検査を自分で扱うコマンドでは見ない）。
 * ここはロックの外なので、書く前の決め手はデータに書くときの書き込みのロックの中の検査（withWriteLock）で、ここは早く知らせるだけ
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
  if (!ctx.storeless && deniedToAgent(ctx, def.name)) {
    throw new OperationError(
      "TRANSITION_REJECTED",
      `${def.name} は設定（actor.human_only）で人だけに限られている（--actor human で実行する）`,
    );
  }
  const check =
    ctx.storeless || def.needs === "repo" || def.ownsOutsideCheck
      ? undefined
      : await checkOutside(ctx.repo);
  if (check?.kind === "found" && def.write) throw outsideError(check.changes, def.name);
  const result = await def.run(ctx, parsed.data);
  if (check?.kind === "found")
    return {
      ...result,
      warnings: [
        ...result.warnings,
        `データのリポジトリに dg の外の変更がある（${describeOutside(check.changes)}）。${outsideRemedy(check.changes)}`,
      ],
    };
  return result;
}
