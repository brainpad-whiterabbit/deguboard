// Action の形。Core の汎用部分（commands・storage・workflow）はこのモジュールに依存しない（AG-6、ADR-007）

import type { z } from "zod";
import type { GitRepo } from "../git/repo.js";
import type { Config } from "../model/config.js";

/** 確認を求める内容。呼び出し側（Action を実行する側）が人に見せて答えを返す */
export interface ConfirmRequest {
  action: string;
  /** 検証済みの入力（shell ならコマンドの文字列） */
  input: unknown;
  /** 実行する作業ディレクトリ */
  cwd: string;
}

export interface ActionContext {
  /** リモート・base・worktree の置き場所の解決に使う。openContext の repo をそのまま渡せる */
  repo: Pick<GitRepo, "topLevel" | "commonDir" | "remote" | "baseBranch">;
  config: Config;
  /** Action を実行する作業ディレクトリ（作業 worktree）。省略時は repo.topLevel */
  cwd?: string | undefined;
  /** 確認の要る Action の前に呼ぶ。true を返したときだけ実行する。渡さなければ確認の要る Action は拒否する */
  confirm?: ((request: ConfirmRequest) => Promise<boolean>) | undefined;
}

export interface ActionDef<I extends z.ZodType, O> {
  /** `create_pr` のような snake_case。Workflow の steps から参照する名前 */
  name: string;
  summary: string;
  input: I;
  /** 実行の前に ctx.confirm で確認するか */
  confirm: boolean;
  /** 実行を許す設定。満たさなければ拒否する（shell は actions.shell） */
  allowed?: ((config: Config) => string | null) | undefined;
  run(ctx: ActionContext & { cwd: string }, input: z.output<I>): Promise<O>;
}

export type AnyAction = ActionDef<z.ZodType, unknown>;

export function defineAction<I extends z.ZodType, O>(def: ActionDef<I, O>): ActionDef<I, O> {
  return def;
}
