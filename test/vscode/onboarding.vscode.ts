// VS Code の実機で、dg init 前の始め方の画面を確かめる（t737）。dg init していない一時リポジトリを開いて、
// - 始め方の画面に「このリポジトリで始める」ボタンが出ること（ライトとダークのスクリーンショットを test/vscode/screenshots/ に出す）
// - ボタンを押すと、リポジトリを開いた新しいターミナルで起動ファイルの dg が init・skill install・hooks install を実行し、
//   終わると始め方の画面が普段の画面（タブのあるサイドバー）に変わること
// 拡張は起動のたびに起動ファイルを HOME（~/.local/share/deguboard/）に書くが、launchHost が HOME を一時ディレクトリにするので手元には書かない。
// VS Code 本体のダウンロードと画面が要るので mise run test には入れず、mise run test:vscode で回す

import { access } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { ensureDisplay, launchHost, ROOT, type Display, type Host } from "./host.js";

let fixture: Fixture;
let display: Display;
let host: Host;
let sidebar: FrameLocator;

beforeAll(async () => {
  await access(path.join(ROOT, "packages/vscode/dist/web/index.html")).catch(() => {
    throw new Error("packages/vscode/dist がない。先に mise run build を実行する");
  });
  // dg init していない素の Git リポジトリ
  fixture = await createFixture();
  display = await ensureDisplay();
  host = await launchHost(fixture.cloneA, display);
  sidebar = await host.openSidebar();
}, 300_000);

afterAll(async () => {
  await host?.close();
  await display?.close();
  await fixture?.cleanup();
});

describe("VS Code の実機の始め方の画面", () => {
  it("dg init 前は始め方を出し、「このリポジトリで始める」ボタンが出て、ライトとダークで撮る", async () => {
    await sidebar
      .locator("h2", { hasText: "Get Started with deguboard" })
      .waitFor({ timeout: 60_000 });
    await sidebar.getByRole("button", { name: "Start with this repository" }).waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("onboarding", theme);
      await access(shot.sidebar);
    }
  });

  it("ボタンを押すと新しいターミナルで dg init などが走り、終わると普段の画面に変わる", async () => {
    await sidebar.getByRole("button", { name: "Start with this repository" }).click();
    // 実行は VS Code の統合ターミナルで行われる。init が済むと見張りが画面を読み直し、始め方の画面が消える
    await sidebar
      .locator("h2", { hasText: "Get Started with deguboard" })
      .waitFor({ state: "detached", timeout: 180_000 });
    await sidebar.locator('nav a[href="#/board"]').waitFor({ timeout: 60_000 });
    // hooks install が書く Claude Code の設定（.claude/settings.local.json）まで走ったことを確かめる
    const settings = path.join(fixture.cloneA, ".claude", "settings.local.json");
    await expect
      .poll(
        () =>
          access(settings).then(
            () => true,
            () => false,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
  }, 240_000);

  it("ワークベンチと Webview に CSP 違反と捕まえていない例外がない", () => {
    expect(host.watch.cspViolations).toEqual([]);
    expect(host.watch.errors).toEqual([]);
  });
});
