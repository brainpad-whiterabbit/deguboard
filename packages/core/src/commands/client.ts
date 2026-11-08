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
  /** リモートを Web で開く URL（https://github.com/owner/repo）。PR へのリンクに使う。リモートがない・直せなければ null */
  web_url: string | null;
}

/**
 * Webview → 拡張ホストの要求。id で応答と対応づける。action は Webview の外（エディタ・サイドバー・クリップボード）に働きかける操作で、応答の data は null。
 * open は詳細のルート（#/tickets/t12、#/iterations/s3、#/epics/e2）をエディタ領域のパネルに開く。
 * show は一覧の画面のルート（#/board?epic=e2 など）をサイドバーのビューに出す（パネルは詳細だけを出すので。UI-12）。
 * copy は text をクリップボードに入れる（Webview の画面はコピーをすべて拡張ホストに頼み、vscode.env.clipboard で書く）。
 * openWorktree はチケットの作業ブランチの worktree を新しいウィンドウで開く（パスは Webview から受けず、拡張ホストが ticket.show で引く。UI-4）。
 * terminals は開いているターミナルの一覧を返す（応答の data は TerminalChoice[]）。sendToTerminal は text を terminal の入力に入れる（Enter は押さない。UI-15）
 */
export type WebviewRequest =
  | { id: number; kind: "run"; name: string; input: unknown }
  | { id: number; kind: "status" }
  | { id: number; kind: "action"; name: "open" | "show"; route: string }
  | { id: number; kind: "action"; name: "copy"; text: string }
  | { id: number; kind: "action"; name: "openWorktree"; ticket: string }
  | { id: number; kind: "action"; name: "terminals" }
  | { id: number; kind: "action"; name: "sendToTerminal"; terminal: number; text: string };

/** sendToTerminal の応答の data。clipboardKept は、貼り付けのために書いたクリップボードを元に戻せず、依頼文が残っていること */
export interface TerminalSendResult {
  clipboardKept: boolean;
}

/** 開いているターミナル 1 つ。id は拡張ホストが振る（閉じるまで変わらない）。label は同じ名前が並んでも見分けられる表示名 */
export interface TerminalChoice {
  id: number;
  label: string;
  /** 今アクティブなターミナル。送り先の既定にする */
  active?: boolean | undefined;
}

/**
 * 拡張ホスト → Webview の通知。要求と対応づかないので id を持たない（UI-12）。reload は store を読み直す（同期・再読み込み・ファイルの変化の後）。
 * toggle はその画面と来る前の画面を切り替える（ビューのタイトル行の歯車で設定画面を開け閉めする）。
 * ask はエージェントへの依頼文を作る入力欄を、targets（ID。空なら対象なし）を対象にして開く（UI-15。タイトル行の吹き出しとコマンドパレット）。
 * terminals は開いているターミナルの一覧が変わった（開いた・閉じた）ことを知らせる（UI-15）。
 * current を付ければ、targets の代わりに画面の今の対象（カンバンで選んでいる Iteration、履歴で開いている行）にする。なければ対象なし（タイトル行の吹き出し）
 */
export type WebviewEvent =
  | { kind: "event"; name: "reload" }
  | { kind: "event"; name: "navigate"; hash: string }
  | { kind: "event"; name: "toggle"; hash: string }
  | {
      kind: "event";
      name: "ask";
      targets: string[];
      current?: boolean | undefined;
    }
  | { kind: "event"; name: "terminals"; terminals: TerminalChoice[] };

/**
 * 拡張と画面で合わせる値（UI-12）。拡張（vscode）はここを読み、web は実行時のコードを取り込まないので写しを持ち、
 * 同じ値であることを web のテスト（packages/web/src/client/webview.test.ts）で確かめる
 */
export const WEBVIEW_CONTRACT = {
  /** バックログの行の右クリックの文脈（data-vscode-context の webviewSection）。拡張の package.json の when と合わせる */
  backlogRowSection: "backlogTicket",
  /**
   * 頼める行・見出しの場所の種類の名前（バックログの行は backlogRowSection）。右クリックのメニューには載せず、
   * 画面の中で選んだ行の場所を区別するのに使う
   */
  askSections: [
    "boardTicket",
    "boardHeading",
    "backlogHeading",
    "historyRow",
    "detailTitle",
    "detailTicket",
  ],
  /** 拡張が開く画面のルート（web の router のハッシュ） */
  routes: { board: "#/board", config: "#/config" },
  /** 拡張ホスト → Webview の通知の名前（WebviewEvent の name の全件） */
  eventNames: ["reload", "navigate", "toggle", "ask", "terminals"],
} as const satisfies {
  backlogRowSection: string;
  askSections: readonly string[];
  routes: Record<string, `#/${string}`>;
  eventNames: readonly WebviewEvent["name"][];
};

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
