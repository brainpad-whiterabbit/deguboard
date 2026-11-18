// VS Code の実機で、左パネルの導入のチェックリスト（UI-12）を確かめる（t737・t1007）。Git リポジトリでない一時フォルダを開いて、
// - Git リポジトリの項目が満たさず、ボタンとコマンドが出ること。人がターミナルの代わりに外で git init しても、見張りが拾ってボードの項目に進むこと
// - ボードの項目のボタンを押すと、deguboard のターミナルで起動ファイルの dg が init を実行し、終わるといつもの画面（タブのあるサイドバー）に変わること
// - いつもの画面の上に推奨の項目の帯が出て、開くと「Skill と hooks を入れる」でその場で入れられること
// - タイトル行のセットアップのアイコンでチェックリストと来る前の画面を行き来でき、帯を出さないと決めた後も開けて、帯をまた出せること（t1021）
// - 項目が欠けている間はそのアイコンが点付きになって件数をツールチップに出し、帯を出さないと決めた後も残り、すべて満たすと元に戻ること（t1084）
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

/** 推奨の項目の id と、画面に出る名前。画面は id を出さないので、帯とチェックリストの項目の行の名前から id を引く */
const RECOMMENDED = {
  skills_hooks: "Skills and hooks",
  dg_command: "dg command",
  gitignore: ".claude/.gitignore",
} as const;

/**
 * 推奨の項目の帯が挙げている、欠けている項目の id。帯の文「N recommended items are not done (名前, 名前).」の括弧の中を読む。
 * RECOMMENDED にない名前（後から足された推奨の項目）はその名前のまま返し、括弧が読めないときは帯の文をそのまま返して、
 * 落ちたときの差分に欠けている項目が出るようにする
 */
async function missingInBand(): Promise<string[]> {
  const text = await sidebar.locator(".setup-band > span").first().innerText();
  const list = /\((.*)\)/.exec(text)?.[1];
  if (list === undefined) return [text];
  const idOf = new Map<string, string>(Object.entries(RECOMMENDED).map(([id, name]) => [name, id]));
  return list.split(", ").map((name) => idOf.get(name) ?? name);
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
    // 実行の終わりで確かめ直し、項目が満たした印に変わる。ボタンが消えたことでは確かめない
    // （入れるコマンドが --force だけのときは、項目が欠けたままでもボタンは出ない。setup-checklist.tsx の guideOf）
    await sidebar
      .locator(".setup-item.ok", { hasText: RECOMMENDED.skills_hooks })
      .waitFor({ timeout: 60_000 });
    expect(await install.count()).toBe(0);
  }, 240_000);

  it("タイトル行のセットアップのアイコンでチェックリストと来る前の画面を行き来でき、帯を出さないと決めた後も開けて、帯をまた出せる（t1021）", async () => {
    // ビューのタイトル行（ワークベンチの側）の左端のアイコン。項目が欠けている間は点付きのアイコン（題が「Setup (1 item missing)」など）に替わる。
    // 同じアイコンがビューの見出し（ビューが 1 つの間は隠れている）にもあるので、見えているほうを押す
    const icon = host.page
      .locator('.part.sidebar a.action-label[aria-label^="Setup"]')
      .locator("visible=true");
    const heading = sidebar.locator("h2", { hasText: "Setup" });
    const board = sidebar.locator('nav a[href^="#/board"]');
    // 前の検査がチェックリストを開いたままかによらないよう、先にボードのタブを押していつもの画面から始める
    // （チェックリストを開いている間もタブは押せる）
    await board.click();
    await heading.waitFor({ state: "detached" });
    // アイコンでチェックリストを開き、もう一度押すと来る前の画面（ボード）に戻る
    await icon.click();
    await heading.waitFor();
    await icon.click();
    await heading.waitFor({ state: "detached" });
    await sidebar.locator('nav a.active[href^="#/board"]').waitFor();
    // 推奨の項目が残っている（.claude/.gitignore をコミットしていない）ので帯が出る。このリポジトリでは出さないと決める
    await sidebar.getByRole("button", { name: "Do not show in this repository" }).click();
    await sidebar.locator(".setup-band").waitFor({ state: "detached" });
    // 帯がなくても、アイコンからチェックリストを開ける。開いている間はタブを選んでいない見た目
    await icon.click();
    await heading.waitFor();
    const restore = sidebar.getByRole("button", { name: "Show the banner again" });
    await restore.waitFor();
    expect(await sidebar.locator("nav a.active").count()).toBe(0);
    await shoot("setup-title-icon");
    // 帯をまた出すと決め直し、タブを押すとその画面に戻って帯が出る
    await restore.click();
    await restore.waitFor({ state: "detached" });
    await board.click();
    await heading.waitFor({ state: "detached" });
    await sidebar.locator(".setup-band").waitFor({ timeout: 60_000 });
  }, 240_000);

  it("項目が欠けている間はタイトル行のセットアップのアイコンが点付きになって件数をツールチップに出し、帯を出さないと決めた後も残り、すべて満たすと元のアイコンに戻る（t1084）", async () => {
    const dotted = host.page
      .locator('.part.sidebar a.action-label[aria-label^="Setup ("]')
      .locator("visible=true");
    const plain = host.page
      .locator(".part.sidebar a.action-label.codicon-checklist")
      .locator("visible=true");
    const heading = sidebar.locator("h2", { hasText: "Setup" });
    // 前の検査の終わりは帯を出してボードを出している。欠けているのは、コミットしていない .claude/.gitignore だけ。
    // 件数の前に欠けている項目を確かめ、落ちたときにどの項目が欠けていたかがわかるようにする
    await expect.poll(missingInBand, { timeout: 60_000 }).toEqual(["gitignore"]);
    await dotted.waitFor({ timeout: 60_000 });
    await expect
      .poll(() => dotted.getAttribute("aria-label"), { timeout: 60_000 })
      .toBe("Setup (1 item missing)");
    expect(await plain.count()).toBe(0);
    await shoot("setup-title-dot");
    // 帯を出さないと決めても点は残る
    await sidebar.getByRole("button", { name: "Do not show in this repository" }).click();
    await sidebar.locator(".setup-band").waitFor({ state: "detached" });
    await dotted.waitFor();
    // 点付きのアイコンも、元のアイコンと同じくチェックリストを開閉する
    await dotted.click();
    await heading.waitFor();
    await dotted.click();
    await heading.waitFor({ state: "detached" });
    // 残りの項目を満たす。帯を出さない間は見張りでは確かめ直さないので、チェックリストを開いて確かめ直させる
    await run("git", ["add", ".claude/.gitignore"], { cwd: folder });
    await run("git", ["commit", "-m", "ignore", "--", ".claude/.gitignore"], { cwd: folder });
    await dotted.click();
    await heading.waitFor();
    await plain.waitFor({ timeout: 60_000 });
    expect(await dotted.count()).toBe(0);
    await plain.click();
    await heading.waitFor({ state: "detached" });
    await shoot("setup-title-plain");
  }, 240_000);

  it("ワークベンチと Webview に CSP 違反と捕まえていない例外がない", () => {
    expect(host.watch.cspViolations).toEqual([]);
    expect(host.watch.errors).toEqual([]);
  });
});
