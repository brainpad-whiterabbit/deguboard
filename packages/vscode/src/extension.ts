// 拡張ホストの入口。Activity Bar のアイコンからサイドバーのビューに web を載せ、それを主画面にする（UI-12）。
// エディタ領域のパネルはサイドバーから開いた詳細（チケット・Iteration・Epic）だけを出し、一覧の画面（カンバンなど）はサイドバーに出す。
// パネルの題は詳細の番号と名前にする（パネルにはヘッダーを出さないので、題で見分ける）。
// データ worktree と実行中の Run の記録を見張り、CLI やエージェントの書き込みを画面に映す。
// Webview からの要求は core のプロセス内 CommandClient に通す（ADR-006・ADR-007）。サーバーは起動しない。
// dg は同梱せず、PATH の dg を案内する（UI-11）。VS Code の API に触れるのはこのファイルだけ

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ACTION_NAMES,
  createLocalClient,
  pickUser,
  toCommandFailure,
  type CommandClient,
  type StatusView,
  type WebviewEvent,
} from "@deguboard/core";
import * as vscode from "vscode";
import {
  BACKLOG_ROW_COMMANDS,
  iterationPicks,
  menuTicketOf,
  moveToIteration,
  ticketRoute,
  type MenuTicket,
} from "./context-menu.js";
import { dgAdvice, resolveDg } from "./dg.js";
import { watchTargets } from "./watch.js";
import {
  badgeOf,
  coalesce,
  handleRequest,
  isWebviewRequest,
  renderMessageHtml,
  renderWebviewHtml,
  subjectOfRoute,
  type Surface,
  type WebviewActions,
} from "./webview.js";

const VIEW_ID = "deguboard.screens";
const PANEL_TYPE = "deguboard";

/** エディタ領域のパネル。作業フォルダごとに 1 つで、詳細はこれを使い回す */
const panels = new Map<string, vscode.WebviewPanel>();
/** フォルダごとの CommandClient。core の直列化はインスタンスの中だけなので、サイドバーとパネルで 1 つを共有する */
const clients = new Map<string, CommandClient>();
/** フォルダごとのデータ worktree（.git/deguboard/）と実行中の Run（.git/deguboard-local/runs/）の監視。CLI やエージェントの書き込みを画面に映す */
const watchers = new Map<string, vscode.Disposable>();
/** 今出ているサイドバーのビュー。右クリックで非表示にされると dispose され、再表示で作り直される */
let sidebar: vscode.WebviewView | undefined;
/** サイドバーが対象にするフォルダ（最初の作業フォルダ）。ビューのタイトル行のコマンドはこのフォルダに対して動く */
let sidebarFolder: vscode.WorkspaceFolder | undefined;
/** サイドバーがまだ描かれていないときに出す画面。サイドバーを開いて作るときの初期ルートにする */
let pendingSidebarRoute: string | undefined;
/** 同期の実行中。重ねて走らせない */
let syncing = false;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // ビューのタイトル行の同期ボタン（UI-12）。拡張ホストで実行してから、サイドバーとパネルの両方に読み直しを頼む
    // （サイドバーが描かれていなくても動く）。リモートがなくても読み直しだけはするので、手の再読み込みも兼ねる
    vscode.commands.registerCommand("deguboard.sync", () => void syncFolder()),
    // 左パネルのバックログの行の右クリック（package.json の webview/context。引数は行の data-vscode-context）
    vscode.commands.registerCommand(BACKLOG_ROW_COMMANDS.move, (arg: unknown) =>
      withMenuTicket(arg, moveFromMenu),
    ),
    vscode.commands.registerCommand(BACKLOG_ROW_COMMANDS.open, (arg: unknown) =>
      withMenuTicket(arg, (folder, row) =>
        // サイドバーのリンクと同じく、フォーカスはサイドバーに残す
        openPanel(context, folder, {
          column: vscode.ViewColumn.Beside,
          route: ticketRoute(row),
          preserveFocus: true,
        }),
      ),
    ),
    vscode.commands.registerCommand(BACKLOG_ROW_COMMANDS.copyId, (arg: unknown) =>
      withMenuTicket(arg, async (_folder, row) => {
        await vscode.env.clipboard.writeText(row.ticket);
        void vscode.window.setStatusBarMessage(`deguboard: ${row.ticket} をコピーした`, 3000);
      }),
    ),
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      { resolveWebviewView: (view) => resolveSidebar(context, view) },
      // 隠しても画面の状態（選んだ画面や編集中の本文）を失わない
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  void adviseAboutDg();
}

