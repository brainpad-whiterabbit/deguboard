// Webview に web を載せる部分のうち、VS Code の API に触れない純粋な処理。extension.ts から呼ぶ

import {
  askMenuKey,
  SETUP_ACTIONS,
  toCommandFailure,
  type CommandClient,
  type SetupAction,
  type SetupBoardSource,
  type SetupView,
  type TerminalChoice,
  type TerminalSendResult,
  type StatusView,
  type UninstallPreview,
  type WebviewEvent,
  type WebviewRequest,
  type WebviewResponse,
} from "@deguboard/core";
import { t } from "./l10n.js";

/** 画面がどこに載っているか。web は <html data-surface> で読み、サイドバーではレイアウトとリンクの挙動を変える（UI-12） */
export type Surface = "sidebar" | "panel";

export interface HtmlOptions {
  /** web の dist の相対パス（./assets/index.js）を Webview の URI にする */
  asset(relativePath: string): string;
  /** webview.cspSource */
  cspSource: string;
  nonce: string;
  surface: Surface;
  /** 最初に出す画面のハッシュ（#/board、#/tickets/t12）。Webview が起動する前に決まるので HTML に埋める */
  route: string;
  /** 開いたらすぐ出す、エージェントに頼む入力欄の対象（ID。空なら対象なし）。省けば出さない（UI-15） */
  ask?: readonly string[] | undefined;
  /** VS Code の表示言語（vscode.env.language。en・ja など）。<html data-language> に埋め、web の l10n.ts が文言と <html lang> を選ぶのに使う。省けば付けない */
  language?: string | undefined;
}

/**
 * Vite が出した index.html（base: "./"）を Webview 向けに直す：
 * 相対パスを Webview の URI に、crossorigin を外し、nonce つきの CSP を入れ、<html> に surface と初期ルート
 * （と、すぐ出す入力欄の対象。data-ask は core の askMenuKey の形で、空なら対象なし。表示言語の data-language）を付ける
 */
export function renderWebviewHtml(indexHtml: string, options: HtmlOptions): string {
  // style-src に 'unsafe-inline' は要らない：CSS は Vite が <link> に出し、React は style を CSSOM で当てる
  // （CSP が止めるのは style 属性と <style> だけ）。違反が出たら DevTools の Console に見えるので、そのときに戻す
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    `font-src ${options.cspSource}`,
    `img-src ${options.cspSource} data:`,
  ].join("; ");
  return indexHtml
    .replace(/\s+crossorigin(?=[\s>])/g, "")
    .replace(
      /(src|href)="\.\/([^"]+)"/g,
      (_, attr: string, p: string) => `${attr}="${options.asset(p)}"`,
    )
    .replace(/<script\b/g, `<script nonce="${options.nonce}"`)
    .replace(
      /<html\b/,
      `<html data-surface="${escapeAttribute(options.surface)}" data-route="${escapeAttribute(options.route)}"${
        options.ask ? ` data-ask="${escapeAttribute(askMenuKey(options.ask))}"` : ""
      }${options.language ? ` data-language="${escapeAttribute(options.language)}"` : ""}`,
    )
    .replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    );
}

/**
 * 短い間に続けて呼ばれたら最後の 1 回にまとめる（データの書き込みは 1 回で複数のファイルを変えるので）。
 * 戻り値の cancel で待っている分を捨てる
 */
