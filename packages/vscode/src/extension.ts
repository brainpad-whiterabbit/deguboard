// 拡張ホストの入口。Webview に web を載せ、postMessage の要求を core のプロセス内 CommandClient に通す（ADR-006・ADR-007）。
// サーバーは起動しない。dg は同梱せず、PATH の dg を案内する（UI-11）

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLocalClient, type CommandClient } from "@deguboard/core";
import * as vscode from "vscode";
import { dgAdvice, resolveDg } from "./dg.js";
import { handleRequest, isWebviewRequest, renderWebviewHtml } from "./webview.js";

const VIEW_TYPE = "deguboard";

/** 開いている画面。作業フォルダごとに 1 つ */
const panels = new Map<string, vscode.WebviewPanel>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("deguboard.open", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      await openPanel(context, folder);
    }),
  );
  void adviseAboutDg();
}

export function deactivate(): void {
  for (const panel of panels.values()) panel.dispose();
  panels.clear();
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("deguboard: フォルダを開いてから使う（対象のリポジトリ）");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "deguboard を開くリポジトリ" });
}

async function openPanel(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const key = folder.uri.toString();
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const webRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "web");
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    folders(folder),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      // 隠しても画面の状態（選んだページや編集中の本文）を失わない
      retainContextWhenHidden: true,
      localResourceRoots: [webRoot],
    },
  );
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));

  const client: CommandClient = createLocalClient({ cwd: folder.uri.fsPath });
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (!isWebviewRequest(message)) return;
    void handleRequest(client, message).then((response) => panel.webview.postMessage(response));
  });

  const indexHtml = await readFile(vscode.Uri.joinPath(webRoot, "index.html").fsPath, "utf8");
  panel.webview.html = renderWebviewHtml(indexHtml, {
    asset: (p) => panel.webview.asWebviewUri(vscode.Uri.joinPath(webRoot, p)).toString(),
    cspSource: panel.webview.cspSource,
    nonce: randomBytes(16).toString("hex"),
  });
}

function folders(folder: vscode.WorkspaceFolder): string {
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
