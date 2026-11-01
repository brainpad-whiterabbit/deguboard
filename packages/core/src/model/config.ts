// config.yaml のスキーマ。項目の全体はここが正本（requirements.md 5.10）。
// 入れ子の既定は prefault で与える（Zod 4 の default は検証を短絡するため）

import { z } from "zod";
import { slugSchema } from "./common.js";

export const COMMIT_MODES = ["each", "batch", "manual"] as const;
export type CommitMode = (typeof COMMIT_MODES)[number];
export const PUSH_MODES = ["auto", "manual"] as const;
export type PushMode = (typeof PUSH_MODES)[number];

export const configSchema = z.looseObject({
  /** 省略時の Project */
  default_project: slugSchema.default("default"),
  git: z
    .looseObject({
      /** 同期先のリモート */
      remote: z.string().min(1).default("origin"),
      /** 作業ブランチの元と「マージ済み」の判定の基準 */
      base_branch: z.string().min(1).default("main"),
    })
    .prefault({}),
  worktree: z
    .looseObject({
      /** 作業 worktree の置き場所。リポジトリからの相対パス */
      root: z.string().min(1).default("../<repo>.worktrees"),
    })
    .prefault({}),
  commit: z
    .looseObject({
      /** each: 書き込みのたびにコミット / batch: 作業ツリーに残し、dg commit・dg sync・即時の操作がまとめてコミット / manual: dg commit と即時の操作だけ */
      mode: z.enum(COMMIT_MODES).default("batch"),
    })
    .prefault({}),
  push: z
    .looseObject({
      /** auto: コミットのたびに push / manual: dg sync が push する（即時の操作は manual でも push する） */
      mode: z.enum(PUSH_MODES).default("auto"),
    })
    .prefault({}),
  metrics: z
    .looseObject({
      /** 会話記録を読んで使用量を補うか（Run を実装するまで使わない） */
      read_transcripts: z.boolean().default(false),
    })
    .prefault({}),
  actions: z
    .looseObject({
      /** 任意のシェルの Action（shell）を許すか。許しても実行のたびに確認する（AG-7） */
      shell: z.boolean().default(false),
      /** テスト実行の Action（run_tests）が呼ぶコマンドの引数配列（例 [mise, run, check]）。空なら run_tests は拒否する */
      test: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  auto: z
    .looseObject({
      /** dg guide all --auto で、マージの前の条件を満たした PR を自動でマージするか。既定は人がマージする */
      merge: z.boolean().default(false),
    })
    .prefault({}),
  actor: z
    .looseObject({
      /** agent からは拒否するコマンド名（epic.close など）。既定は空で、すべて許す。チケットの遷移は Workflow の by で縛る */
      human_only: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
});
export type Config = z.output<typeof configSchema>;

/** 既定値だけの config */
export function defaultConfig(): Config {
  return configSchema.parse({});
}