export function deactivate(): void {
  for (const panel of panels.values()) panel.dispose();
  panels.clear();
  for (const watcher of watchers.values()) watcher.dispose();
  watchers.clear();
  clients.clear();
}

/** サイドバーのビュー。最初の作業フォルダを対象にし、詳細を押すとエディタ領域のパネルに開く */
async function resolveSidebar(
  context: vscode.ExtensionContext,
  view: vscode.WebviewView,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders[0];
  if (!folder) {
    view.webview.options = {};
    view.webview.html = renderMessageHtml("フォルダを開いてから使う（対象のリポジトリ）");
    return;
  }
  sidebar = view;
  sidebarFolder = folder;
  view.onDidDispose(() => {
    if (sidebar === view) sidebar = undefined;
  });
  if (folders.length > 1) view.description = folder.name;
  const route = pendingSidebarRoute ?? "#/board";
  pendingSidebarRoute = undefined;
  await attach(context, view.webview, folder, {
    surface: "sidebar",
    route,
    onStatus: (status) => {
      view.badge = badgeOf(status);
    },
    actions: {
      open: (route) =>
        subjectOfRoute(route)
          ? openPanel(context, folder, {
              column: vscode.ViewColumn.Beside,
              route,
              preserveFocus: true,
            })
          : showInSidebar(route),
      show: showInSidebar,
    },
  });
}

/**
 * 一覧の画面（カンバン・バックログ・履歴・Run）をサイドバーのビューに出してフォーカスを移す。パネルの中身は変えない。
 * サイドバーがまだ描かれていなければ、初期ルートとして覚えてからビューを開く（resolveSidebar が使う）
 */
async function showInSidebar(route: string): Promise<void> {
  if (sidebar) {
    void sidebar.webview.postMessage({
      kind: "event",
      name: "navigate",
      hash: route,
    } satisfies WebviewEvent);
  } else {
    pendingSidebarRoute = route;
  }
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}

/** フォルダのサイドバーとパネルの両方に通知を送る */
function broadcast(folder: vscode.WorkspaceFolder, event: WebviewEvent): void {
  if (sidebar && sidebarFolder === folder) void sidebar.webview.postMessage(event);
  void panels.get(folder.uri.toString())?.webview.postMessage(event);
}

/**
 * dg sync と同じ同期をサイドバーのフォルダに対して行い、終わったら画面を読み直させる。
 * リモートがなければ同期は要らないので、知らせて読み直すだけにする。警告と失敗は VS Code の通知に出す
 */
async function syncFolder(): Promise<void> {
  const folder = sidebarFolder ?? (vscode.workspace.workspaceFolders ?? [])[0];
  if (!folder) {
    void vscode.window.showErrorMessage("deguboard: フォルダを開いてから使う（対象のリポジトリ）");
    return;
  }
  if (syncing) return;
  syncing = true;
  try {
    const client = clientFor(folder);
    const status = await client.status();
    if (!status.remote) {
      void vscode.window.showInformationMessage(
        "deguboard: リモートがないので同期は要らない。読み直した",
      );
      return;
    }
    await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: "同期" }, async () => {
      const result = await client.run("sync");
      if (result.warnings.length > 0) {
        void vscode.window.showWarningMessage(`deguboard: ${result.warnings.join(" / ")}`);
      }
    });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `deguboard: 同期できない: ${toCommandFailure(error).message}`,
    );
  } finally {
    syncing = false;
    broadcast(folder, { kind: "event", name: "reload" });
  }
}

