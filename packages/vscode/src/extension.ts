// 拡張ホストの入口。Activity Bar のアイコンからサイドバーのビューに web を載せ、それを主画面にする（UI-12）。
// エディタ領域のパネルはサイドバーから開いた詳細（チケット・Iteration・Epic）だけを出し、一覧の画面（カンバンなど）はサイドバーに出す。
// パネルの題は詳細の番号と名前にする（パネルにはヘッダーを出さないので、題で見分ける）。
// 今のブランチに紐づくチケットをステータスバーに出す（statusbar.ts）。
// データ worktree と実行中の Run の記録を見張り、CLI やエージェントの書き込みを画面に映す。
// Webview からの要求は core のプロセス内 CommandClient に通す（ADR-006・ADR-007）。サーバーは起動しない。
// dg は同梱せず、PATH の dg を案内する（UI-11）。VS Code の API に触れるのはこのファイルだけ

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTION_NAMES,
  createLocalClient,
  pickUser,
  toCommandFailure,
  WEBVIEW_CONTRACT,
  type CommandClient,
  type StatusView,
  type WebviewEvent,
} from "@deguboard/core";
import * as vscode from "vscode";
import {
  BACKLOG_ROW_COMMANDS,
  menuTicketOf,
  ticketRoute,
  type MenuTicket,
} from "./context-menu.js";
import { dgAdvice, resolveDg } from "./dg.js";
import {
  currentBranch,
  headFile,
  statusBarText,
  statusBarTooltip,
  STATUSBAR_COMMAND,
  ticketOfBranch,
  type BranchTicket,
} from "./statusbar.js";
import { watchTargets } from "./watch.js";
import {
  askDelivery,
  askEvent,
  badgeOf,
  coalesce,
  currentAskDelivery,
  handleRequest,
  isWebviewRequest,
  renderMessageHtml,
  renderWebviewHtml,
  sidebarDelivery,
  subjectOfRoute,
  type Surface,
  type WebviewActions,
} from "./webview.js";

/** 左パネルのビューの ID（package.json の views と合わせる）と、エディタのパネルの viewType */
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
/** サイドバーがまだ描かれていないときに出す、エージェントに頼む入力欄の対象。サイドバーを作るときに HTML に埋める */
let pendingSidebarAsk: string[] | undefined;
/** 同期の実行中。重ねて走らせない */
let syncing = false;
/** 今のブランチのチケットを出すステータスバーの項目（最初の作業フォルダが対象）。紐づくチケットがなければ隠す */
let statusItem: vscode.StatusBarItem | undefined;
/** 今のチケットの ID。項目を押したときに開く */
let statusTicket: string | undefined;
/** refreshStatusBar の世代番号。最新の呼び出しの結果だけを反映する */
let statusGeneration = 0;
/** ブランチの変わり（worktree の HEAD）の見張り。作業フォルダごと */
const headWatchers = new Map<string, vscode.Disposable>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // ビューのタイトル行の同期ボタン（UI-12）。拡張ホストで実行してから、サイドバーとパネルの両方に読み直しを頼む
    // （サイドバーが描かれていなくても動く）。リモートがなくても読み直しだけはするので、手の再読み込みも兼ねる
    vscode.commands.registerCommand("deguboard.sync", () => void syncFolder()),
    // ビューのタイトル行の歯車。サイドバーの中をカンバン（来る前の画面）と設定画面（config.yaml）で切り替える
    vscode.commands.registerCommand(
      "deguboard.config",
      () => void toggleInSidebar(WEBVIEW_CONTRACT.routes.config),
    ),
    // エージェントに頼む入力欄（UI-15）。タイトル行の吹き出しは左パネルの下に、画面の今の対象（カンバンで選んでいる Iteration、
    // 履歴で開いている行。なければ対象なし）で出す。コマンドパレットは開いているパネルの下（パネルが手前になければ左パネルの下）に、対象なしで出す
    vscode.commands.registerCommand("deguboard.ask", () => void askFromPalette()),
    vscode.commands.registerCommand("deguboard.askInSidebar", () => void askCurrentInSidebar()),
    // 左パネルのバックログの行の右クリック（package.json の webview/context。引数は行の data-vscode-context）
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
        await copyToClipboard(row.ticket);
        void vscode.window.setStatusBarMessage(`deguboard: ${row.ticket} をコピーした`, 3000);
      }),
    ),
    vscode.commands.registerCommand(STATUSBAR_COMMAND, () => {
      const folder = (vscode.workspace.workspaceFolders ?? [])[0];
      if (!folder || !statusTicket) return;
      return openPanel(context, folder, {
        column: vscode.ViewColumn.Beside,
        route: ticketRoute({ ticket: statusTicket }),
      });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshStatusBar()),
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      { resolveWebviewView: (view) => resolveSidebar(context, view) },
      // 隠しても画面の状態（選んだ画面や編集中の本文）を失わない
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  void adviseAboutDg();
  void refreshStatusBar();
}

