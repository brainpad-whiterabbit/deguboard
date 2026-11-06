// VS Code の実機で左パネルの Webview を確かめる（t439）。bare リモート付きの一時リポジトリを dg init し、
// 拡張開発ホストを Xvfb 上に起動して（host.ts）、Activity Bar の deguboard からサイドバーのビューを開き：
// - カンバンにチケットの行が出て、タブ（バックログ）に切り替えても戻しても行が出ること
// - 行を押すとエディタ領域のパネルに詳細が開くこと（Webview → 拡張ホストのやり取り）
// - ウィンドウ全体（ワークベンチと Webview）に CSP 違反と捕まえていない例外が 1 つもないこと（検出が効くことは、Webview の中でわざと違反と例外を起こして確かめる）
// - ライトとダークのテーマでスクリーンショットを test/vscode/screenshots/ に出すこと
// VS Code 本体のダウンロードと画面が要るので mise run test には入れず、mise run test:vscode で回す（先に mise run build）

import { access } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  init,
  iterationCreate,
  iterationStart,
  openContext,
  runCommand,
  ticketClaim,
  ticketCreate,
} from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import {
  ensureDisplay,
  launchHost,
  ROOT,
  SCREENSHOT_DIR,
  type Display,
  type Host,
} from "./host.js";

const TITLES = [
  "実機で確かめるチケット 1：カンバンの行",
  "実機で確かめるチケット 2：バックログの行",
  "実機で確かめるチケット 3：作業中",
] as const;

let fixture: Fixture;
let display: Display;
let host: Host;
let sidebar: FrameLocator;

beforeAll(async () => {
  await access(path.join(ROOT, "packages/vscode/dist/web/index.html")).catch(() => {
    throw new Error("packages/vscode/dist がない。先に mise run build を実行する");
  });
  fixture = await createFixture();
  const ctx = await openContext({ cwd: fixture.cloneA, initialize: {} });
  await runCommand(init, ctx, { template: "software-development" });
  await runCommand(iterationCreate, ctx, { name: "実機の週" });
  await runCommand(iterationStart, ctx, { iteration: "s1" });
  // t1・t2 は s1 のカンバン、t3 はカンバンの作業中。バックログ（Iteration なし）にも行が出るよう 2 件目は入れない
  await runCommand(ticketCreate, ctx, {
    title: TITLES[0],
    acceptance: ["行が出る"],
    iteration: "s1",
  });
  await runCommand(ticketCreate, ctx, { title: TITLES[1], acceptance: ["行が出る"] });
  await runCommand(ticketCreate, ctx, {
    title: TITLES[2],
    acceptance: ["行が出る"],
    iteration: "s1",
  });
  await runCommand(ticketClaim, ctx, { ticket: "t3", without_branch: true });
  display = await ensureDisplay();
  host = await launchHost(fixture.cloneA, display);
  sidebar = await host.openSidebar();
}, 300_000);

afterAll(async () => {
  await host?.close();
  await display?.close();
  await fixture?.cleanup();
});

describe("VS Code の実機の左パネル", () => {
  it("カンバンにチケットの行が出て、バックログに切り替えても行が出る", async () => {
    await sidebar.locator(".ticket-row", { hasText: TITLES[0] }).waitFor({ timeout: 60_000 });
    await sidebar.locator(".ticket-row", { hasText: TITLES[2] }).waitFor();
    // タブは href で選ぶ（表示言語は VS Code の既定の英語なので文言に頼らない）
    await sidebar.locator('nav a[href="#/backlog"]').click();
    await sidebar.locator(".ticket-row", { hasText: TITLES[1] }).waitFor();
    await sidebar.locator('nav a[href="#/board"]').click();
    await sidebar.locator(".ticket-row", { hasText: TITLES[0] }).waitFor();
  });

  it("行を押すとエディタ領域のパネルに詳細が開く", async () => {
    await sidebar.locator(".ticket-row", { hasText: TITLES[0] }).click();
    await host.panelFrame().locator("h1", { hasText: TITLES[0] }).waitFor({ timeout: 60_000 });
    // パネルの題はチケットの番号と名前（UI-12）
    await host.page.locator(".part.editor .tab", { hasText: `t1 ${TITLES[0]}` }).waitFor();
  });

  it("ライトとダークのテーマのスクリーンショットを出す", async () => {
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("board", theme);
      await access(shot.window);
      await access(shot.sidebar);
    }
    console.log(`スクリーンショット: ${SCREENSHOT_DIR}`);
  });

  it("ワークベンチと Webview に CSP 違反と捕まえていない例外がない", () => {
    expect(host.watch.cspViolations).toEqual([]);
    expect(host.watch.errors).toEqual([]);
  });

  it("Webview の中でわざと起こした CSP 違反と例外を検出する", async () => {
    const before = { csp: host.watch.cspViolations.length, errors: host.watch.errors.length };
    // style-src に 'unsafe-inline' がないので <style> は拒否される。例外は setTimeout の中で投げて pageerror にする
    await sidebar.locator("body").evaluate((body) => {
      const style = document.createElement("style");
      style.textContent = "body { outline: 1px solid red }";
      body.append(style);
      setTimeout(() => {
        throw new Error("わざと投げた例外（t439）");
      }, 0);
    });
    await expect
      .poll(() => host.watch.cspViolations.length, { timeout: 10_000 })
      .toBeGreaterThan(before.csp);
    await expect
      .poll(() => host.watch.errors.length, { timeout: 10_000 })
      .toBeGreaterThan(before.errors);
    expect(host.watch.cspViolations.at(-1)).toMatch(/style/);
    expect(host.watch.errors.at(-1)).toMatch(/わざと投げた例外/);
    // 検出を確かめたので元に戻す（まとめの検査で落とさない）
    host.watch.cspViolations.length = before.csp;
    host.watch.errors.length = before.errors;
  });
});
