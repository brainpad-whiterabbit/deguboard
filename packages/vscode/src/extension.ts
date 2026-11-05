// 拡張ホストの入口。Activity Bar のアイコンからサイドバーのビューに web を載せ、それを主画面にする（UI-12）。
// エディタ領域のパネルはサイドバーから開いた詳細（チケット・Iteration・Epic）だけを出し、一覧の画面（カンバンなど）はサイドバーに出す。
// パネルの題は詳細の番号と名前にする（パネルにはヘッダーを出さないので、題で見分ける）。
// 今のブランチに紐づくチケットをステータスバーに出す（statusbar.ts）。
// コード中の ID（t12・s3・e2・p7）にホバーとリンクを付ける（ids.ts）。存在する ID だけで、索引は見張りで更新する。
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
import {
  type ApprovalItem,
  approvalItems,
  approvalMessage,
  approvalRoute,
  newApprovals,
  viewTitle,
} from "./approvals.js";
import { dgAdvice, resolveDg } from "./dg.js";
import { GOTO_COMMAND, gotoItems } from "./goto.js";
import {
  buildIdIndex,
  findIds,
  linksOf,
  openIdArgs,
  hoverMarkdown,
  ID_DOCUMENT_SELECTOR,
  OPEN_ID_COMMAND,
  openIdCommandUri,
  routeOfId,
  type IdIndex,
  type IdSources,
} from "./ids.js";
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
/** watchData が data_dir を問い合わせている最中のフォルダ。重ねて張らない */
const watchStarting = new Set<string>();
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
/** dg の案内を出したか */
let advised = false;
/** 今のブランチのチケットを出すステータスバーの項目（最初の作業フォルダが対象）。紐づくチケットがなければ隠す */
let statusItem: vscode.StatusBarItem | undefined;
/** 今のチケットの ID。項目を押したときに開く */
let statusTicket: string | undefined;
/** refreshStatusBar の世代番号。最新の呼び出しの結果だけを反映する */
let statusGeneration = 0;
/** 通知から詳細を開くために覚える、拡張のコンテキスト */
let extensionContext: vscode.ExtensionContext | undefined;
/** フォルダごとの、前に見た承認待ち（承認待ちの Plan と review のチケット）の ID。ないうちは基準がなく、通知しない */
const approvalSeen = new Map<string, Set<string>>();
/** refreshApprovals の世代番号。最新の呼び出しの結果だけを反映する */
let approvalGeneration = 0;
/** 今の承認待ちの件数（最初の作業フォルダ）。サイドバーのタイトルに出す */
let approvalCount = 0;
/** ブランチの変わり（worktree の HEAD）の見張り。作業フォルダごと */
const headWatchers = new Map<string, vscode.Disposable>();

