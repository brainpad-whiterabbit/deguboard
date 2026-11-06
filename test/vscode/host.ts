// VS Code の実機（拡張開発ホスト）を起動して操作する部品（t439）。sidebar.vscode.ts から使う。
// - VS Code 本体は @vscode/test-electron がリポジトリ直下の .vscode-test/ に落とす（git と VSIX には入れない）
// - 画面がない環境（SSH 先・Claude Code の中）では Xvfb を起動して DISPLAY にする。DISPLAY が既にあればそれを使う
// - 起動は Playwright の _electron。Claude Code（VS Code の拡張ホストの子）の環境変数 ELECTRON_RUN_AS_NODE が残っていると
//   Electron が Node として起動して画面が出ないので、ELECTRON_*・VSCODE_*・NODE_OPTIONS を外して渡す（cleanEnv）
// - Webview の CSP 違反（Chromium が Console の error に出す）と捕まえていない例外（pageerror）を集め、あれば検査を落とす（WebviewWatch）
// VS Code の API に触れない純粋な部分（cleanEnv・isCspViolation・pickDisplay）は host.test.ts が確かめる

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron";
import { _electron, type ElectronApplication, type FrameLocator, type Page } from "playwright-core";

export const ROOT = path.resolve(import.meta.dirname, "../..");
/** VS Code 本体の置き場。.gitignore に入れ、packages/vscode の外なので VSIX にも入らない */
export const VSCODE_CACHE = path.join(ROOT, ".vscode-test");
/** スクリーンショットの出し先（.gitignore に入れる）。PR に載せるときはここから pr-screenshots に写す */
export const SCREENSHOT_DIR = path.join(ROOT, "test/vscode/screenshots");
const EXTENSION_DIR = path.join(ROOT, "packages/vscode");

/** VS Code 本体の版。stable は最新の安定版（.vscode-test/ に落ちていれば使い回す） */
const VSCODE_VERSION = "stable";

/**
 * 起動する Electron に渡す環境変数。Claude Code や VS Code の統合ターミナルから引き継ぐ、起動の仕方を変える変数を外す：
 * ELECTRON_RUN_AS_NODE（Electron を Node として起動する。画面が出ない）、ほかの ELECTRON_*、
 * VSCODE_*（親の VS Code の IPC・言語・作業ディレクトリ。子の VS Code が親の設定を拾う）、NODE_OPTIONS（Electron の Node にも効く）。
 * DISPLAY は渡された値で上書きする
 */
export function cleanEnv(
  env: NodeJS.ProcessEnv,
  display: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(ELECTRON_|VSCODE_)/.test(key) || key === "NODE_OPTIONS") continue;
    out[key] = value;
  }
  return { ...out, ...extra, DISPLAY: display };
}

/**
 * Chromium が CSP 違反を Console に出すときの文か。script・style・img・font・connect などの拒否がすべてこの句を含む
 * （古い版は "Refused to apply inline style because it violates ..."、新しい版は "Applying inline style violates ..."）
 */
export function isCspViolation(text: string): boolean {
  return /violates the following Content Security Policy directive/.test(text);
}

/** 使っていない X のディスプレイ番号を選ぶ（/tmp/.X<n>-lock があるものは使用中）。99 から探す */
export function pickDisplay(locks: readonly string[], from = 99): number {
  const used = new Set(
    locks.map((name) => /^\.X(\d+)-lock$/.exec(name)?.[1]).filter((n) => n !== undefined),
  );
  let n = from;
  while (used.has(String(n))) n++;
  return n;
}

export interface Display {
  /** DISPLAY の値（:99 など） */
  name: string;
  close(): Promise<void>;
}

/**
 * 画面を用意する。DISPLAY があればそのまま使い、なければ Xvfb を起動する（1280x800）。
 * Xvfb がなければ、入れ方を添えて失敗する
 */
export async function ensureDisplay(): Promise<Display> {
  const existing = process.env["DISPLAY"];
  if (existing) return { name: existing, close: async () => {} };
  const locks = await readdir("/tmp").catch(() => [] as string[]);
  const number = pickDisplay(locks);
  const name = `:${number}`;
  const child = spawn("Xvfb", [name, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const failed = new Promise<never>((_, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Xvfb がない。画面のない環境では Xvfb を入れる（Debian/Ubuntu: apt install xvfb）か、DISPLAY を設定して実行する"
            : `Xvfb を起動できない: ${error.message}`,
        ),
      ),
    );
    child.on("exit", (code) =>
      reject(new Error(`Xvfb が終了した（code ${code}）: ${stderr.trim()}`)),
    );
  });
  // X のソケットができるまで待つ
  const socket = `/tmp/.X11-unix/X${number}`;
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      if (
        await access(socket).then(
          () => true,
          () => false,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Xvfb のソケットができない");
  })();
  await Promise.race([ready, failed]);
  return {
    name,
    close: () => stop(child),
  };
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  });
}

/** VS Code 本体を用意して実行ファイルのパスを返す。.vscode-test/ にあれば落とさない */
export async function ensureVSCode(): Promise<string> {
  return downloadAndUnzipVSCode({
    version: VSCODE_VERSION,
    cachePath: VSCODE_CACHE,
    reporter: new SilentReporter(),
  });
}

export type Theme = "light" | "dark";
/** テーマ名。VS Code の既定（Dark Modern）と、その明るい版 */
const THEME_NAMES: Record<Theme, string> = {
  light: "Default Light Modern",
  dark: "Default Dark Modern",
};

