// 画面（web）が入口と話すための 1 つのインターフェース（ADR-033）。
// HTTP と postMessage の実装は web が持ち、入口の側はプロセス内の実装（local.ts）を HTTP・postMessage に写す。core はここで形を決める

import type { SyncStatus } from "../git/sync.js";
import { idKindOf, parseId, type IdKind } from "../model/id.js";
import type { CommandResult } from "./define.js";
import type { SetupCheckItem, SetupCheckResult, SetupItemId } from "./setup-check.js";

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
 * 画面の導入のチェックリスト（UI-12）の 1 項目。dg setup check の項目（SetupCheckItem）に、入口が足す項目を合わせた形。
 * folder（作業フォルダを開いているか）・os（Linux・macOS か）・dg_command（PATH の dg）は拡張でしか確かめられないので、VS Code 拡張が足す。
 * 画面は id と state から表示言語の文言を組み、message（dg の出力なので英語）は出さない
 */
export interface SetupViewItem extends Omit<SetupCheckItem, "id" | "state"> {
  id: SetupItemId | "folder" | "os" | "dg_command";
  /** 細かい状態。ボードは BoardState、dg_command は拡張が決める（packages/vscode/src/setup.ts の DgCommandState） */
  state?: string | undefined;
  /** 満たす項目の行に添える短い値（フォルダのパス・dg の版） */
  value?: string | undefined;
  /** 文言に埋める値（版・パスなど）。鍵は項目ごとに入口が決める */
  params?: Record<string, string> | undefined;
}

/** 画面の導入のチェックリスト。ready は必須の項目をすべて満たす（いつもの画面を出せる） */
export interface SetupView {
  ready: boolean;
  /** 上から確かめた順 */
  items: SetupViewItem[];
  /** 確かめたフォルダ（git init する場所として見せる）。フォルダを開いていなければ null */
  cwd: string | null;
}

/**
 * チェックリストのボタンが拡張ホストに頼む操作（UI-12）。どれも人が押したときだけ動く。
 * openFolder はフォルダを開く。gitInit・init・newBoard・installSkillsHooks は deguboard のターミナルで git init・dg init・dg init --new-board・
 * Skill と hooks を入れるコマンドを実行する（dg は同梱の起動ファイルで呼ぶ）。installDg は ~/.local/bin/dg を起動ファイルへ張る
 */
export const SETUP_ACTIONS = [
  "openFolder",
  "gitInit",
  "init",
  "newBoard",
  "installSkillsHooks",
  "installDg",
] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** dg setup check の結果を画面のチェックリストの形にする（入口が足す項目のない dg serve はこれだけを返す） */
export function setupViewOf(result: SetupCheckResult, cwd: string): SetupView {
  return { ready: result.ready, items: result.items, cwd };
}

/**
 * Webview → 拡張ホストの要求。id で応答と対応づける。action は Webview の外（エディタ・サイドバー・クリップボード）に働きかける操作で、応答の data は null。
 * open は詳細のルート（#/tickets/t12、#/iterations/s3、#/epics/e2）をエディタ領域のパネルに開く。
 * show は一覧の画面のルート（#/board?epic=e2 など）をサイドバーのビューに出す（パネルは詳細だけを出すので。UI-12）。
 * copy は text をクリップボードに入れる（Webview の画面はコピーをすべて拡張ホストに頼み、vscode.env.clipboard で書く）。
 * terminals は開いているターミナルの一覧を返す（応答の data は TerminalChoice[]）。sendToTerminal は text を terminal の入力に入れる（Enter は押さない。UI-15）。
 * setup は導入のチェックリストを確かめ直して返す（応答の data は SetupView）。setupAct はチェックリストのボタンの操作（SetupAction）を頼む（UI-12）。
 * setup の bandDismissed は、推奨の項目の帯を出す画面（左パネル）が、人が帯を「このリポジトリでは出さない」にしているかを伝える
 * （拡張ホストが、推奨だけが欠けている間の自動の確かめ直しをやめる）。帯を出さない画面は付けない
 */