/** フォルダごとの存在する ID の索引。データの見張り（watchData）で作り直し、毎回 dg を呼ばない */
const idIndexes = new Map<string, IdIndex>();
/** 索引を読めなかった時刻（ミリ秒）。データのないリポジトリで要求のたびに dg を呼ばないよう覚える。ID_INDEX_RETRY_MS を過ぎたら読み直す */
const idIndexFailedAt = new Map<string, number>();
/** 読めなかったことを覚えておく時間。ターミナルの dg init などで後からデータができても、これを過ぎれば拾う */
const ID_INDEX_RETRY_MS = 30_000;
/** 読み込み中の索引（同じフォルダで重ねて読まない）と、読み込み中に変化が来て読み直しが要るフォルダ */
const idIndexLoading = new Map<string, Promise<IdIndex | undefined>>();
const idIndexDirty = new Set<string>();

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
    // コード中の ID のホバーとリンク（エディタとコミットメッセージの入力欄）。リンクはその ID の詳細のパネルを開く
    vscode.commands.registerCommand(OPEN_ID_COMMAND, (a0: unknown, a1?: unknown) => {
      const args = openIdArgs(a0, a1);
      if (!args) return;
      const { id } = args;
      // 2 つ目の引数は ID のあるフォルダの URI。複数のフォルダを開いていても、索引を作ったフォルダで開く（両辺を Uri.parse で正規化して比べる）
      const folders = vscode.workspace.workspaceFolders ?? [];
      const wanted =
        args.folder === undefined ? undefined : vscode.Uri.parse(args.folder).toString();
      const folder = folders.find((f) => f.uri.toString() === wanted) ?? folders[0];
      if (!folder) return;
      const route = routeOfId(id);
      if (!route) return;
      return openPanel(context, folder, { column: vscode.ViewColumn.Beside, route });
    }),
    // 「チケットへ移動」。ID の索引から QuickPick を出し、選んだ ID の詳細を開く
    vscode.commands.registerCommand(GOTO_COMMAND, () => gotoTicket(context)),
    vscode.languages.registerHoverProvider([...ID_DOCUMENT_SELECTOR], {
      async provideHover(document, position) {
        const index = (await idIndexFor(document.uri))?.index;
        if (!index) return undefined;
        const line = document.lineAt(position.line).text;
        const hit = findIds(line).find(
          (f) => f.start <= position.character && position.character <= f.end,
        );
        const entry = hit && index.get(hit.id);
        if (!hit || !entry) return undefined;
        const range = new vscode.Range(position.line, hit.start, position.line, hit.end);
        return new vscode.Hover(new vscode.MarkdownString(hoverMarkdown(entry)), range);
      },
    }),
    vscode.languages.registerDocumentLinkProvider([...ID_DOCUMENT_SELECTOR], {
      async provideDocumentLinks(document) {
        const found = await idIndexFor(document.uri);
        if (!found) return [];
        const links: vscode.DocumentLink[] = [];
        for (let line = 0; line < document.lineCount; line++) {
          for (const f of linksOf(document.lineAt(line).text, found.index)) {
            const link = new vscode.DocumentLink(
              new vscode.Range(line, f.start, line, f.end),
              vscode.Uri.parse(openIdCommandUri(f.id, found.folder)),
            );
            link.tooltip = `${f.id} の詳細を開く`;
            links.push(link);
          }
        }
        return links;
      },
    }),
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      { resolveWebviewView: (view) => resolveSidebar(context, view) },
      // 隠しても画面の状態（選んだ画面や編集中の本文）を失わない
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  void refreshStatusBar();
  extensionContext = context;
  void refreshApprovals();
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
  idIndexes.clear();
  idIndexFailedAt.clear();
}

