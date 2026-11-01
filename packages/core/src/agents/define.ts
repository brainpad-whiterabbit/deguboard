// Agent Adapter の形（AG-5・MT-1、ADR-005・ADR-007）。
// 特定の AI 製品に依存する処理は adapters/ に閉じ、Core の汎用部分はこの形と agents/index.ts の一覧だけを見る

import type { Run, RunUsage } from "../model/run.js";

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
}

/** Adapter が取り込んだ値。取れなかったキーは null（RN-2）。数とモデル名だけで、会話の中身・パスは返さない（MT-4） */
export interface CollectedUsage {
  usage: Pick<RunUsage, "input" | "output" | "cache_read" | "cache_write">;
  /** 会話記録から分かったモデル名。分からなければ null */
  model: string | null;
  warnings: string[];
}

export interface AgentAdapter {
  /** Run の agent の値。この名前の Run の使用量を取り込む */
  name: string;
  /** 会話記録から使用量を読む。読む許可（metrics.read_transcripts・DEGUBOARD_NO_TRANSCRIPTS）は呼び出し側が確かめる */
  readTranscriptUsage(query: UsageQuery): Promise<CollectedUsage>;
}
