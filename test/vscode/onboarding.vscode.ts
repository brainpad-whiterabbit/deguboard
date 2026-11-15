// VS Code の実機で、左パネルの導入のチェックリスト（UI-12）を確かめる（t737・t1007）。Git リポジトリでない一時フォルダを開いて、
// - Git リポジトリの項目が満たさず、ボタンとコマンドが出ること。人がターミナルの代わりに外で git init しても、見張りが拾ってボードの項目に進むこと
// - ボードの項目のボタンを押すと、deguboard のターミナルで起動ファイルの dg が init を実行し、終わるといつもの画面（タブのあるサイドバー）に変わること
// - いつもの画面の上に推奨の項目の帯が出て、開くと「Skill と hooks を入れる」でその場で入れられること
// 途中の画面をライトとダークで撮る（test/vscode/screenshots/）。
// 拡張は起動のたびに起動ファイルを HOME（~/.local/share/deguboard/）に書くが、launchHost が HOME を一時ディレクトリにするので手元には書かない。
// VS Code 本体のダウンロードと画面が要るので mise run test には入れず、mise run test:vscode で回す

import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FrameLocator } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDisplay, launchHost, ROOT, type Display, type Host } from "./host.js";

const run = promisify(execFile);

let folder: string;
let display: Display;
let host: Host;
let sidebar: FrameLocator;

/** ライトとダークで撮る */
async function shoot(name: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await host.setTheme(theme);
    const shot = await host.screenshot(name, theme);
    await access(shot.sidebar);
  }
}

beforeAll(async () => {
  await access(path.join(ROOT, "packages/vscode/dist/web/index.html")).catch(() => {
    throw new Error("packages/vscode/dist がない。先に mise run build を実行する");
  });
  // Git リポジトリでない素のフォルダ（リモートもない）
  folder = await realpath(await mkdtemp(path.join(tmpdir(), "deguboard-setup-")));
  display = await ensureDisplay();
  host = await launchHost(folder, display);
  sidebar = await host.openSidebar();
}, 300_000);

afterAll(async () => {
  await host?.close();
  await display?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe("VS Code の実機の導入のチェックリスト", () => {
  it("Git リポジトリの外では、エラーの通知の代わりにチェックリストを出し、Git リポジトリの項目にボタンとコマンドを出す", async () => {
    await sidebar
      .locator("h2", { hasText: "Get Started with deguboard" })
      .waitFor({ timeout: 60_000 });
    await sidebar.getByText("This folder is not a Git repository.").waitFor();
    await sidebar.getByRole("button", { name: "Run git init in this folder" }).waitFor();
    // 作る場所を見せる
    await sidebar.locator(".setup-path", { hasText: folder }).waitFor();
    expect(await sidebar.locator(".notice.error").count()).toBe(0);
    await shoot("setup-repository");
  });

  it("人が自分で git init すると、見張りが拾って確かめ直し、ボードの項目に進む", async () => {
    await run("git", ["init", "-b", "main"], { cwd: folder });
    // VS Code の HOME は一時ディレクトリで git の個人の設定がないので、dg init のコミットの名前をリポジトリに置く
    await run("git", ["config", "user.name", "vscode-test"], { cwd: folder });
    await run("git", ["config", "user.email", "vscode-test@example.com"], { cwd: folder });
    await sidebar.getByRole("button", { name: "Create a new board" }).waitFor({ timeout: 60_000 });
    await shoot("setup-board");
    // チームのボードが別のリポジトリにある道を選ぶと、データのリポジトリとブランチの欄と、付ける引数の 1 行が出る（t1008）
    await sidebar.getByRole("radio", { name: "The team's board is in another repository" }).check();
    await sidebar
      .getByRole("textbox", { name: "Data repository (URL or remote name)" })
      .fill("git@github.com:team/kanban.git");
    await sidebar
      .getByText("dg init --data-remote git@github.com:team/kanban.git --data-branch deguboard")
      .waitFor();
    await shoot("setup-board-other");
    await sidebar.getByRole("radio", { name: "Create a new board" }).check();
  });

  it("ボードの項目のボタンを押すと deguboard のターミナルで dg init が走り、終わるといつもの画面に変わって、推奨の項目の帯が出る", async () => {
    await sidebar.getByRole("button", { name: "Create a new board" }).click();
    // 実行は VS Code の統合ターミナルで行われる。init が済むと見張りが画面を読み直し、チェックリストが消える
    await sidebar
      .locator("h2", { hasText: "Get Started with deguboard" })
      .waitFor({ state: "detached", timeout: 180_000 });
    await sidebar.locator('nav a[href="#/board"]').waitFor({ timeout: 60_000 });
    await sidebar.locator(".setup-band").waitFor({ timeout: 60_000 });
    await shoot("setup-band");
  }, 240_000);

  it("帯を開くと推奨の項目が出て、「Skill と hooks を入れる」でその場で入れられる", async () => {
    await sidebar.getByRole("button", { name: "Open the remaining items" }).click();
    await sidebar.locator("h2", { hasText: "Setup" }).waitFor();
    const install = sidebar.getByRole("button", { name: "Install the Skills and hooks" });
    await install.waitFor();
    await shoot("setup-recommended");
    await install.click();
    // hooks install が書く Claude Code の設定（.claude/settings.local.json）まで走ったことを確かめる
    const settings = path.join(folder, ".claude", "settings.local.json");
    await expect
      .poll(
        () =>
          access(settings).then(
            () => true,
            () => false,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    // 実行の終わりで確かめ直し、項目のボタンが消える（満たした印に変わる）
    await install.waitFor({ state: "detached", timeout: 60_000 });
  }, 240_000);

  it("ワークベンチと Webview に CSP 違反と捕まえていない例外がない", () => {
    expect(host.watch.cspViolations).toEqual([]);
    expect(host.watch.errors).toEqual([]);
  });
});
