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
      /** 会話記録を読んで使用量を補うか（Phase 3） */
      read_transcripts: z.boolean().default(false),
    })
    .prefault({}),
  actions: z
    .looseObject({
      /** 任意のシェルの Action を許すか（Phase 3） */
      shell: z.boolean().default(false),
    })
    .prefault({}),
});
export type Config = z.output<typeof configSchema>;

/** 既定値だけの config */
export function defaultConfig(): Config {
  return configSchema.parse({});
}
