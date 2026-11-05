// Webview に web を載せる部分のうち、VS Code の API に触れない純粋な処理。extension.ts から呼ぶ

import {
  askMenuKey,
  toCommandFailure,
  type CommandClient,
  type DiffRequest,
  type FileAtSide,
  type TerminalChoice,
  type TerminalSendResult,
  type StatusView,
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
  /** VS Code の表示言語（vscode.env.language。en・ja など）。<html data-language> に埋め、web が文言を選ぶのに使う（t383）。省けば付けない */
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

const SUBJECT_KINDS = {
  tickets: "ticket",
  iterations: "iteration",
  epics: "epic",
  plans: "plan",
} as const;

/** ルートが指す詳細の対象（#/tickets/t12 → ticket t12、#/iterations/s3 → iteration s3、#/epics/e2 → epic e2、#/plans/p5 → plan p5）。詳細でなければ undefined。パネルの題に使う（UI-12） */
export function subjectOfRoute(
  route: string,
): { kind: (typeof SUBJECT_KINDS)[keyof typeof SUBJECT_KINDS]; id: string } | undefined {
  const m = /^#\/(tickets|iterations|epics|plans)\/([^/?#]+)/.exec(route);
  if (!m) return undefined;
  return { kind: SUBJECT_KINDS[m[1] as keyof typeof SUBJECT_KINDS], id: m[2]! };
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
 * タイトル行の吹き出しの届け方（UI-15）。描かれた Webview には current つきの ask の event を送り、画面が今の対象
 * （カンバンで選んでいる Iteration、履歴で開いている行）を対象にして開く。対象がなければ画面が対象なしで開く。
 * まだ描かれていなければ画面に対象はないので、対象なしを覚えさせる
 */
export function currentAskDelivery(
  rendered: boolean,
): { post: WebviewEvent } | { pending: string[] } {
  return rendered
    ? { post: { kind: "event", name: "ask", targets: [], current: true } }
    : { pending: [] };
}

/** 画面を出せないとき（フォルダを開いていない）に Webview に出す、スクリプトのない HTML。language は text の言語（vscode.env.language） */
export function renderMessageHtml(text: string, language: string): string {
  return `<!doctype html>
<html lang="${escapeAttribute(language)}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
  </head>
  <body style="font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 12px">
    <p>${escapeAttribute(text)}</p>
  </body>
</html>`;
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
  /** フォルダ folder（worktree の絶対パス）を新しいウィンドウで開く（vscode.openFolder）。持たない画面は拒否する */
  openFolder(folder: string): void | Promise<void>;
  /** ticket.changes の 1 ファイルを差分エディタで開く（vscode.diff。UI-4） */
  openDiff(request: DiffRequest): void | Promise<void>;
  /** 開いているターミナルの一覧（UI-15）。持たない画面は空 */
  terminals(): TerminalChoice[];
  /** 開いているターミナル terminal の入力に text を入れる。Enter は押さず、ターミナルは起動しない。なければ reject */
  sendToTerminal(
    terminal: number,
    text: string,
  ): TerminalSendResult | void | Promise<TerminalSendResult | void>;
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
      if (request.name === "openWorktree") {
        const detail = await client.run<{ worktree: string | null }>("ticket.show", {
          ticket: request.ticket,
        });
        if (!detail.data.worktree) {
          return {
            id: request.id,
            ok: false,
            error: { code: "NOT_FOUND", message: t("No worktree found for {0}", request.ticket) },
          };
        }
        await actions.openFolder(detail.data.worktree);
        return { id: request.id, ok: true, data: null, warnings: [], write: null };
      }
      if (request.name === "openDiff") {
        await actions.openDiff({
          ticket: request.ticket,
          path: request.path,
          old_path: request.old_path,
          base_commit: request.base_commit,
          head_commit: request.head_commit,
        });
        return { id: request.id, ok: true, data: null, warnings: [], write: null };
      }
      if (request.name === "terminals") {
        return { id: request.id, ok: true, data: actions.terminals(), warnings: [], write: null };
      }
      if (request.name === "sendToTerminal") {
        const sent = await actions.sendToTerminal(request.terminal, request.text);
        return { id: request.id, ok: true, data: sent ?? null, warnings: [], write: null };
      } else if (request.name === "copy") await actions.copy(request.text);
      else if (request.name === "show") await actions.show(request.route);
      else if (request.name === "open") await actions.open(request.route);
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
      if (v.name === "openWorktree") return typeof (v as { ticket?: unknown }).ticket === "string";
      if (v.name === "openDiff") {
        const m = v as Partial<DiffRequest>;
        return (
          typeof m.ticket === "string" &&
          typeof m.path === "string" &&
          (m.old_path === null || typeof m.old_path === "string") &&
          typeof m.base_commit === "string" &&
          typeof m.head_commit === "string"
        );
      }
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
  if (status.behind > 0) parts.push(t("{0} not pulled", status.behind));
  if (status.dirty) parts.push(t("Uncommitted changes"));
  if (status.issues > 0) parts.push(t("{0} unreadable files", status.issues));
  return { value, tooltip: parts.join(" / ") };
}

/** 差分エディタの左右の文書の scheme。中身は拡張の TextDocumentContentProvider が core の ticket.changed-file で読む（UI-4） */
export const DIFF_SCHEME = "deguboard-diff";

/** 差分エディタの片側の文書が指すもの。URI の query に入れ、TextDocumentContentProvider が読む */
export interface DiffSideRef {
  /** 作業フォルダの URI（複数のフォルダを開いていても、そのフォルダの client で読む） */
  folder: string;
  ticket: string;
  side: "base" | "head";
  path: string;
  /** 一覧で読んだその側のコミット。URI ごとに中身を覚える VS Code が、ブランチが進んだ後に古い中身を出さないよう URI にも入れる */
  commit: string;
}

/**
 * 差分エディタの左右の文書（URI の path と query）と題。左は merge-base の元のパス（名前の変更なら old_path）、右は作業ブランチのパス。
 * URI の path は言語の判定（拡張子）と題に使い、読むのは query だけ。追加・削除の片側は、core がないと答えて空になる
 */
export function diffDocuments(
  folder: string,
  request: DiffRequest,
): {
  left: { path: string; query: string };
  right: { path: string; query: string };
  title: string;
} {
  const side = (s: "base" | "head", p: string, commit: string) => ({
    path: `/${p}`,
    query: diffQuery({ folder, ticket: request.ticket, side: s, path: p, commit }),
  });
  const leftPath = request.old_path ?? request.path;
  const name = request.old_path ? `${request.old_path} → ${request.path}` : request.path;
  return {
    left: side("base", leftPath, request.base_commit),
    right: side("head", request.path, request.head_commit),
    title: t("{0} (changes in {1})", name, request.ticket),
  };
}

export function diffQuery(ref: DiffSideRef): string {
  return new URLSearchParams({
    folder: ref.folder,
    ticket: ref.ticket,
    side: ref.side,
    path: ref.path,
    commit: ref.commit,
  }).toString();
}

/** diffQuery の逆。形が違えば undefined */
export function parseDiffQuery(query: string): DiffSideRef | undefined {
  const q = new URLSearchParams(query);
  const folder = q.get("folder");
  const ticket = q.get("ticket");
  const side = q.get("side");
  const path = q.get("path");
  const commit = q.get("commit");
  if (!folder || !ticket || !path || !commit || (side !== "base" && side !== "head")) {
    return undefined;
  }
  return { folder, ticket, side, path, commit };
}

/** 片側の文書の中身。ないファイルは空、バイナリとサブモジュールは中身の代わりに一言を出す（差分エディタは文字しか比べない） */
export function diffContent(file: FileAtSide): string {
  if (file.submodule)
    return `${t("(Submodule change: contents not shown. Commit {0})", file.text)}\n`;
  if (file.binary) return `${t("(Binary file: contents not shown)")}\n`;
  return file.text;
}