/** 右クリックのメニューの引数からチケットを取り、サイドバーのフォルダに対して動かす。取れなければ何もしない */
async function withMenuTicket(
  arg: unknown,
  fn: (folder: vscode.WorkspaceFolder, row: MenuTicket) => Promise<void>,
): Promise<void> {
  const row = menuTicketOf(arg);
  const folder = sidebarFolder;
  if (!row || !folder) return;
  await fn(folder, row);
}

/**
 * 「Iteration を移す」。候補（閉じていない Iteration と「Iteration なし」）を QuickPick で選ばせ、ドラッグと同じ ticket.update を呼ぶ。
 * 拒否されたら通知に理由を出す。画面はデータの見張りでも読み直すが、待たずに読み直しを頼む
 */
async function moveFromMenu(folder: vscode.WorkspaceFolder, row: MenuTicket): Promise<void> {
  const client = clientFor(folder);
  try {
    const picks = await iterationPicks(client, row);
    const pick = await vscode.window.showQuickPick(picks, {
      title: `${row.ticket} を移す Iteration`,
      placeHolder: "Iteration を選ぶ",
    });
    if (!pick) return;
    if (await moveToIteration(client, row, pick)) {
      broadcast(folder, { kind: "event", name: "reload" });
    }
  } catch (error) {
    const failure = toCommandFailure(error);
    void vscode.window.showErrorMessage(
      `deguboard: ${row.ticket} を移せない: ${failure.message}${failure.detail ? `（${failure.detail}）` : ""}`,
    );
  }
}

/**
 * エディタ領域のパネルに詳細（route）を出す。既にあれば reveal してその詳細に移す。
 * なければ route を初期ルートにして作る（Webview が起動する前のイベントは届かないので HTML に埋める）。
 * パネルの中の詳細へのリンクもここに来て、同じパネルの中で遷移し題が変わる。一覧の画面へのリンクはサイドバーに回す
 */
