// 画面（web）が入口と話すための 1 つのインターフェース（ADR-006・ADR-007）。
// HTTP の実装は web、Webview の postMessage の実装は vscode が持つ。core はここで形だけを決める

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

export interface CommandClient {
  /** コマンド名（ticket.move など）と入力を渡して結果を受け取る。失敗は CommandFailure を持つ例外 */
  run<O = unknown>(name: string, input?: unknown): Promise<CommandResult<O>>;
  /** 同期の状態 */
  status(): Promise<StatusView>;
}
