// Agent Adapter の形（AG-5・MT-1、ADR-005・ADR-007）。
// 特定の AI 製品に依存する処理は adapters/ に閉じ、Core の汎用部分はこの形と agents/index.ts の一覧だけを見る

import type { Run, RunTools, RunUsage } from "../model/run.js";

/** 環境変数。テストが HOME などを差し替えられるように、process.env を直接読まずに受け取る */
export type AgentEnv = Readonly<Record<string, string | undefined>>;

/** 会話記録から使用量を探す手がかり */
export interface UsageQuery {
  /** 実行中の記録。id・started_at・agent を使う */
  run: Run;
  /** finish が書く終了日時（ISO 8601） */
  finishedAt: string;
  env: AgentEnv;
  /** dg を呼んだ作業ツリーの最上位 */
  topLevel: string;
  /** 絶対パスの git common dir（主の作業ツリーを求めるのに使う） */
  commonDir: string;
  /**
   * ほかの Run の期間（閉じた Run と、このマシンで実行中の Run。実行中なら finished_at は null）。
   * 同じ会話記録で期間が重なる Run と応答を分けるのに使う。なければ分けない
   */
  others?: ReadonlyMap<string, RunSpan>;
}

/** Run の期間。時刻は ISO 8601 */
export interface RunSpan {
  started_at: string;
  finished_at: string | null;
}

/** Adapter が取り込んだ値。取れなかったキーは null（RN-2）。数とモデル名だけで、会話の中身・パスは返さない（MT-4） */
export interface CollectedUsage {
  usage: Pick<RunUsage, "input" | "output" | "cache_read" | "cache_write">;
  /** 会話記録から分かったモデル名。分からなければ null */
  model: string | null;
  /** 使用量と同じ範囲で数えたツールの回数。数えられない Adapter・記録は null */
  tools: RunTools | null;
  warnings: string[];
}

/** Skill の置き場所を求める手がかり */
export interface SkillQuery {
  env: AgentEnv;
  /** dg を呼んだ作業ツリーの最上位 */
  topLevel: string;
}

/** この製品が Skill（<名前>/SKILL.md）を読むディレクトリ。dg skill install が書く先と、ask が Skill の有無を見る先の両方の正本 */
export interface SkillDirs {
  /** リポジトリの Skill。topLevel は作業ツリーの最上位 */
  project(topLevel: string): string;
  /** どのリポジトリでも読む個人の Skill。ホームディレクトリは env の HOME（空か未設定なら OS のホーム） */
  personal(env: AgentEnv): string;
}

export interface AgentAdapter {
  /** Run の agent の値。この名前の Run の使用量を取り込む */
  name: string;
  /** 会話記録から使用量とツールの回数を読む。読む許可（metrics.read_transcripts・DEGUBOARD_NO_TRANSCRIPTS）は呼び出し側が確かめる */
  readTranscriptUsage(query: UsageQuery): Promise<CollectedUsage>;
  /** この製品が Skill を読むディレクトリ。Skill のない製品は持たない */
  skillDirs?: SkillDirs;
}
