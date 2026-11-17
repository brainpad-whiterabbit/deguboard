// 拡張ホストの入口。Activity Bar のアイコンからサイドバーのビューに web を載せ、それを主画面にする（UI-12）。
// エディタ領域のパネルはサイドバーから開いた詳細（チケット・Iteration・Epic）だけを出し、一覧の画面（カンバンなど）はサイドバーに出す。
// パネルの題は詳細の番号と名前にする（パネルにはヘッダーを出さないので、題で見分ける）。
// コード中の ID（t12・s3・e2・p7）にホバーとリンクを付ける（ids.ts）。存在する ID だけで、索引は見張りで更新する。
// データ worktree と実行中の Run の記録を見張り、CLI やエージェントの書き込みを画面に映す。
// dg init 前は .git/deguboard/ ができるのを見張り（watchInit）、できたら見張りを張り直して画面を普段の画面に変える。
// 導入のチェックリスト（UI-12）は、core の dg setup check に拡張だけの項目（フォルダ・OS・PATH の dg）を足して画面に渡し（readSetup。組み立ては setup.ts）、
// ボタンの操作を deguboard のターミナルで実行し（setupAct）、人がターミナルで直したことを見張りで拾って確かめ直させる（watchSetup・autoSetup）。
// 項目が欠けている間は、タイトル行のセットアップのアイコンを点付きに差し替える（showSetupAttention。仕組みは attention.ts）。
// Webview からの要求は core のプロセス内 CommandClient に通す（ADR-027）。サーバーは起動しない。
// 同梱した dg は、起動のたびに版の付かない起動ファイルと行き先を書いて外に出す（launcher.ts）。コマンドで ~/.local/bin/dg に張り、外せる。
// PATH の dg がない・版のメジャーが違うことは、通知にせずチェックリストの項目で示す（UI-11）。起動のたびに、入れてある dg の Skill を同梱の dg のものに更新し、足りない同梱の Skill を案内する（skills.ts）。
// VS Code の API に触れるのはこのファイルだけ

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSkills,
  checkSetup,
  createLocalClient,
  detailOfRoute,
  detailRouteOf,
  findIdsInText,
  findMissingSkills,
  installMissingSkills,
  pickUser,
  refreshInstalledSkills,
  toCommandFailure,
  uninstall,
  uninstallRouteOf,
  WEBVIEW_CONTRACT,
  type CommandClient,
  type ResolveSide,
  type SetupAction,
  type SetupBoardSource,
  type SetupView,
  type SkillFile,
  type StatusView,
  type TerminalChoice,
  type TerminalSendResult,
  type UninstallPreview,
  type WebviewEvent,
} from "@deguboard/core";
import * as vscode from "vscode";
import {
  type AttentionButton,
  attentionCommands,
  attentionValue,
  SETUP_ATTENTION,
} from "./attention.js";
import { MENU_COMMANDS, menuItemOf, type MenuItem } from "./context-menu.js";
import {
  type ApprovalItem,
  approvalItems,
  approvalMessage,
  approvalRoute,
  newApprovals,
  viewTitle,
} from "./approvals.js";
import { dgCheckCwd, resolveDg } from "./dg.js";
import { GOTO_COMMAND, gotoItems } from "./goto.js";
import {
  buildIdIndex,
  linksOf,
  openIdArgs,
  hoverMarkdown,
  ID_DOCUMENT_SELECTOR,
  OPEN_ID_COMMAND,
  openIdCommandUri,
  type IdIndex,
  type IdSources,
} from "./ids.js";
import { setTranslator, t } from "./l10n.js";
import {
  type Current,
  type DgLink,
  dgLinkOf,
  installLauncher,
  type LauncherResult,
  launcherFileOf,
  linkDg,
  linkPathOf,
  mergeDriverOf,
  onPath,
  unlinkDg,
} from "./launcher.js";
import {
  DISMISSED_SKILLS_KEY,
  dismissedSkillsOf,
  missingSkillAction,
  type MissingSkillNotice,
  missingSkillNotices,
  skillRefreshNotices,
} from "./skills.js";
import {
  autoRecheck,
  buildSetupView,
  type DgCommandFacts,
  heldSetupBoard,
  missingSetupCount,
  setupCommands,
  supportedPlatform,
} from "./setup.js";
import { pickedSide, syncNotice } from "./sync-resolve.js";
import {
  describeTerminals,
  setupCommandLine,
  START_TERMINAL_NAME,
  startTerminalPlan,
  terminalInput,
} from "./terminals.js";
import { commonDirOf, initWatchTarget, setupWatchTargets, watchTargets } from "./watch.js";
import {
  askDelivery,
  askEvent,
  badgeOf,
  coalesce,
  currentAskDelivery,
  handleRequest,
  isWebviewRequest,
  renderWebviewHtml,
  sidebarDelivery,
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
/** dg init 前のフォルダごとの、データ worktree ができるのを待つ見張り。watchData が張れたら外す（initWatchTarget） */
const initWatchers = new Map<string, vscode.Disposable>();
/** watchData が data_dir を問い合わせている最中のフォルダ。重ねて張らない */
const watchStarting = new Set<string>();
/** 今出ているサイドバーのビュー。右クリックで非表示にされると dispose され、再表示で作り直される */
let sidebar: vscode.WebviewView | undefined;
/** サイドバーが対象にするフォルダ（最初の作業フォルダ。開いていなければ undefined）。ビューのタイトル行のコマンドはこのフォルダに対して動く */
let sidebarFolder: vscode.WorkspaceFolder | undefined;
/**
 * フォルダごとの、最後に確かめた導入のチェックリスト（鍵は folderKey。フォルダを開いていなければ ""）。
 * 見張りで自動で確かめ直すか（setup.ts の autoRecheck）と、「Skill と hooks を入れる」ボタンが流すコマンドに使う
 */
const setupViews = new Map<string, SetupView>();
/**
 * 人が推奨の項目の帯を「このリポジトリでは出さない」にしているフォルダ（鍵は folderKey）。決めたことは Webview の見た目の状態にあり、
 * 左パネルが確かめるたびに伝えてくる（readSetup）。推奨だけが欠けている間の自動の確かめ直しをやめるのに使う（setup.ts の autoRecheck）
 */
const setupBandDismissed = new Set<string>();
/**
 * 人がボードの項目で指定したデータの置き場所（鍵は folderKey。なければコードのリモート）。指定し直した画面だけが伝え（readSetup）、
 * 左パネルとエディタのパネルの確かめ直しとボタンの dg init が同じ指定を使う（setup.ts の heldSetupBoard）
 */
const setupBoards = new Map<string, SetupBoardSource>();
/** フォルダごとの、導入のチェックリストを確かめ直すための見張り（watchSetup） */
const setupWatchers = new Map<string, vscode.Disposable>();
/** サイドバーがまだ描かれていないときに出す画面。サイドバーを開いて作るときの初期ルートにする */
let pendingSidebarRoute: string | undefined;
/** サイドバーがまだ描かれていないときに出す、エージェントに頼む入力欄の対象。サイドバーを作るときに HTML に埋める */
let pendingSidebarAsk: string[] | undefined;
/** 同期の実行中。重ねて走らせない */
let syncing = false;
/** 通知から詳細を開くために覚える、拡張のコンテキスト */
let extensionContext: vscode.ExtensionContext | undefined;
/** 起動ファイルを書いた結果。書き終える前と書けなかったときは、マージドライバが起動ファイルを指さない（mergeDriverOf） */
let launcherResult: LauncherResult | undefined;
/** フォルダごとの、前に見た承認待ち（承認待ちの Plan と review のチケット）の ID。ないうちは基準がなく、通知しない */
const approvalSeen = new Map<string, Set<string>>();
/** refreshApprovals の世代番号。最新の呼び出しの結果だけを反映する */
let approvalGeneration = 0;
/** 今の承認待ちの件数（最初の作業フォルダ）。サイドバーのタイトルに出す */
let approvalCount = 0;

/** フォルダごとの存在する ID の索引。データの見張り（watchData）で作り直し、毎回 dg を呼ばない */
const idIndexes = new Map<string, IdIndex>();
/** 索引を読めなかった時刻（ミリ秒）。データのないリポジトリで要求のたびに dg を呼ばないよう覚える。ID_INDEX_RETRY_MS を過ぎたら読み直す */
const idIndexFailedAt = new Map<string, number>();
/** 読めなかったことを覚えておく時間。ターミナルの dg init などで後からデータができても、これを過ぎれば拾う */
const ID_INDEX_RETRY_MS = 30_000;
/** 読み込み中の索引（同じフォルダで重ねて読まない）と、読み込み中に変化が来て読み直しが要るフォルダ */
const idIndexLoading = new Map<string, Promise<IdIndex | undefined>>();
const idIndexDirty = new Set<string>();
/**
 * チェックリストのボタンの 1 行をまだ実行中のターミナル（UI-12）。送ったら入り、そのターミナルで最初に実行が終わったら外す。
 * シェルは 1 つずつ実行するので、送った後に最初に終わる実行は送った 1 行に当たる。実行の始まり・終わりは
 * シェル統合（shell integration）が知らせる。統合がないターミナルでは終わりが来ないので、閉じるまで実行中のままになる
 */
const startRuns = new Set<vscode.Terminal>();

export function activate(context: vscode.ExtensionContext): void {
  // 拡張ホストの文言を表示言語で出す（l10n.ts）。ほかの処理より先に差し込む
  setTranslator((message, ...args) => vscode.l10n.t(message, ...args));
  context.subscriptions.push(
    // ターミナルが開いた・閉じたら、頼む小窓の送り先を更新させる（UI-15）。ターミナルを開くのは人で、拡張は開かない
    vscode.window.onDidOpenTerminal(() => broadcastTerminals()),
    vscode.window.onDidCloseTerminal((closed) => {
      startRuns.delete(closed);
      broadcastTerminals(closed);
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      // チェックリストのボタンの実行が終わったら、必ず確かめ直す（人が押した結果をその場に出す）。
      // 人がターミナルで自分で直したことも実行の終わりで拾うが、こちらは見張りと同じ扱いにする（autoSetup）
      if (startRuns.delete(event.terminal)) postSetup();
      else autoSetup.fire();
    }),
    // ほかのアプリやターミナルで直して戻ってきたとき（git を入れた、など見張れない変化）も確かめ直す
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) autoSetup.fire();
    }),
    // アクティブなターミナル（送り先の既定）と名前の変化も送り先に反映する
    vscode.window.onDidChangeActiveTerminal(() => broadcastTerminals()),
    vscode.window.onDidChangeTerminalState(() => broadcastTerminals()),
    // ビューのタイトル行の同期ボタン（UI-12）。拡張ホストで実行してから、サイドバーとパネルの両方に読み直しを頼む
    // （サイドバーが描かれていなくても動く）。リモートがなくても読み直しだけはするので、手の再読み込みも兼ねる
    vscode.commands.registerCommand("deguboard.sync", () => void syncFolder()),
    // ビューのタイトル行の歯車。サイドバーの中をカンバン（来る前の画面）と設定画面（config.yaml）で切り替える
    vscode.commands.registerCommand(
      "deguboard.config",
      () => void toggleInSidebar(WEBVIEW_CONTRACT.routes.config),
    ),
    // ビューのタイトル行の左端のセットアップのアイコンとコマンドパレット。サイドバーの中を来る前の画面と導入のチェックリストで切り替える
    // （推奨をすべて満たした後と、帯を出さないと決めた後も、いつでも開ける。UI-12）
    // 項目が欠けている間は、点付きのアイコンの差し替え用のコマンド（attention.ts）に替わるので、同じ処理を登録する
    ...[SETUP_ATTENTION.command, ...attentionCommands(SETUP_ATTENTION)].map((command) =>
      vscode.commands.registerCommand(
        command,
        () => void toggleInSidebar(WEBVIEW_CONTRACT.routes.setup),
      ),
    ),
    // エージェントに頼む入力欄（UI-15）。タイトル行の吹き出しは左パネルの下に、画面の今の対象（カンバンで選んでいる Iteration、
    // 履歴で開いている行。なければ対象なし）で出す。コマンドパレットは開いているパネルの下（パネルが手前になければ左パネルの下）に、対象なしで出す
    vscode.commands.registerCommand("deguboard.ask", () => void askFromPalette()),
    vscode.commands.registerCommand("deguboard.askInSidebar", () => void askCurrentInSidebar()),
    // 左パネルのボード・バックログ・履歴のチケットの行と Iteration・Epic の見出しの右クリック
    // （package.json の webview/context。引数は行・見出しの data-vscode-context）
    vscode.commands.registerCommand(MENU_COMMANDS.open, (arg: unknown) =>
      withMenuItem(arg, (folder, item) =>
        // サイドバーのリンクと同じく、フォーカスはサイドバーに残す
        openPanel(context, folder, {
          column: vscode.ViewColumn.Beside,
          route: item.route,
          preserveFocus: true,
        }),
      ),
    ),
    vscode.commands.registerCommand(MENU_COMMANDS.copyId, (arg: unknown) =>
      withMenuItem(arg, async (_folder, item) => {
        await copyToClipboard(item.id);
        void vscode.window.setStatusBarMessage(`deguboard: ${t("Copied {0}", item.id)}`, 3000);
      }),
    ),
    // コマンドパレットの「dg コマンドを入れる」「外す」。同梱の dg を ~/.local/bin/dg に張り、外す（launcher.ts）
    vscode.commands.registerCommand("deguboard.installDg", () => void installDgCommand(context)),
    vscode.commands.registerCommand("deguboard.uninstallDg", () => void uninstallDgCommand()),
    // 「このリポジトリからアンインストール」。消さずに、導入のチェックリストを「アンインストール」の節を開いて出す（確かめて実行するのは画面）。
    // ルートに時刻を付け、実行のたびに違うハッシュにする（節を閉じた後でも、もう一度実行すれば開き直す）
    vscode.commands.registerCommand(
      "deguboard.uninstall",
      () => void showInSidebar(uninstallRouteOf(Date.now())),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) forgetFolder(folder);
      void refreshApprovals();
    }),
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
      const route = detailRouteOf(id);
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
        const hit = findIdsInText(line).find(
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
            link.tooltip = t("Open details of {0}", f.id);
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
  extensionContext = context;
  void refreshApprovals();
  void writeLauncher(context);
  void refreshSkills(context);
}

