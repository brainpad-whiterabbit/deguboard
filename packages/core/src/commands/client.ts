// 画面（web）が入口と話すための 1 つのインターフェース（ADR-006・ADR-007）。
// HTTP と postMessage の実装は web が持ち、入口の側はプロセス内の実装（local.ts）を HTTP・postMessage に写す。core はここで形を決める

import type { SyncStatus } from "../git/sync.js";
import type { CommandResult } from "./define.js";

/** 入口の失敗。CLI の --json のエラーと同じ形 */
export interface CommandFailure {
  code: string;
  message: string;
  detail?: string | undefined;
}

/** GET /api/status が返す同期の状態（UI-6） */
export interface StatusView extends SyncStatus {
  /** 読めないファイルと参照の不整合の件数 */
  issues: number;
  data_dir: string;
}

/** Webview → 拡張ホストの要求。id で応答と対応づける。action は画面の外（エディタ）に働きかける操作で、応答の data は null */
export type WebviewRequest =
  | { id: number; kind: "run"; name: string; input: unknown }
  | { id: number; kind: "status" }
  | { id: number; kind: "action"; name: "openTicket"; ticket: string };

/** 拡張ホスト → Webview の通知。要求と対応づかないので id を持たない（UI-12）。reload は store を読み直す（同期・再読み込み・ファイルの変化の後） */
export type WebviewEvent =
  | { kind: "event"; name: "reload" }
  | { kind: "event"; name: "navigate"; hash: string };

/** 拡張ホスト → Webview の応答。HTTP の本文と同じ形に id を足したもの */
export type WebviewResponse =
  | {
      id: number;
      ok: true;
      data: unknown;
      warnings: string[];
      write: CommandResult<unknown>["write"] | null;
    }
  | { id: number; ok: false; error: CommandFailure };

export interface CommandClient {
  /** コマンド名（ticket.move など）と入力を渡して結果を受け取る。失敗は CommandFailure を持つ例外 */
  run<O = unknown>(name: string, input?: unknown): Promise<CommandResult<O>>;
  /** 同期の状態 */
  status(): Promise<StatusView>;
}