async function openPanel(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  options: { column: vscode.ViewColumn; route: string; preserveFocus?: boolean },
): Promise<void> {
  const key = folder.uri.toString();
  const existing = panels.get(key);
  const { route } = options;
  if (existing) {
    void existing.webview.postMessage({
      kind: "event",
      name: "navigate",
      hash: route,
    } satisfies WebviewEvent);
    void retitle(existing, folder, route);
    existing.reveal(undefined, options.preserveFocus);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    PANEL_TYPE,
    panelTitle(folder),
    { viewColumn: options.column, preserveFocus: options.preserveFocus ?? false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
  void retitle(panel, folder, route);
  await attach(context, panel.webview, folder, {
    surface: "panel",
    route,
    actions: {
      open: (route) =>
        subjectOfRoute(route)
          ? openPanel(context, folder, { column: options.column, route })
          : showInSidebar(route),
      show: showInSidebar,
    },
  });
}

/** パネルの題。チケットや Iteration の詳細を出しているときは「t12 タイトル」「s3 名前」にしてエディタのタブで見分けられるようにする（ヘッダーを出さないので。UI-12） */
async function retitle(
  panel: vscode.WebviewPanel,
  folder: vscode.WorkspaceFolder,
  route: string,
): Promise<void> {
  const subject = subjectOfRoute(route);
  if (!subject) {
    panel.title = panelTitle(folder);
    return;
  }
  panel.title = subject.id;
  try {
    const client = clientFor(folder);
    const name =
      subject.kind === "ticket"
        ? (await client.run<{ title: string }>("ticket.show", { ticket: subject.id })).data.title
        : subject.kind === "epic"
          ? (await client.run<{ title: string }>("epic.show", { epic: subject.id })).data.title
          : (await client.run<{ name: string }>("iteration.show", { iteration: subject.id })).data
              .name;
    // 読んでいる間に別の画面へ移っていたら上書きしない
    if (panel.title === subject.id) panel.title = `${subject.id} ${name}`;
  } catch {
    // 題が番号だけになるだけで、画面は Webview が自分で読む
  }
}

interface AttachOptions {
  surface: Surface;
  route: string;
  /** status の応答を横取りして知らせる（サイドバーのバッジ）。ホスト側で別にポーリングしない */
  onStatus?: (status: StatusView) => void;
  actions?: WebviewActions;
}

/** Webview に web を載せ、要求をフォルダの CommandClient に通す。サイドバーとパネルで共通 */
async function attach(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  folder: vscode.WorkspaceFolder,
  options: AttachOptions,
): Promise<void> {
  const webRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "web");
  webview.options = { enableScripts: true, localResourceRoots: [webRoot] };
  const client = clientFor(folder);
  webview.onDidReceiveMessage((message: unknown) => {
    if (!isWebviewRequest(message)) return;
    void handleRequest(client, message, options.actions).then((response) => {
      if (message.kind === "status" && response.ok && options.onStatus) {
        options.onStatus(response.data as StatusView);
      }
      return webview.postMessage(response);
    });
  });
  const indexHtml = await readFile(vscode.Uri.joinPath(webRoot, "index.html").fsPath, "utf8");
  webview.html = renderWebviewHtml(indexHtml, {
    asset: (p) => webview.asWebviewUri(vscode.Uri.joinPath(webRoot, p)).toString(),
    cspSource: webview.cspSource,
    nonce: randomBytes(16).toString("hex"),
    surface: options.surface,
    route: options.route,
  });
}

function clientFor(folder: vscode.WorkspaceFolder): CommandClient {
  const key = folder.uri.toString();
  let client = clients.get(key);
  if (!client) {
    // 拡張ホストに環境変数が届かない起動（GUI など）では、core が git config の deguboard.user から決める
    client = createLocalClient({
      cwd: folder.uri.fsPath,
      ...pickUser(undefined, process.env["DEGUBOARD_USER"]),
      actions: ACTION_NAMES,
    });
    clients.set(key, client);
    void watchData(folder, client);
  }
  return client;
}

/**
 * データのファイル（tickets/*.md・runs/*.json と、実行中の Run の deguboard-local/runs/*.json。対象は watch.ts）を見張り、
 * 変わったらサイドバーとパネルに読み直しを頼む。Run の画面とチケット詳細の Run の節は、読み直しで一覧が変わると Run も取り直す。
 * 1 回の書き込みで複数のファイルが変わるので 200ms まとめる。画面からの書き込みも拾うが、読み直しが 1 回増えるだけ。
 * 置き場所は core が status で返す data_dir（.git/deguboard/）。取れなければ見張らない（画面は同期ボタンの読み直しで動く）
 */
async function watchData(folder: vscode.WorkspaceFolder, client: CommandClient): Promise<void> {
  const key = folder.uri.toString();
  if (watchers.has(key)) return;
  let dataDir: string;
  try {
    dataDir = (await client.status()).data_dir;
  } catch {
    return;
  }
  const pending = coalesce(() => broadcast(folder, { kind: "event", name: "reload" }), 200);
  const fsWatchers = watchTargets(dataDir).map((target) => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(target.base), target.pattern),
    );
    watcher.onDidCreate(pending.fire);
    watcher.onDidChange(pending.fire);
    watcher.onDidDelete(pending.fire);
    return watcher;
  });
  watchers.set(key, {
    dispose() {
      pending.cancel();
      for (const watcher of fsWatchers) watcher.dispose();
    },
  });
}

function panelTitle(folder: vscode.WorkspaceFolder): string {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    ? `deguboard: ${folder.name}`
    : "deguboard";
}

/** 起動時に 1 回、PATH の dg を確かめて知らせる。画面は dg なしで動くので止めない */
async function adviseAboutDg(): Promise<void> {
  const advice = dgAdvice(await resolveDg(), __CORE_VERSION__);
  if (!advice) return;
  const show =
    advice.level === "warning"
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
  void show(`deguboard: ${advice.text}`);
}