/**
 * 入れてある dg の Skill のうち、この拡張より古い版の dg が書いたものを core の refreshInstalledSkills で更新し、更新したものと手を加えたので残したものを通知する（文は skills.ts）。
 * 新しい版の dg（PATH の dg など）が書いた Skill は戻さない。束ねた拡張では core が自分の版を読めないので、ビルドで埋めた版を渡す。
 * 更新の後で、足りない同梱の Skill を案内する（suggestMissingSkills）。Skill の組み立て（guide を読む）は起動時に 1 回にし、更新・案内・Install で使い回す。
 * 確かめられなくても画面は動くので、知らせずに記録だけ残す
 */
async function refreshSkills(context: vscode.ExtensionContext): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let skills: SkillFile[];
  try {
    skills = await buildSkills(__CORE_VERSION__);
  } catch (error) {
    console.warn("deguboard: could not build the dg Skills", error);
    return;
  }
  try {
    const refreshed = await refreshInstalledSkills({ folders, env: process.env, skills });
    for (const notice of skillRefreshNotices(refreshed)) {
      const show =
        notice.level === "warning"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
      void show(`deguboard: ${notice.text}`);
    }
  } catch (error) {
    console.warn("deguboard: could not refresh the dg Skills", error);
  }
  await suggestMissingSkills(context, folders, skills);
}