export function deactivate(): void {
  for (const panel of panels.values()) panel.dispose();
  panels.clear();
  for (const watcher of watchers.values()) watcher.dispose();
  watchers.clear();
  for (const watcher of headWatchers.values()) watcher.dispose();
  headWatchers.clear();
  statusItem?.dispose();
  statusItem = undefined;
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
  const route = pendingSidebarRoute ?? WEBVIEW_CONTRACT.routes.board;
  const ask = pendingSidebarAsk;
  pendingSidebarRoute = undefined;
  pendingSidebarAsk = undefined;
  await attach(context, view.webview, folder, {
    surface: "sidebar",
    route,
    ask,
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
      copy: copyToClipboard,
    },
  });
}

/**
 * 一覧の画面（カンバン・バックログ・履歴）をサイドバーのビューに出してフォーカスを移す。パネルの中身は変えない。
 * サイドバーがまだ描かれていなければ、初期ルートとして覚えてからビューを開く（resolveSidebar が使う）
 */
async function showInSidebar(route: string): Promise<void> {
  await deliverToSidebar(sidebarDelivery(sidebar !== undefined, "navigate", route), rememberRoute);
}

/** 文字をクリップボードに入れる。Webview の画面のコピー（依頼文・ブランチ名）と、バックログの「ID をコピー」で使う */
async function copyToClipboard(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
}

/**
 * サイドバーの画面をその画面と来る前の画面で切り替える（Webview が今の画面を知っているので、切り替えは web に任せる）。
 * サイドバーがまだ描かれていなければ、その画面を初期ルートにしてビューを開く
 */
async function toggleInSidebar(route: string): Promise<void> {
  await deliverToSidebar(sidebarDelivery(sidebar !== undefined, "toggle", route), rememberRoute);
}

/**
 * webview.ts の届け方（sidebarDelivery・askDelivery・currentAskDelivery）の決めたとおりに、描かれたサイドバーへ送るか、
 * まだ描かれていなければ remember で覚えて（resolveSidebar が使う）、ビューを開く
 */
async function deliverToSidebar<P>(
  delivery: { post: WebviewEvent } | { pending: P },
  remember: (pending: P) => void,
): Promise<void> {
  if ("post" in delivery) void sidebar?.webview.postMessage(delivery.post);
  else remember(delivery.pending);
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}

const rememberRoute = (route: string) => {
  pendingSidebarRoute = route;
};
const rememberAsk = (targets: string[]) => {
  pendingSidebarAsk = targets;
};

/** 左パネルの下にエージェントに頼む入力欄を出す。描かれていなければ対象を覚えてからビューを開く */
async function askInSidebar(targets: string[]): Promise<void> {
  await deliverToSidebar(askDelivery(sidebar !== undefined, targets), rememberAsk);
}

/** タイトル行の吹き出し。左パネルの画面に今の対象を問い、それを対象にして左パネルの下に入力欄を出す（描かれていなければ対象なし） */
async function askCurrentInSidebar(): Promise<void> {
  await deliverToSidebar(currentAskDelivery(sidebar !== undefined), rememberAsk);
}