export type WebviewRequest =
  | { id: number; kind: "run"; name: string; input: unknown }
  | { id: number; kind: "status" }
  | { id: number; kind: "action"; name: "open" | "show"; route: string }
  | { id: number; kind: "action"; name: "copy"; text: string }
  | { id: number; kind: "action"; name: "terminals" }
  | { id: number; kind: "action"; name: "sendToTerminal"; terminal: number; text: string }
  | { id: number; kind: "action"; name: "setup"; bandDismissed?: boolean | undefined }
  | { id: number; kind: "action"; name: "setupAct"; act: SetupAction };

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
 * current を付ければ、targets の代わりに画面の今の対象（カンバンで選んでいる Iteration、履歴で開いている行）にする。なければ対象なし（タイトル行の吹き出し）。
 * toggle を付ければ、入力欄が開いていれば閉じる（左パネルのタイトル行の Ask ボタン。開閉は Webview が今の状態で決める）。
 * setup は導入のチェックリストを確かめ直させる（ボタンの操作の後と、人がターミナルで直した後。画面が setup の要求で取り直す）
 */
export type WebviewEvent =
  | { kind: "event"; name: "reload" }
  | { kind: "event"; name: "setup" }
  | { kind: "event"; name: "navigate"; hash: string }
  | { kind: "event"; name: "toggle"; hash: string }
  | {
      kind: "event";
      name: "ask";
      targets: string[];
      current?: boolean | undefined;
      toggle?: boolean | undefined;
    }
  | { kind: "event"; name: "terminals"; terminals: TerminalChoice[] };

/**
 * 拡張と画面で合わせる値（UI-12）。拡張（vscode）はここを読み、web は実行時のコードを取り込まないので写し（ルートは router の hrefOf・parseRoute）を持ち、
 * 同じ値であることを web のテスト（packages/web/src/client/webview.test.ts）で確かめる
 */
export const WEBVIEW_CONTRACT = {
  /**
   * 右クリックの「詳細を開く」「ID をコピー」の文脈（data-vscode-context の webviewSection）。場所によらない 1 つの名前で、
   * 左パネルのボード・バックログ・履歴のチケットの行と Iteration・Epic の見出しが、対象の ID（id）と一緒に載せる。
   * 拡張の package.json の when と合わせる
   */
  menuSection: "deguboardItem",
  /**
   * 頼める行・見出しの場所の種類の名前。右クリックのメニューには載せず、
   * 画面の中で選んだ行の場所を区別するのに使う
   */
  askSections: [
    "boardTicket",
    "boardHeading",
    "backlogHeading",
    "historyRow",
    "detailTitle",
    "detailTicket",
    "configRow",
  ],
  /** 拡張が開く画面のルート（web の router のハッシュ） */
  routes: { board: "#/board", config: "#/config" },
  /** 詳細の画面のルートの頭。後ろに ID を付ける（#/tickets/t12）。組み立てと読み取りは detailRouteOf・detailOfRoute */
  detailRoutes: {
    ticket: "#/tickets/",
    iteration: "#/iterations/",
    epic: "#/epics/",
    plan: "#/plans/",
  },
  /** 拡張ホスト → Webview の通知の名前（WebviewEvent の name の全件） */
  eventNames: ["reload", "setup", "navigate", "toggle", "ask", "terminals"],
} as const satisfies {
  menuSection: string;
  askSections: readonly string[];
  routes: Record<string, `#/${string}`>;
  detailRoutes: Record<IdKind, `#/${string}/`>;
  eventNames: readonly WebviewEvent["name"][];
};

/** ID の詳細の画面のルート（t12 → #/tickets/t12、s3 → #/iterations/s3）。ID の形が違えば（x1・t01）undefined */
export function detailRouteOf(id: string): string | undefined {
  const kind = idKindOf(id);
  if (!kind || parseId(id, kind) !== id) return undefined;
  return `${WEBVIEW_CONTRACT.detailRoutes[kind]}${id}`;
}

/** ルートが指す詳細の対象（#/tickets/t12?x=1 → ticket t12）。詳細の画面でない・ID がなければ undefined。ID の形は確かめない */
export function detailOfRoute(route: string): { kind: IdKind; id: string } | undefined {
  for (const [kind, head] of Object.entries(WEBVIEW_CONTRACT.detailRoutes)) {
    if (!route.startsWith(head)) continue;
    const id = /^[^/?#]+/.exec(route.slice(head.length))?.[0];
    return id ? { kind: kind as IdKind, id } : undefined;
  }
  return undefined;
}

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