/**
 * dg の Skill を入れてある置き場所ごとに、足りない同梱の Skill を info 通知で案内する（core の findMissingSkills、文は skills.ts）。
 * Install は core の installMissingSkills で足りない Skill だけを書き（入れてある Skill は渡さないので変わらない）、
 * リポジトリの置き場所では書いた Skill の無視の行を .gitignore に足す（dg skill install と同じ）。
 * Don't show again はその名前を globalState に覚えて以後案内しない。確かめられなくても画面は動くので、知らせずに記録だけ残す
 */
async function suggestMissingSkills(
  context: vscode.ExtensionContext,
  folders: readonly string[],
  skills: readonly SkillFile[],
): Promise<void> {
  try {
    const found = await findMissingSkills({ folders, env: process.env, skills });
    const dismissed = dismissedSkillsOf(context.globalState.get(DISMISSED_SKILLS_KEY));
    for (const notice of missingSkillNotices(found, dismissed))
      void askToInstallSkills(context, notice, skills);
  } catch (error) {
    console.warn("deguboard: could not check the missing dg Skills", error);
  }
}

async function askToInstallSkills(
  context: vscode.ExtensionContext,
  notice: MissingSkillNotice,
  skills: readonly SkillFile[],
): Promise<void> {
  const install = t("Install");
  const never = t("Don't show again");
  const picked = await vscode.window.showInformationMessage(
    `deguboard: ${notice.text}`,
    install,
    never,
  );
  const action = missingSkillAction(
    picked,
    { install, never },
    notice,
    context.globalState.get(DISMISSED_SKILLS_KEY),
  );
  if (action.kind === "dismiss") {
    await context.globalState.update(DISMISSED_SKILLS_KEY, action.dismissed);
    return;
  }
  if (action.kind !== "install") return;
  try {
    const result = await installMissingSkills(notice, { names: action.names, skills });
    if (result.written.length > 0)
      void vscode.window.showInformationMessage(
        `deguboard: ${t("Installed the dg Skills in {0}: {1}", notice.dir, result.written.join(", "))}`,
      );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `deguboard: ${t("Could not install the dg Skills in {0}: {1}", notice.dir, error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/**
 * 同梱した dg を外から呼べるよう、起動ファイルと current を書く（launcher.ts）。node は拡張ホストの実行ファイルで、
 * デスクトップでは VS Code 本体、リモートでは server の node。書けなくても画面は動くので、知らせずに記録だけ残す
 */
async function writeLauncher(context: vscode.ExtensionContext): Promise<void> {
  try {
    launcherResult = await installLauncher(launcherCurrent(context));
  } catch (error) {
    console.warn("deguboard: could not write the dg launcher", error);
  }
}

/** 起動ファイルの current に書く、この拡張の版・node・同梱の dg.mjs */
function launcherCurrent(context: vscode.ExtensionContext): Current {
  return {
    version: String((context.extension.packageJSON as { version?: unknown }).version ?? ""),
    node: process.execPath,
    dg: vscode.Uri.joinPath(context.extensionUri, "dist", "cli", "dg.mjs").fsPath,
  };
}

/**
 * 「dg コマンドを入れる」。起動ファイルを書き（まだなければ）、~/.local/bin/dg をそこへ張る。
 * ほかの dg（mise run dg:link のリンクや通常のファイル）は上書きせず、張り先を示して止まる。
 * quiet はチェックリストのボタンから：結果（張った・塞がっている・PATH にない）は確かめ直した項目がその場に出すので、通知は失敗だけにする
 */
async function installDgCommand(
  context: vscode.ExtensionContext,
  options: { quiet?: boolean } = {},
): Promise<void> {
  try {
    if ((await installLauncher(launcherCurrent(context))) === "unsupported") {
      void vscode.window.showWarningMessage(
        `deguboard: ${t("Installing the dg command is not supported on this platform.")}`,
      );
      return;
    }
    const outcome = await linkDg();
    if (options.quiet) return;
    const link = linkPathOf();
    if (outcome.kind === "occupied") {
      const text =
        outcome.target === undefined
          ? t(
              "{0} already exists and is not a symbolic link. It was not changed. Check it, remove it if you do not need it, then run this command again.",
              link,
            )
          : t(
              "{0} already exists and points to {1}. It was not changed. Remove it yourself, then run this command again.",
              link,
              outcome.target,
            );
      void vscode.window.showWarningMessage(`deguboard: ${text}`);
      return;
    }
    const text =
      outcome.kind === "linked"
        ? t("dg is linked to {0}.", link)
        : t("dg is already linked to {0}.", link);
    void vscode.window.showInformationMessage(`deguboard: ${text}`);
    if (!onPath(path.dirname(link))) {
      void vscode.window.showInformationMessage(
        `deguboard: ${t("~/.local/bin is not on your PATH. Add this line to your shell profile and open a new terminal: export PATH=$HOME/.local/bin:$PATH")}`,
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `deguboard: ${t("The dg command could not be changed: {0}", error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    postSetup();
  }
}

/** 「dg コマンドを外す」。~/.local/bin/dg が起動ファイルを指すリンクなら外す。起動ファイルは残す（フックが使う） */
async function uninstallDgCommand(): Promise<void> {
  try {
    const outcome = await unlinkDg();
    const link = linkPathOf();
    switch (outcome.kind) {
      case "removed":
        void vscode.window.showInformationMessage(
          `deguboard: ${t("Removed the dg link at {0}. The launcher that the hooks use was kept.", link)}`,
        );
        return;
      case "absent":
        void vscode.window.showInformationMessage(
          `deguboard: ${t("There is no dg link at {0}.", link)}`,
        );
        return;
      case "foreign":
        void vscode.window.showWarningMessage(
          `deguboard: ${
            outcome.target === undefined
              ? t("{0} is not a symbolic link, so it was not removed.", link)
              : t(
                  "{0} points to {1}, not to deguboard, so it was not removed.",
                  link,
                  outcome.target,
                )
          }`,
        );
        return;
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `deguboard: ${t("The dg command could not be changed: {0}", error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    postSetup();
  }
}

export function deactivate(): void {
  autoSetup.cancel();
  for (const panel of panels.values()) panel.dispose();
  panels.clear();
  for (const map of [watchers, initWatchers, setupWatchers]) {
    for (const watcher of map.values()) watcher.dispose();
    map.clear();
  }
  setupViews.clear();
  setupBandDismissed.clear();
  setupBoards.clear();
  clients.clear();
  idIndexes.clear();
  idIndexFailedAt.clear();
}

/**
 * サイドバーのビュー。最初の作業フォルダを対象にし、詳細を押すとエディタ領域のパネルに開く。
 * フォルダを開いていなくても画面を載せる（一覧は読めないので、画面は導入のチェックリストを出し、フォルダの項目に「フォルダを開く」が出る）
 */
async function resolveSidebar(
  context: vscode.ExtensionContext,
  view: vscode.WebviewView,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders[0];
  sidebar = view;
  sidebarFolder = folder;
  view.onDidDispose(() => {
    if (sidebar === view) sidebar = undefined;
  });
  // タイトル行のセットアップのアイコンの点。画面は推奨の帯を出さないと決めている間は確かめないので、まだ確かめていなければ拡張が確かめる
  if (setupViews.has(folderKey(folder))) showSetupAttention();
  // （確かめられなければ点を出さず、画面が確かめたときに出す）
  else void readSetup(folder).catch(() => {});
  if (folder && folders.length > 1) view.description = folder.name;
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
        folder && detailOfRoute(route)
          ? openPanel(context, folder, {
              column: vscode.ViewColumn.Beside,
              route,
              preserveFocus: true,
            })
          : showInSidebar(route),
      show: showInSidebar,
      copy: copyToClipboard,
      terminals: listTerminals,
      sendToTerminal,
      setup: (bandDismissed, board) => readSetup(folder, bandDismissed, board),
      setupAct: (act, board) => setupAct(context, folder, act, board),
      uninstallPreview: (personal) => uninstallPreview(folder, personal),
    },
  });
}

/**
 * 「アンインストール」の節が出す、dg uninstall --dry-run の結果（消すもの・残すもの・止める理由）。何も消さない。
 * 判定は core の uninstall だけが持ち、実行（ターミナルの dg uninstall）のときに dg がもう一度確かめるので、ここの結果が古くても消し過ぎない
 */
async function uninstallPreview(
  folder: vscode.WorkspaceFolder | undefined,
  personal: boolean,
): Promise<UninstallPreview> {
  if (!folder) return { personal, removes: [], keeps: [], blockers: [] };
  const result = await uninstall({
    cwd: folder.uri.fsPath,
    env: process.env,
    actor: "human",
    personal,
    dryRun: true,
  });
  return {
    personal: result.personal,
    removes: result.removes,
    keeps: result.keeps,
    blockers: result.blockers,
  };
}

/** setupViews・setupWatchers の鍵。フォルダを開いていなければ "" */
function folderKey(folder: vscode.WorkspaceFolder | undefined): string {
  return folder?.uri.toString() ?? "";
}

/**
 * 導入のチェックリスト（UI-12）を確かめ直して返す。core の dg setup check（git・Git リポジトリ・ボード・Skill と hooks・.gitignore）に、
 * 拡張でしか確かめられない項目（フォルダ・OS・PATH の dg）を足す（組み立ては setup.ts の buildSetupView）。
 * フォルダがない・OS が対応していないときは core を確かめず、必須を満たすまでは PATH の dg も確かめない。
 * 確かめたついでに、人がターミナルで直したことを拾う見張りを張る（watchSetup）。必須を満たさない間は、データ worktree ができるのを待つ見張りも
 * 張り直す（git init の前は張れないので。watchData → watchInit）。
 * bandDismissed は左パネルが伝える、人が推奨の項目の帯を出さないと決めているか（エディタのパネルは伝えないので、前の値のまま）。
 * board は、人がボードの項目で指定し直したデータの置き場所（null はコードのリモートに戻した）。フォルダごとに持ち（setupBoards）、
 * 送らない画面（エディタのパネル）の確かめ直しにも使って、dg init 前のボードをコードのリモートの代わりにそこで確かめる。
 * 返す結果には確かめた指定を付け、画面が同じ指定を見せる
 */
async function readSetup(
  folder: vscode.WorkspaceFolder | undefined,
  bandDismissed?: boolean,
  sent?: SetupBoardSource | null,
): Promise<SetupView> {
  const key = folderKey(folder);
  if (bandDismissed === true) setupBandDismissed.add(key);
  else if (bandDismissed === false) setupBandDismissed.delete(key);
  const board = heldSetupBoard(setupBoards.get(key), sent);
  if (board) setupBoards.set(key, board);
  else setupBoards.delete(key);
  const cwd = folder?.uri.fsPath;
  const core =
    cwd !== undefined && supportedPlatform(process.platform)
      ? await checkSetup({
          cwd,
          env: process.env,
          dataRemote: board?.dataRemote,
          dataBranch: board?.dataBranch,
        })
      : undefined;
  const view: SetupView = {
    ...buildSetupView({
      folder: cwd,
      platform: process.platform,
      core,
      dg: folder && core?.ready ? await dgCommandFacts(folder) : undefined,
    }),
    board: board ?? null,
  };
  // 確かめている間に別の画面が指定し直したら、古い指定の結果でフォルダの結果を上書きしない（指定し直した画面の確かめが入れる）
  if (setupBoards.get(key) === board) {
    setupViews.set(key, view);
    showSetupAttention();
  }
  if (folder) {
    watchSetup(folder, view);
    if (!view.ready) void watchData(folder, clientFor(folder));
  }
  return view;
}

/**
 * タイトル行のセットアップのアイコンを、左パネルのフォルダで最後に確かめた結果の満たさない項目の数で、点付きのアイコンに差し替える
 * （0 なら元のアイコン）。推奨の帯を出さないと決めた後も、欠けている間は点を残す（UI-12）
 */
function showSetupAttention(): void {
  showAttention(SETUP_ATTENTION, missingSetupCount(setupViews.get(folderKey(sidebarFolder))));
}

/** タイトル行のボタンの点（attention.ts）を件数で付け外しする。package.json の menus が context key で差し替える */
function showAttention(button: AttentionButton, count: number): void {
  void vscode.commands.executeCommand(
    "setContext",
    button.contextKey,
    attentionValue(button, count),
  );
}

/** PATH の dg と ~/.local/bin/dg の今の状態（dg コマンドの項目の事実）。dg --version はフォルダを cwd にして確かめる（理由は resolveDg） */
async function dgCommandFacts(folder: vscode.WorkspaceFolder): Promise<DgCommandFacts> {
  const linkPath = linkPathOf();
  // リンクを見られなくても（権限など）項目は出す。張れるかは押したときに分かる
  const link = await dgLinkOf().catch((): DgLink => ({ kind: "none" }));
  return {
    lookup: await resolveDg(dgCheckCwd(folder.uri)),
    coreVersion: __CORE_VERSION__,
    link,
    linkPath,
    binOnPath: onPath(path.dirname(linkPath)),
  };
}

/**
 * 人がターミナルで直したことを拾う見張りを、フォルダごとに 1 回だけ張る（対象は watch.ts の setupWatchTargets）。
 * 変わったら autoSetup が画面に確かめ直しを頼む。core を確かめなかった（OS が対応していない）ときは、見張る場所が分からないので張らない
 */
function watchSetup(folder: vscode.WorkspaceFolder, view: SetupView): void {
  const key = folderKey(folder);
  const ignoreFile = view.items.find((item) => item.id === "gitignore")?.label;
  if (setupWatchers.has(key) || ignoreFile === undefined) return;
  const fsWatchers = setupWatchTargets(folder.uri.fsPath, linkPathOf(), ignoreFile).map(
    (target) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(target.base), target.pattern),
      );
      watcher.onDidCreate(autoSetup.fire);
      watcher.onDidChange(autoSetup.fire);
      watcher.onDidDelete(autoSetup.fire);
      return watcher;
    },
  );
  setupWatchers.set(key, {
    dispose() {
      for (const watcher of fsWatchers) watcher.dispose();
    },
  });
}

/**
 * 見張り（ファイルの変化・ターミナルの実行の終わり・ウィンドウに戻った）からの確かめ直し。続けて来たら 300ms まとめ、
 * 最後に確かめた結果が自動の確かめ直しに当たるフォルダ（setup.ts の autoRecheck）の画面にだけ頼む
 */
const autoSetup = coalesce(() => {
  for (const [key, view] of setupViews)
    if (autoRecheck(view, setupBandDismissed.has(key))) postSetupTo(key);
}, 300);

/**
 * フォルダ（鍵）のサイドバーとパネルに、導入のチェックリストの確かめ直しを頼む（画面が setup の要求で取り直す）。
 * 帯もチェックリストも出していない画面（一覧を読めているエディタのパネル）は取り直さない（web の store の onSetupEvent）
 */
function postSetupTo(key: string): void {
  const event: WebviewEvent = { kind: "event", name: "setup" };
  if (sidebar && folderKey(sidebarFolder) === key) void sidebar.webview.postMessage(event);
  void panels.get(key)?.webview.postMessage(event);
}

/** 画面を出しているすべてのフォルダに確かめ直しを頼む（dg コマンドを入れた・外した後。PATH の dg はフォルダによらない） */
function postSetup(): void {
  for (const key of setupViews.keys()) postSetupTo(key);
}

/**
 * チェックリストのボタンの操作（UI-12）。フォルダを開く・dg コマンドを入れる・同期する・拡張の画面を開くほかは、deguboard のターミナルでコマンドを実行する。
 * 流すコマンドは setup.ts の setupCommands が決める（dg init には、人がボードの項目で指定したデータの置き場所 board を渡す。
 * 画面が送らなければ、フォルダごとに持つ指定 setupBoards を渡す）。
 * sync（「アンインストール」の節の止める理由を片付ける）は終わるまで待って答え、画面が消すものを取り直す。
 * showExtension は拡張の画面を開くだけで、拡張は消さない（ほかのリポジトリでも使い、消すのは人が最後にする）
 */
async function setupAct(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
  act: SetupAction,
  board?: SetupBoardSource,
): Promise<void> {
  if (act === "openFolder") {
    await vscode.commands.executeCommand("workbench.action.files.openFolder");
    return;
  }
  if (act === "installDg") {
    await installDgCommand(context, { quiet: true });
    return;
  }
  if (act === "showExtension") {
    await vscode.commands.executeCommand("extension.open", context.extension.id);
    return;
  }
  if (!folder) return;
  if (act === "sync") {
    await syncFolder(undefined, folder);
    return;
  }
  const key = folderKey(folder);
  const commands = setupCommands(act, setupViews.get(key), board ?? setupBoards.get(key));
  if (commands.length > 0) await runInSetupTerminal(context, folder, commands);
}

/**
 * チェックリストのボタンのコマンドを、deguboard のターミナルで実行する（UI-12）。同梱の dg の起動ファイルを書き（まだなければ）、
 * フォルダへ移ってから commands を続けて入れ、Enter で実行する（1 行の組み立ては terminals.ts の setupCommandLine。dg は起動ファイルの絶対パスで呼び、PATH の dg は使わない）。
 * 開いたターミナルが残っていても、前の実行が終わっていれば送る（失敗した後のやり直し）。実行中は送らずに見せるだけにする。
 * エージェントは起動せず、ターミナルは人が押したときだけ開く。終わると見張り（watchInit・autoSetup）が画面に確かめ直させる
 */
async function runInSetupTerminal(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  commands: readonly string[],
): Promise<void> {
  try {
    if ((await installLauncher(launcherCurrent(context))) === "unsupported") {
      void vscode.window.showWarningMessage(
        `deguboard: ${t("Running setup commands from this view is not supported on this platform.")}`,
      );
      return;
    }
    // 判定から送るまでは await を挟まない。押されるたびに判定し直すので、二重押しで同じ 1 行が 2 回送られない
    const plan = startTerminalPlan(vscode.window.terminals, startRuns);
    if (plan.kind === "show") {
      plan.terminal.show();
      return;
    }
    const terminal =
      plan.terminal ??
      vscode.window.createTerminal({
        name: START_TERMINAL_NAME,
        cwd: folder.uri.fsPath,
      });
    terminal.show();
    startRuns.add(terminal);
    terminal.sendText(setupCommandLine(launcherFileOf(), folder.uri.fsPath, commands), true);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `deguboard: ${t("Could not run the setup command: {0}", error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/**
 * 一覧の画面（カンバン・バックログ・履歴）をサイドバーのビューに出してフォーカスを移す。パネルの中身は変えない。
 * サイドバーがまだ描かれていなければ、初期ルートとして覚えてからビューを開く（resolveSidebar が使う）
 */
async function showInSidebar(route: string): Promise<void> {
  await deliverToSidebar(sidebarDelivery(sidebar !== undefined, "navigate", route), rememberRoute);
}

// ターミナルに振る ID。vscode.Terminal には安定した ID がないので、見たものから振る（閉じるまで変わらない）
const terminalIds = new WeakMap<vscode.Terminal, number>();
let nextTerminalId = 1;
function terminalId(terminal: vscode.Terminal): number {
  let id = terminalIds.get(terminal);
  if (id === undefined) terminalIds.set(terminal, (id = nextTerminalId++));
  return id;
}

/** 開いているターミナルの一覧（頼む小窓の送り先。UI-15）。閉じたばかりのもの（closing）は除く */
function listTerminals(closing?: vscode.Terminal): TerminalChoice[] {
  return describeTerminals(
    vscode.window.terminals
      .filter((t) => t !== closing)
      .map((t) => ({
        id: terminalId(t),
        name: t.name,
        active: t === vscode.window.activeTerminal,
      })),
  );
}

/**
 * 開いているターミナルの入力に text を入れる。Enter は押さない（第 2 引数 false）。
 * ターミナルは起動しない（createTerminal を呼ばない。EX-1）。選んだターミナルが閉じていたら断る
 */
async function sendToTerminal(id: number, text: string): Promise<TerminalSendResult> {
  const terminal = vscode.window.terminals.find((t) => terminalIds.get(t) === id);
  if (!terminal) throw new Error(t("The selected terminal has been closed"));
  const input = terminalInput(text);
  if (input.kind === "line") {
    terminal.show(true);
    terminal.sendText(input.text, false);
    return { clipboardKept: false };
  }
  // 複数行は VS Code の貼り付けに任せる（対応しない入力では VS Code が警告を出す）。使うのは既にあるコマンドだけで、起動はしない。
  // 貼り付けは今アクティブなターミナルに入るので、show() で選んだものを前に出してから呼ぶ。
  // show の後に writeText の一往復を待ってから貼るので、その間にメインスレッドが送り先を active にしている（writeText を show の前に置くと待ちがなくなる）。
  // 利用者のクリップボードを借りるので、貼った後に元へ戻す（paste は警告の小窓を出す前にクリップボードを読むので、await の後に戻して安全）
  let previous: string | undefined;
  try {
    previous = await vscode.env.clipboard.readText();
  } catch {
    previous = undefined;
  }
  terminal.show();
  await vscode.env.clipboard.writeText(input.text);
  await vscode.commands.executeCommand("workbench.action.terminal.paste");
  if (previous === undefined) return { clipboardKept: true };
  try {
    await vscode.env.clipboard.writeText(previous);
    return { clipboardKept: false };
  } catch {
    return { clipboardKept: true };
  }
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

/** 開いているターミナルの一覧を、描かれているサイドバーとすべてのパネルに知らせる。closing は閉じたばかりのターミナル */
function broadcastTerminals(closing?: vscode.Terminal): void {
  const event: WebviewEvent = {
    kind: "event",
    name: "terminals",
    terminals: listTerminals(closing),
  };
  void sidebar?.webview.postMessage(event);
  for (const panel of panels.values()) void panel.webview.postMessage(event);
}

/** フォルダのサイドバーとパネルの両方に通知を送る */
function broadcast(folder: vscode.WorkspaceFolder, event: WebviewEvent): void {
  if (sidebar && sidebarFolder === folder) void sidebar.webview.postMessage(event);
  void panels.get(folder.uri.toString())?.webview.postMessage(event);
}

/**
 * dg sync と同じ同期をサイドバーのフォルダに対して行い、終わったら画面を読み直させる。
 * リモートがなければ同期は要らないので、知らせて読み直すだけにする。警告と失敗は VS Code の通知に出す。
 * resolve があれば、競合の通知のボタンで選ばれた側で dg sync --resolve を 1 回呼ぶ（SY-4）。folder は押したときの対象を渡す
 */
async function syncFolder(resolve?: ResolveSide, target?: vscode.WorkspaceFolder): Promise<void> {
  const folder = target ?? sidebarFolder ?? (vscode.workspace.workspaceFolders ?? [])[0];
  if (!folder) {
    void vscode.window.showErrorMessage(
      `deguboard: ${t("Open a folder (the target repository) to use deguboard")}`,
    );
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
        `deguboard: ${t("No remote, so there is nothing to sync. Reloaded.")}`,
      );
      return;
    }
    const result = await vscode.window.withProgress(
      { location: { viewId: VIEW_ID }, title: t("Syncing") },
      () => client.run("sync", resolve ? { resolve } : undefined),
    );
    notifySync(folder, result.warnings, result.data, resolve);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `deguboard: ${t("Cannot sync: {0}", toCommandFailure(error).message)}`,
    );
  } finally {
    syncing = false;
    broadcast(folder, { kind: "event", name: "reload" });
  }
}

/**
 * sync の結果を通知にする。競合で止まり、ぶつかったフィールドがあれば警告にボタンを付ける（押すと syncFolder が
 * その側で --resolve を 1 回呼ぶ）。閉じただけなら何もせず、次の同期でまた出る。--resolve のときは採った値と捨てた値を知らせる
 */
function notifySync(
  folder: vscode.WorkspaceFolder,
  warnings: string[],
  data: unknown,
  resolve: ResolveSide | undefined,
): void {
  const notice = syncNotice(warnings, data, resolve);
  if (notice.warning) {
    const { message, choices } = notice.warning;
    if (choices.length === 0) {
      void vscode.window.showWarningMessage(message);
    } else {
      void vscode.window
        .showWarningMessage(message, ...choices.map((c) => c.label))
        .then((picked) => {
          const side = pickedSide(choices, picked);
          if (side) void syncFolder(side, folder);
        });
    }
  }
  if (notice.info) void vscode.window.showInformationMessage(notice.info);
}

/** 右クリックのメニューの引数から対象（チケット・Iteration・Epic）を取り、サイドバーのフォルダに対して動かす。取れなければ何もしない */
async function withMenuItem(
  arg: unknown,
  fn: (folder: vscode.WorkspaceFolder, item: MenuItem) => Promise<void>,
): Promise<void> {
  const item = menuItemOf(arg);
  const folder = sidebarFolder;
  if (!item || !folder) return;
  await fn(folder, item);
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
    retitle(existing, folder, route);
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
  retitle(panel, folder, route);
  await attach(context, panel.webview, folder, {
    surface: "panel",
    route,
    actions: {
      open: (route) =>
        detailOfRoute(route)
          ? openPanel(context, folder, { column: options.column, route })
          : showInSidebar(route),
      show: showInSidebar,
      copy: copyToClipboard,
      terminals: listTerminals,
      sendToTerminal,
      setup: (bandDismissed, board) => readSetup(folder, bandDismissed, board),
      setupAct: (act, board) => setupAct(context, folder, act, board),
      uninstallPreview: (personal) => uninstallPreview(folder, personal),
    },
  });
}

/** パネルの題。詳細を出しているときは ID（t12・s3・e2・p5）だけにする。題や名前まで付けるとタブが長くなるので（ヘッダーを出さないので、ID でタブを見分ける。UI-12） */
function retitle(panel: vscode.WebviewPanel, folder: vscode.WorkspaceFolder, route: string): void {
  panel.title = detailOfRoute(route)?.id ?? panelTitle(folder);
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

/** フォルダを開いていないときの CommandClient。どのコマンドも断る（画面は一覧を読めないので、導入のチェックリストを出す） */
const NO_FOLDER_CLIENT: CommandClient = {
  run: () => Promise.reject(new Error(t("Open a folder (the target repository) to use deguboard"))),
  status: () =>
    Promise.reject(new Error(t("Open a folder (the target repository) to use deguboard"))),
};

/** Webview に web を載せ、要求をフォルダの CommandClient に通す。サイドバーとパネルで共通。フォルダがなければ（サイドバーだけ）コマンドは断る */
async function attach(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  folder: vscode.WorkspaceFolder | undefined,
  options: AttachOptions,
): Promise<void> {
  const webRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "web");
  webview.options = { enableScripts: true, localResourceRoots: [webRoot] };
  const client = folder ? clientFor(folder) : NO_FOLDER_CLIENT;
  // 初期化前のリポジトリで張れなかった見張りを、画面を開くたびに張り直す（張れていれば何もしない）
  if (folder) void watchData(folder, client);
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
    language: vscode.env.language,
  });
}

/** そのフォルダが今も開いているか。非同期の待ちの後に、外されたフォルダの見張りを張らないために確かめる */
function isOpenFolder(folder: vscode.WorkspaceFolder): boolean {
  const key = folder.uri.toString();
  return (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.toString() === key);
}

/** 外したフォルダの見張り・client・索引を捨てる（残すと外したフォルダの変化で読み直し続ける） */
function forgetFolder(folder: vscode.WorkspaceFolder): void {
  const key = folder.uri.toString();
  for (const map of [watchers, initWatchers, setupWatchers]) {
    map.get(key)?.dispose();
    map.delete(key);
  }
  setupViews.delete(key);
  showSetupAttention();
  setupBandDismissed.delete(key);
  setupBoards.delete(key);
  watchStarting.delete(key);
  panels.get(key)?.dispose();
  panels.delete(key);
  clients.delete(key);
  idIndexes.delete(key);
  idIndexFailedAt.delete(key);
  approvalSeen.delete(key);
}

function clientFor(folder: vscode.WorkspaceFolder): CommandClient {
  const key = folder.uri.toString();
  let client = clients.get(key);
  if (!client) {
    // 拡張ホストに環境変数が届かない起動（GUI など）では、core が git config の deguboard.user から決める。
    // 同期は同梱の dg を呼ぶマージドライバを登録する（拡張だけで使っても、近いフィールドの変更で同期が止まらないように。t759）
    client = createLocalClient({
      cwd: folder.uri.fsPath,
      ...pickUser(undefined, process.env["DEGUBOARD_USER"]),
      mergeDriver:
        extensionContext && mergeDriverOf(launcherCurrent(extensionContext), launcherResult),
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
    // 初期化前のリポジトリなど。データの見張りは張れないので、データ worktree ができるのを待つ（できたら張り直す）。
    // 張れなかった理由が初期化前でなくても、待つだけで害はない
    void watchInit(folder, client);
    return;
  } finally {
    watchStarting.delete(key);
  }
  // 問い合わせの間にフォルダが外されたなら張らない（外したフォルダの見張りを残さない）
  if (!isOpenFolder(folder)) return;
  const pending = coalesce(() => {
    broadcast(folder, { kind: "event", name: "reload" });
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
  // 初期化前から待っていた場合：待つのをやめ、いつもの画面に変えさせる（開き直さなくてよい）
  if (initWatchers.has(key)) {
    initWatchers.get(key)?.dispose();
    initWatchers.delete(key);
    pending.fire();
  }
}

/**
 * dg init 前のフォルダで、データ worktree（.git/deguboard/）ができるのを見張る。できたら watchData を呼び直す
 * （張れたら watchData が見張りを外し、画面の読み直しを頼む）。覚えた ID 索引の失敗（30 秒）も忘れさせる。
 * git のリポジトリでないフォルダでは何も張らない。フォルダごとに 1 回だけ張る
 */
async function watchInit(folder: vscode.WorkspaceFolder, client: CommandClient): Promise<void> {
  const key = folder.uri.toString();
  if (initWatchers.has(key)) return;
  initWatchers.set(key, { dispose() {} }); // 張っている間に重ねて張らない
  const commonDir = await commonDirOf(folder.uri.fsPath);
  if (!commonDir || !isOpenFolder(folder)) {
    initWatchers.delete(key);
    return;
  }
  // 待っている間に外された（watchData が先に張れた）なら張らない
  if (!initWatchers.has(key)) return;
  const target = initWatchTarget(commonDir);
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(target.base), target.pattern),
  );
  const pending = coalesce(() => {
    forgetIdIndexFailure(folder);
    void watchData(folder, client);
  }, 200);
  watcher.onDidCreate(pending.fire);
  watcher.onDidChange(pending.fire);
  initWatchers.set(key, {
    dispose() {
      pending.cancel();
      watcher.dispose();
    },
  });
}

/**
 * 最初の作業フォルダの承認待ち（承認待ちの Plan と review のチケット。UI-12）を数え、サイドバーのタイトルに件数を出す。
 * 前に見た集合になかったものが現れたら、config.yaml の notify.approvals が true のとき（既定）通知し、
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
    const tickets = (
      await client.run<{ id: string; title?: string }[]>("ticket.list", { status: ["review"] })
    ).data;
    if (generation !== approvalGeneration) return;
    const items = approvalItems(plans, tickets);
    const key = folder.uri.toString();
    const arrived = newApprovals(approvalSeen.get(key), items);
    approvalSeen.set(key, new Set(items.map((i) => i.id)));
    approvalCount = items.length;
    if (sidebar) sidebar.title = viewTitle(approvalCount);
    if (arrived.length === 0) return;
    const config = (await client.run<{ notify?: { approvals?: boolean } }>("config.show")).data;
    if (config.notify?.approvals === false) return;
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
  const open = t("Open");
  const choice = await vscode.window.showInformationMessage(approvalMessage(arrived), open);
  if (choice !== open) return;
  let item: ApprovalItem | undefined = arrived[0];
  if (arrived.length > 1) {
    const picked = await vscode.window.showQuickPick(
      arrived.map((i) => ({
        label: i.id,
        description: i.title ?? (i.kind === "plan" ? "Plan" : ""),
        item: i,
      })),
      { placeHolder: t("Select an item awaiting approval or review") },
    );
    item = picked?.item;
  }
  const route = item && approvalRoute(item);
  if (route) await openPanel(context, folder, { column: vscode.ViewColumn.Beside, route });
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
    void vscode.window.showInformationMessage(`deguboard: ${t("Cannot read the ticket data")}`);
    return;
  }
  const items = gotoItems(found.index).map((i) => ({
    label: i.label,
    description: i.description,
    detail: i.detail,
    id: i.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: t("Filter by ID or part of the title (e.g. t12, login)"),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const folder = (vscode.workspace.workspaceFolders ?? []).find(
    (f) => f.uri.toString() === found.folder,
  );
  const route = detailRouteOf(picked.id);
  if (!folder || !route) return;
  await openPanel(context, folder, { column: vscode.ViewColumn.Beside, route });
}

/** 覚えた「読めなかった」を忘れる。データの見張り・同期・利用者が「チケットへ移動」を起動したとき、次の要求で読み直させる */
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

function panelTitle(folder: vscode.WorkspaceFolder): string {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    ? `deguboard: ${folder.name}`
    : "deguboard";
}