/** パネルの下に入力欄を出して、そのパネルを手前に出す。パネルがなければ左パネルの下に出す */
async function askBelow(panel: vscode.WebviewPanel | undefined, targets: string[]): Promise<void> {
  if (!panel) return askInSidebar(targets);
  void panel.webview.postMessage(askEvent(targets));
  panel.reveal(undefined, false);
}

/** コマンドパレットの「エージェントに頼む」。手前のパネルがあればその下に、なければ左パネルの下に対象なしで出す */
async function askFromPalette(): Promise<void> {
  await askBelow(
    [...panels.values()].find((p) => p.active),
    [],
  );
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
      copy: copyToClipboard,
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
          : // iteration.show は持ち越しのある閉じた Iteration で履歴を全件読むので、名前だけなら list で読む
            (await client.run<{ id: string; name: string }[]>("iteration.list", {})).data.find(
              (i) => i.id === subject.id,
            )?.name;
    // 読んでいる間に別の画面へ移っていたら上書きしない
    if (panel.title === subject.id) panel.title = name ? `${subject.id} ${name}` : subject.id;
  } catch {
    // 題が番号だけになるだけで、画面は Webview が自分で読む
  }
}

interface AttachOptions {
  surface: Surface;
  route: string;
  /** 開いたらすぐ出す、エージェントに頼む入力欄の対象。省けば出さない */
  ask?: string[] | undefined;
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
    ask: options.ask,
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
 * 変わったらサイドバーとパネルに読み直しを頼む。チケット詳細の Run の節は、読み直しで一覧が変わると Run も取り直す。
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
  const pending = coalesce(() => {
    broadcast(folder, { kind: "event", name: "reload" });
    void refreshStatusBar();
  }, 200);
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

/**
 * 最初の作業フォルダの今のブランチに紐づくチケット（ticket.list の branch が一致するもの）の ID・Status と、Run が実行中かを
 * ステータスバーに出す。紐づくチケットがなければ隠す。データの変化（watchData）とブランチの変わり（HEAD の見張り）で呼び直す。
 * 読めないとき（deguboard のデータがないリポジトリなど）も隠すだけで、通知は出さない
 */
async function refreshStatusBar(): Promise<void> {
  // 並んで走ったとき、最新でない結果で新しい表示を上書きしないよう世代で捨てる
  const generation = ++statusGeneration;
  const folder = (vscode.workspace.workspaceFolders ?? [])[0];
  if (!folder) {
    hideStatusBar();
    return;
  }
  try {
    const client = clientFor(folder);
    void watchHead(folder);
    const branch = await currentBranch(folder.uri.fsPath);
    const ticket = ticketOfBranch(
      (await client.run<BranchTicket[]>("ticket.list", {})).data,
      branch,
    );
    if (generation !== statusGeneration) return;
    if (!ticket) return hideStatusBar();
    const running = (
      await client.run<{ ticket: string }[]>("run.list", { ticket: ticket.id, running: true })
    ).data.some((r) => r.ticket === ticket.id);
    if (generation !== statusGeneration) return;
    statusItem ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusItem.command = STATUSBAR_COMMAND;
    statusItem.text = statusBarText(ticket, running);
    statusItem.tooltip = statusBarTooltip(ticket, running);
    statusTicket = ticket.id;
    statusItem.show();
  } catch {
    if (generation === statusGeneration) hideStatusBar();
  }
}

function hideStatusBar(): void {
  statusTicket = undefined;
  statusItem?.hide();
}

/** worktree の HEAD を見張り、ブランチが変わったらステータスバーを更新する（フォルダごとに 1 回だけ張る） */
async function watchHead(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();
  if (headWatchers.has(key)) return;
  headWatchers.set(key, { dispose() {} }); // 張っている間に重ねて張らない
  const file = await headFile(folder.uri.fsPath);
  if (!file) {
    headWatchers.delete(key);
    return;
  }
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), "HEAD"),
  );
  const pending = coalesce(() => void refreshStatusBar(), 200);
  watcher.onDidCreate(pending.fire);
  watcher.onDidChange(pending.fire);
  headWatchers.set(key, {
    dispose() {
      pending.cancel();
      watcher.dispose();
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