/** サイドバーのビュー。最初の作業フォルダを対象にし、詳細を押すとエディタ領域のパネルに開く */
async function resolveSidebar(
  context: vscode.ExtensionContext,
  view: vscode.WebviewView,
): Promise<void> {
  void adviseAboutDg();
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
  view.title = viewTitle(approvalCount);
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
  forgetIdIndexFailure(folder);
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
  void adviseAboutDg();
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

/** パネルの題。チケットや Iteration の詳細を出しているときは「t12 タイトル」「s3 名前」（Plan は「p5」）にしてエディタのタブで見分けられるようにする（ヘッダーを出さないので。UI-12） */
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
  // Plan には名前がないので、題は番号だけにする
  if (subject.kind === "plan") return;
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
  // 初期化前のリポジトリで張れなかった見張りを、画面を開くたびに張り直す（張れていれば何もしない）
  void watchData(folder, client);
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
  forgetIdIndexFailure(folder);
  const key = folder.uri.toString();
  if (watchers.has(key) || watchStarting.has(key)) return;
  watchStarting.add(key);
  let dataDir: string;
  try {
    dataDir = (await client.status()).data_dir;
  } catch {
    // 初期化前のリポジトリなど。入れずに戻り、次の refreshStatusBar か画面を開いたとき（attach）に張り直す
    return;
  } finally {
    watchStarting.delete(key);
  }
  const pending = coalesce(() => {
    broadcast(folder, { kind: "event", name: "reload" });
    void refreshStatusBar();
    void refreshApprovals();
    // 変化があったので、読み込み中なら終わった後にもう 1 回読み直させる
    void loadIdIndex(folder, { changed: true });
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
  forgetIdIndexFailure(folder);
  try {
    const client = clientFor(folder);
    void watchHead(folder);
    void watchData(folder, client);
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

/**
 * 最初の作業フォルダの承認待ち（承認待ちの Plan と review のチケット。UI-12）を数え、サイドバーのタイトルに件数を出す。
 * 前に見た集合になかったものが現れたら、config.yaml の vscode.notify_approvals が true のとき（既定）通知し、
 * 「開く」で詳細のパネルを開く。起動して初めて読めたときは基準にするだけで通知しない。読めないとき（データのないリポジトリなど）は何も出さない。
 * Activity Bar のバッジは未 push・未取り込み（badgeOf）が使うので、承認待ちはタイトルに出す
 */
async function refreshApprovals(): Promise<void> {
  const generation = ++approvalGeneration;
  const folder = (vscode.workspace.workspaceFolders ?? [])[0];
  if (!folder) return;
  try {
    const client = clientFor(folder);
    const plans = (await client.run<{ id: string }[]>("plan.list", { status: "pending" })).data;
    const tickets = (await client.run<{ id: string }[]>("ticket.list", { status: ["review"] }))
      .data;
    if (generation !== approvalGeneration) return;
    const items = approvalItems(plans, tickets);
    const key = folder.uri.toString();
    const arrived = newApprovals(approvalSeen.get(key), items);
    approvalSeen.set(key, new Set(items.map((i) => i.id)));
    approvalCount = items.length;
    if (sidebar) sidebar.title = viewTitle(approvalCount);
    if (arrived.length === 0) return;
    const config = (await client.run<{ vscode?: { notify_approvals?: boolean } }>("config.show"))
      .data;
    if (config.vscode?.notify_approvals === false) return;
    void notifyApprovals(folder, arrived);
  } catch {
    // 読めないときは前の表示のまま。通知は出さない
  }
}

/** 増えた承認待ちを知らせ、「開く」で詳細を開く。複数あれば選ばせる。前に見た集合との差だけを知らせるので、同じものは重ねて出ない */
async function notifyApprovals(
  folder: vscode.WorkspaceFolder,
  arrived: ApprovalItem[],
): Promise<void> {
  const context = extensionContext;
  if (!context) return;
  {
    const open = "開く";
    const choice = await vscode.window.showInformationMessage(approvalMessage(arrived), open);
    if (choice !== open) return;
    let item: ApprovalItem | undefined = arrived[0];
    if (arrived.length > 1) {
      const picked = await vscode.window.showQuickPick(
        arrived.map((i) => ({
          label: i.id,
          description: i.kind === "plan" ? "Plan" : "review",
          item: i,
        })),
        { placeHolder: "開く承認待ちを選ぶ" },
      );
      item = picked?.item;
    }
    const route = item && approvalRoute(item);
    if (route) await openPanel(context, folder, { column: vscode.ViewColumn.Beside, route });
  }
}

/**
 * 文書のあるフォルダ（なければ最初の作業フォルダ）の ID の索引と、そのフォルダの URI。まだなければ 1 回だけ読む（読み込み中ならそれを待つだけ）。
 * 読めなかったことは ID_INDEX_RETRY_MS の間覚えるので、データのないリポジトリで要求のたびに dg を呼ばない。読めなければ undefined。
 * コミットメッセージの入力欄（vscode-scm）の文書はどの作業フォルダにも属さないので、最初の作業フォルダの索引を使う（制約）。
 * 見張りで索引を作り直しても、すでに開いている文書のリンクは付け直されない（VS Code はリンクを文書の編集のときに取り直す）
 */
async function idIndexFor(
  uri: vscode.Uri,
  options: { retry?: boolean } = {},
): Promise<{ index: IdIndex; folder: string } | undefined> {
  const folder =
    vscode.workspace.getWorkspaceFolder(uri) ?? (vscode.workspace.workspaceFolders ?? [])[0];
  if (!folder) return undefined;
  // retry: 利用者が自分で起動したときは、覚えた失敗があっても読み直す
  if (options.retry) forgetIdIndexFailure(folder);
  const key = folder.uri.toString();
  let index = idIndexes.get(key);
  if (!index) {
    const failedAt = idIndexFailedAt.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < ID_INDEX_RETRY_MS) return undefined;
    // 読み込み中ならそれを待つだけ（読み直しの印は立てない）
    index = await (idIndexLoading.get(key) ?? loadIdIndex(folder));
  }
  return index ? { index, folder: key } : undefined;
}

/**
 * 「チケットへ移動」。開いているエディタの文書があるフォルダ（なければ最初の作業フォルダ）の索引から選ばせる。
 * 複数のフォルダを開いているときも、出すのは 1 つのフォルダのデータだけ（ID はフォルダごとに重なりうるため）。
 * 索引が読めなければ（データのないリポジトリなど）、メッセージを 1 回出す。このコマンドは利用者が起動したときだけ動く
 */
async function gotoTicket(context: vscode.ExtensionContext): Promise<void> {
  const uri =
    vscode.window.activeTextEditor?.document.uri ??
    (vscode.workspace.workspaceFolders ?? [])[0]?.uri;
  const found = uri ? await idIndexFor(uri, { retry: true }) : undefined;
  if (!found) {
    void vscode.window.showInformationMessage("deguboard: チケットのデータを読めない");
    return;
  }
  const items = gotoItems(found.index).map((i) => ({
    label: i.label,
    description: i.description,
    detail: i.detail,
    id: i.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "ID かタイトルの一部で絞り込む（例: t12、ログイン）",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const folder = (vscode.workspace.workspaceFolders ?? []).find(
    (f) => f.uri.toString() === found.folder,
  );
  const route = routeOfId(picked.id);
  if (!folder || !route) return;
  await openPanel(context, folder, { column: vscode.ViewColumn.Beside, route });
}

/** 覚えた「読めなかった」を忘れる。データの見張り・ステータスバーの更新・同期・利用者が「チケットへ移動」を起動したとき、次の要求で読み直させる */
function forgetIdIndexFailure(folder: vscode.WorkspaceFolder): void {
  idIndexFailedAt.delete(folder.uri.toString());
}

/**
 * チケット（abandoned も）・Iteration・Epic・Plan の一覧を読んで索引を作り直す。読めないとき（データのないリポジトリなど）は
 * 通知を出さず、読めなかった時刻を覚える。changed（データの見張りからの呼び出し）が読み込み中に来たら、
 * 終わったあとで 1 回だけ読み直す（変化を取りこぼさない）。要求が読み込みを待つだけの呼び出しでは印を立てない
 */
function loadIdIndex(
  folder: vscode.WorkspaceFolder,
  options: { changed?: boolean } = {},
): Promise<IdIndex | undefined> {
  const key = folder.uri.toString();
  const running = idIndexLoading.get(key);
  if (running) {
    if (options.changed) idIndexDirty.add(key);
    return running;
  }
  const load = (async () => {
    try {
      for (;;) {
        idIndexDirty.delete(key);
        const index = await readIdIndex(folder);
        if (idIndexDirty.has(key)) continue;
        if (index) {
          idIndexes.set(key, index);
          idIndexFailedAt.delete(key);
          return index;
        }
        // 読み直しが一時的に失敗しても、前の索引があれば残す。失敗の時刻は索引がないときだけ覚える
        const previous = idIndexes.get(key);
        if (!previous) idIndexFailedAt.set(key, Date.now());
        return previous;
      }
    } finally {
      idIndexLoading.delete(key);
    }
  })();
  idIndexLoading.set(key, load);
  return load;
}

async function readIdIndex(folder: vscode.WorkspaceFolder): Promise<IdIndex | undefined> {
  try {
    const client = clientFor(folder);
    const [tickets, iterations, epics, plans] = await Promise.all([
      client.run<IdSources["tickets"]>("ticket.list", { include_abandoned: true }),
      client.run<IdSources["iterations"]>("iteration.list", {}),
      client.run<IdSources["epics"]>("epic.list", {}),
      client.run<IdSources["plans"]>("plan.list", {}),
    ]);
    return buildIdIndex({
      tickets: tickets.data,
      iterations: iterations.data,
      epics: epics.data,
      plans: plans.data,
    });
  } catch {
    return undefined;
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

/** 最初の使用時に 1 回、PATH の dg を確かめて知らせる。画面は dg なしで動くので止めない */
async function adviseAboutDg(): Promise<void> {
  // 起動時ではなく、サイドバーかパネルを最初に使うときに 1 回だけ出す（deguboard を使わないウィンドウでは出さない）
  if (advised) return;
  advised = true;
  const advice = dgAdvice(await resolveDg(), __CORE_VERSION__);
  if (!advice) return;
  const show =
    advice.level === "warning"
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
  void show(`deguboard: ${advice.text}`);
}
