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
  /**
   * ほかの Run の期間（閉じた Run と、このマシンで実行中の Run。実行中なら finished_at は null）。
   * 同じ会話記録で期間が重なる Run と応答を分けるのに使う。なければ分けない
   */
  others?: ReadonlyMap<string, RunSpan>;
  /**
   * このマシンに置いた、この Run の会話記録のパス（deguboard-local/transcripts/。ADR-005）。あればそのファイルから数え、
   * なければ Run の session、それもなければ推測で探す
   */
  transcript?: string | undefined;
}

/** Run の期間。時刻は ISO 8601 */
export interface RunSpan {
  started_at: string;
  finished_at: string | null;
  /** Run の agent。なければ自分と同じ agent とみなす */
  agent?: string;
  /** このマシンに置いたその Run の会話記録のパス。同じファイルを使い回す Run の境目に使う */
  transcript?: string | undefined;
}

/** Adapter が取り込んだ値。取れなかったキーは null（RN-2）。数とモデル名だけで、会話の中身・パスは返さない（MT-4。警告にもパスを書かない） */
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

/**
 * harness のフックの出来事を、製品によらない形にしたもの（ADR-005・ADR-012）。Core の hook のコマンドはこれだけを見る。
 * transcript は記録のファイルの絶対パス（取れなければ null）
 */
export type HookEvent =
  /** セッションの始まり。envFile は以後の Bash の環境に入れる export を書くファイル */
  | { kind: "session_start"; session: string; transcript: string | null; envFile: string | null }
  /**
   * サブエージェントを起動した呼び出しが返った。prompt は頼んだ文の全文、transcript はサブエージェントの記録のパス。
   * finished は呼び出しが返った時点でサブエージェントが終わっていたか（前景の起動。終わりの出来事はこれより先に来る）
   */
  | {
      kind: "subagent_launched";
      session: string;
      agentId: string;
      prompt: string;
      model: string | null;
      transcript: string | null;
      finished: boolean;
      /** 前景の起動でかかった時間（ミリ秒）。分からなければ null */
      durationMs: number | null;
    }
  /**
   * サブエージェントが始まった（初めての起動と、親が続きを頼んだ再開の両方）。transcript はサブエージェントの記録のパス。
   * 再開なら同じ agentId で、同じ記録に追記される（ADR-014）
   */
  | { kind: "subagent_started"; session: string; agentId: string; transcript: string | null }
  /** サブエージェントが止まった（終わったか、親に質問を返して待っている） */
  | {
      kind: "subagent_stopped";
      session: string;
      agentId: string;
      transcript: string | null;
    }
  /** セッションの終わり */
  | { kind: "session_end"; session: string };

/** この製品のフック（AG-5）。dg hooks install が設定に書き、dg hook が入力を出来事に変える */
export interface HookSupport {
  /** 設定に入れるフック。event は製品のイベント名、matcher はその製品の matcher（省けばすべて） */
  events: ReadonlyArray<{ event: string; matcher?: string }>;
  /** フックを書く設定のファイル。project はリポジトリ（topLevel は作業ツリーの最上位）、personal は個人 */
  settings: { project(topLevel: string): string; personal(env: AgentEnv): string };
  /** フックの入力（製品の JSON）を出来事に変える。扱わないイベントや形の違う入力は undefined */
  parse(event: string, input: unknown, env: AgentEnv): HookEvent | undefined;
  /** サブエージェントの記録の最初の文（頼んだ文）。読めなければ undefined。印を照らすのに使う */
  firstPrompt(transcript: string): Promise<string | undefined>;
  /**
   * サブエージェントが自分で開いた Run の ID。記録の中の dg run start・dg ticket claim の呼び出しの結果に出た、開いた Run の ID だけを返す
   * （警告の文・一覧・詳細に出るほかの Run の ID は返さない）。読めなければ空
   */
  selfOpenedRunIds(transcript: string): Promise<string[]>;
  /**
   * 記録が書き終わっているか。止まった瞬間には最後の応答がまだ書かれていないことがある（ADR-014）。読めなければ true
   * （待っても変わらない）
   */
  transcriptSettled(transcript: string): Promise<boolean>;
  /** 会話記録の置き場所。run start・ticket claim の --transcript はこの下だけを受け付ける */
  transcriptRoot(env: AgentEnv): string;
}

export interface AgentAdapter {
  /** Run の agent の値。この名前の Run の使用量を取り込む */
  name: string;
  /** 会話記録から使用量とツールの回数を読む。読む許可（metrics.read_transcripts・DEGUBOARD_NO_TRANSCRIPTS）は呼び出し側が確かめる */
  readTranscriptUsage(query: UsageQuery): Promise<CollectedUsage>;
  /** この製品が Skill を読むディレクトリ。Skill のない製品は持たない */
  skillDirs?: SkillDirs;
  /** この製品のフック。フックのない製品は持たない（主体は申告、Run は run start と claim で開く） */
  hooks?: HookSupport;
  /**
   * dg を呼んだプロセスの環境変数から、この製品のエージェントが呼んだかを判定する（run start と ticket claim が --agent を省いたときに使う）。
   * 製品が公に付ける変数が確かめられない Adapter は持たない（判定しない）。推測した変数名で判定しない
   */
  detect?(env: AgentEnv): boolean;
}