/** 集めた Webview（とワークベンチ）の問題。検査の最後に空であることを確かめる */
export interface WebviewWatch {
  /** CSP 違反の文（Console の error） */
  cspViolations: string[];
  /** 捕まえていない例外（pageerror）の文 */
  errors: string[];
  /** CSP 違反と例外以外の Console の error（調べるときの手がかり。検査では落とさない） */
  consoleErrors: string[];
}

export interface Host {
  app: ElectronApplication;
  page: Page;
  watch: WebviewWatch;
  /** ユーザーデータの場所。settings.json を書き換えてテーマを変える */
  userDataDir: string;
  /** Activity Bar の deguboard を押してサイドバーのビューを出し、その Webview の中（#active-frame）を返す */
  openSidebar(): Promise<FrameLocator>;
  /** エディタ領域のパネルの Webview の中を返す（パネルが開いているとき） */
  panelFrame(): FrameLocator;
  /** 配色のテーマを切り替え、ワークベンチに反映されるまで待つ */
  setTheme(theme: Theme): Promise<void>;
  /** ウィンドウ全体とサイドバーの部分のスクリーンショットを SCREENSHOT_DIR/<name>-<theme>.png に出し、パスを返す */
  screenshot(name: string, theme: Theme): Promise<{ window: string; sidebar: string }>;
  close(): Promise<void>;
}

/**
 * 拡張開発ホストを folder（対象のリポジトリ）で起動する。
 * ユーザーデータと拡張の置き場は一時ディレクトリにし、手元の VS Code の設定や拡張の影響を受けないようにする
 */
export async function launchHost(folder: string, display: Display): Promise<Host> {
  const executablePath = await ensureVSCode();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "deguboard-vscode-"));
  const userDataDir = path.join(tmp, "user-data");
  const extensionsDir = path.join(tmp, "extensions");
  await mkdir(path.join(userDataDir, "User"), { recursive: true });
  await mkdir(extensionsDir, { recursive: true });
  await writeSettings(userDataDir, "dark");
  const watch: WebviewWatch = { cspViolations: [], errors: [], consoleErrors: [] };
  const app = await _electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${EXTENSION_DIR}`,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      "--new-window",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      "--disable-telemetry",
      "--disable-updates",
      "--disable-crash-reporter",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      folder,
    ],
    env: cleanEnv(process.env, display.name, { DEGUBOARD_USER: "vscode-test" }),
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (isCspViolation(text)) watch.cspViolations.push(text);
    else watch.consoleErrors.push(text);
  });
  page.on("pageerror", (error) => watch.errors.push(error.message));
  await page.locator(".monaco-workbench").waitFor({ timeout: 120_000 });

  // Webview の iframe はビューの中ではなくワークベンチ直下の層に置かれ、ビューの位置に重ねて表示される。
  // src の purpose=webviewView がサイドバーのビュー、purpose のないものがエディタ領域のパネル。
  // その中の #active-frame が拡張の HTML（読み込み中は pending-frame で、読み終わると active-frame に変わる）
  const webviewFrame = (outer: string): FrameLocator =>
    page.locator(outer).contentFrame().locator("#active-frame").contentFrame();
  const sidebarFrame = () => webviewFrame('iframe.webview.ready[src*="purpose=webviewView"]');
  const panelFrame = () => webviewFrame('iframe.webview.ready:not([src*="purpose="])');

  const host: Host = {
    app,
    page,
    watch,
    userDataDir,
    async openSidebar() {
      // 項目の名前は <a class="action-label"> の aria-label に付く（<li> の aria-label は空）
      await page
        .locator('.activitybar .action-label[aria-label="deguboard"]')
        .click({ timeout: 60_000 });
      // Webview の中のアプリが描くまで待つ（nav は全画面に出る）
      await sidebarFrame().locator("nav").waitFor({ timeout: 60_000 });
      return sidebarFrame();
    },
    panelFrame,
    async setTheme(theme) {
      await writeSettings(userDataDir, theme);
      // VS Code が settings.json の変更を拾い、ワークベンチの class（vs・vs-dark）が変わるまで待つ
      await page
        .locator(theme === "dark" ? ".monaco-workbench.vs-dark" : ".monaco-workbench.vs")
        .waitFor({ timeout: 30_000 });
      // Webview の色（--vscode-*）が入れ替わるまで少し待つ
      await page.waitForTimeout(500);
    },
    async screenshot(name, theme) {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      const window = path.join(SCREENSHOT_DIR, `${name}-${theme}.png`);
      const sidebar = path.join(SCREENSHOT_DIR, `${name}-sidebar-${theme}.png`);
      await page.screenshot({ path: window });
      await page.locator(".part.sidebar").screenshot({ path: sidebar });
      return { window, sidebar };
    },
    async close() {
      await app.close().catch(() => {});
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return host;
}

/** ユーザー設定。テーマと、検査の邪魔になる通知・案内を止める */
async function writeSettings(userDataDir: string, theme: Theme): Promise<void> {
  const settings = {
    "workbench.colorTheme": THEME_NAMES[theme],
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "telemetry.telemetryLevel": "off",
    "security.workspace.trust.enabled": false,
    "git.openRepositoryInParentFolders": "never",
    "window.dialogStyle": "custom",
    // 右の副サイドバー（Chat）を出さない。スクリーンショットの幅を左パネルとエディタに使う
    "workbench.secondarySideBar.defaultVisibility": "hidden",
  };
  await writeFile(
    path.join(userDataDir, "User", "settings.json"),
    JSON.stringify(settings, null, 2),
  );
}