export function coalesce(fn: () => void, waitMs: number): { fire(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    fire() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, waitMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * サイドバーに画面を出す頼み（navigate：その画面に移す、toggle：その画面と来る前の画面で切り替える）の届け方。
 * サイドバーが描かれていれば Webview に event を送り（切り替えは今の画面を知っている web に任せる）、
 * まだ描かれていなければ、その画面を初期ルートとして覚えさせる（resolveSidebar が使う）
 */
export function sidebarDelivery(
  rendered: boolean,
  name: "navigate" | "toggle",
  route: string,
): { post: WebviewEvent } | { pending: string } {
  return rendered ? { post: { kind: "event", name, hash: route } } : { pending: route };
}

/**
 * エージェントに頼む入力欄を出す頼み（UI-15）の届け方。描かれた Webview には ask の event を送り、
 * まだ描かれていなければ、対象を覚えさせて HTML に埋める（Webview が起動する前の event は届かないので。resolveSidebar が使う）。
 */
export function askDelivery(
  rendered: boolean,
  targets: readonly string[],
): { post: WebviewEvent } | { pending: string[] } {
  return rendered ? { post: askEvent(targets) } : { pending: [...targets] };
}

/** エージェントに頼む入力欄を出す ask の event。描かれた Webview に送る */
export function askEvent(targets: readonly string[]): WebviewEvent {
  return { kind: "event", name: "ask", targets: [...targets] };
}

/**
 * 左パネルのタイトル行の Ask ボタンの届け方（UI-15）。描かれた Webview には current と toggle つきの ask の event を送り、
 * 開いていれば閉じ、閉じていれば画面が今の対象（カンバンで選んでいる Iteration、履歴で開いている行）を対象にして開く。
 * 対象がなければ画面が対象なしで開く。まだ描かれていなければ開くだけなので、対象なしを覚えさせる
 */
export function currentAskDelivery(
  rendered: boolean,
): { post: WebviewEvent } | { pending: string[] } {
  return rendered
    ? { post: { kind: "event", name: "ask", targets: [], current: true, toggle: true } }
    : { pending: [] };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Webview の外（エディタ・サイドバー・クリップボード）への働きかけ。サイドバーとパネルが持ち、持たない画面からの action は拒否する */
export interface WebviewActions {
  /** 詳細のルート（#/tickets/t12 など）をエディタ領域のパネルに開く */
  open(route: string): void | Promise<void>;
  /** 一覧の画面のルート（#/board?epic=e2 など）をサイドバーのビューに出す */
  show(route: string): void | Promise<void>;
  /** text をクリップボードに入れる（Webview の画面のコピーはすべてここに来る。vscode.env.clipboard で書く） */
  copy(text: string): void | Promise<void>;
  /** 開いているターミナルの一覧（UI-15）。持たない画面は空 */
  terminals(): TerminalChoice[];
  /** 開いているターミナル terminal の入力に text を入れる。Enter は押さず、ターミナルは起動しない。なければ reject */
  sendToTerminal(
    terminal: number,
    text: string,
  ): TerminalSendResult | void | Promise<TerminalSendResult | void>;
  /**
   * 導入のチェックリスト（UI-12）を確かめ直して返す。bandDismissed は、推奨の項目の帯を出す画面が伝える、
   * 人が帯を「このリポジトリでは出さない」にしているか（帯を出さない画面からは undefined）。
   * board は、人がボードの項目で指定し直したデータの置き場所（null はコードのリモートに戻した。undefined は拡張が持つ指定のまま）
   */
  setup(bandDismissed?: boolean, board?: SetupBoardSource | null): SetupView | Promise<SetupView>;
  /**
   * チェックリストのボタンの操作（フォルダを開く・deguboard のターミナルで実行する・dg コマンドを入れる）。失敗は拡張が通知する。
   * board は、人がボードの項目で指定したデータの置き場所（init・newBoard の dg init に渡す）
   */
  setupAct(act: SetupAction, board?: SetupBoardSource): void | Promise<void>;
  /** dg uninstall --dry-run の結果（「アンインストール」の節が出す、消すもの・残すもの・止める理由）。personal は --personal を付けるか */
  uninstallPreview(personal: boolean): UninstallPreview | Promise<UninstallPreview>;
}

/** Webview からの要求を CommandClient（か actions）に通し、同じ id の応答にする。失敗は ok: false で返す */
export async function handleRequest(
  client: CommandClient,
  request: WebviewRequest,
  actions?: WebviewActions,
): Promise<WebviewResponse> {
  try {
    if (request.kind === "status") {
      return { id: request.id, ok: true, data: await client.status(), warnings: [], write: null };
    }
    if (request.kind === "action") {
      if (!actions) {
        return {
          id: request.id,
          ok: false,
          error: {
            code: "UNSUPPORTED_ACTION",
            message: t("This view does not support that action"),
          },
        };
      }
      if (request.name === "terminals") {
        return { id: request.id, ok: true, data: actions.terminals(), warnings: [], write: null };
      }
      if (request.name === "setup") {
        const data = await actions.setup(request.bandDismissed, request.board);
        return { id: request.id, ok: true, data, warnings: [], write: null };
      }
      if (request.name === "uninstallPreview") {
        const data = await actions.uninstallPreview(request.personal);
        return { id: request.id, ok: true, data, warnings: [], write: null };
      }
      if (request.name === "sendToTerminal") {
        const sent = await actions.sendToTerminal(request.terminal, request.text);
        return { id: request.id, ok: true, data: sent ?? null, warnings: [], write: null };
      } else if (request.name === "copy") await actions.copy(request.text);
      else if (request.name === "show") await actions.show(request.route);
      else if (request.name === "open") await actions.open(request.route);
      else if (request.name === "setupAct") await actions.setupAct(request.act, request.board);
      return { id: request.id, ok: true, data: null, warnings: [], write: null };
    }
    const result = await client.run(request.name, request.input);
    return {
      id: request.id,
      ok: true,
      data: result.data,
      warnings: result.warnings,
      write: result.write ?? null,
    };
  } catch (error) {
    return { id: request.id, ok: false, error: toCommandFailure(error) };
  }
}

/**
 * setup・setupAct の board（省いてよい）。データのリモートは空でない文字列、ブランチは省くか文字列。
 * null（コードのリモートに戻した）は setup だけが送る（orNull）
 */
function isBoardSource(value: unknown, orNull = false): boolean {
  if (value === undefined || (orNull && value === null)) return true;
  if (typeof value !== "object" || value === null) return false;
  const m = value as { dataRemote?: unknown; dataBranch?: unknown };
  return (
    typeof m.dataRemote === "string" &&
    m.dataRemote !== "" &&
    (m.dataBranch === undefined || typeof m.dataBranch === "string")
  );
}

export function isWebviewRequest(value: unknown): value is WebviewRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<WebviewRequest>;
  if (typeof v.id !== "number") return false;
  switch (v.kind) {
    case "status":
      return true;
    case "run":
      return typeof v.name === "string";
    case "action":
      if (v.name === "copy") return typeof (v as { text?: unknown }).text === "string";
      if (v.name === "terminals") return true;
      if (v.name === "setup") {
        const m = v as { bandDismissed?: unknown; board?: unknown };
        return (
          (m.bandDismissed === undefined || typeof m.bandDismissed === "boolean") &&
          isBoardSource(m.board, true)
        );
      }
      if (v.name === "setupAct") {
        const m = v as { act?: unknown; board?: unknown };
        return (SETUP_ACTIONS as readonly unknown[]).includes(m.act) && isBoardSource(m.board);
      }
      if (v.name === "uninstallPreview")
        return typeof (v as { personal?: unknown }).personal === "boolean";
      if (v.name === "sendToTerminal") {
        const m = v as { terminal?: unknown; text?: unknown };
        return typeof m.terminal === "number" && typeof m.text === "string";
      }
      return (
        (v.name === "open" || v.name === "show") &&
        typeof v.route === "string" &&
        v.route.startsWith("#/")
      );
    default:
      return false;
  }
}

/**
 * サイドバーのビューに出すバッジ（UI-6・UI-12）。数は未 push と未取り込みの合計で、0 なら消す。
 * ツールチップには未コミットの変更と読めないファイルも足す（サイドバーの中には同期の印を出さないので、ここで読む）
 */
export function badgeOf(status: StatusView): { value: number; tooltip: string } | undefined {
  const value = status.ahead + status.behind;
  if (value === 0) return undefined;
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(t("{0} unpushed", status.ahead));
  if (status.behind > 0) parts.push(t("{0} to pull", status.behind));
  if (status.dirty) parts.push(t("Uncommitted changes"));
  if (status.issues > 0) parts.push(t("{0} unreadable files", status.issues));
  return { value, tooltip: parts.join(" / ") };
}
