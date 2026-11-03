// 吹き出しの一覧（UI-15。t300 でドラッグの確かめから置き換えた）。dg serve の画面を Chromium で開き、
// カンバンとバックログの行・区画の見出し、Iteration の詳細の行の吹き出しを押すと頼むことの一覧が画面の中に出て、
// 選ぶと入力欄が開くことと、行をドラッグしてもデータが変わらないこと（画面から書き込むのはチケット詳細と設定画面だけ。ADR-010）を確かめる。
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
/** 左パネルの幅 */
const WIDTH = 300;
/** エディタのパネルの幅（Iteration の詳細は表で出す） */
const PANEL_WIDTH = 800;

let fixture: Fixture;
let server: { url: string; close(): Promise<void> };
let browser: Browser;

async function call<O = unknown>(name: string, input: Record<string, unknown>): Promise<O> {
  const res = await fetch(`${server.url}api/commands/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  const body = (await res.json()) as { ok: boolean; data: O; error?: unknown };
  if (!body.ok) throw new Error(`${name} が失敗した: ${JSON.stringify(body.error)}`);
  return body.data;
}

const show = (ticket: string) =>
  call<{ status: string; iteration?: string }>("ticket.show", { ticket });

/** source をつかんで target の上で離す（前はここで Status や Iteration が変わった） */
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 12), { steps: 10 });
  await page.mouse.up();
}

/** spot の吹き出しを押して一覧を開き、一覧が幅の中に収まることを確かめて項目の文を返す */
async function openMenu(page: Page, spot: Locator, width = WIDTH): Promise<string[]> {
  await spot.hover();
  await spot.locator(".ask-bubble").first().click();
  const menu = page.locator(".ask-menu");
  await menu.waitFor();
  await expect.poll(() => menu.locator("[role=menuitem]").count()).toBeGreaterThan(0);
  const box = (await menu.boundingBox())!;
  expect(box.x, "一覧の左端").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "一覧の右端").toBeLessThanOrEqual(width);
  return menu.locator("[role=menuitem]").allTextContents();
}

beforeAll(async () => {
  await access(path.join(WEB_DIST, "index.html")).catch(() => {
    throw new Error("packages/web/dist がない。先に mise run build を実行する");
  });
  fixture = await createFixture();
  await runCommand(init, await openContext({ cwd: fixture.cloneA, initialize: {} }), {
    template: "software-development",
  });
  server = await startServer({ cwd: fixture.cloneA, port: 0, user: "layout", staticDir: WEB_DIST });
  await call("iteration.create", { name: "今週" });
  await call("iteration.start", { iteration: "s1" });
  await call("iteration.create", { name: "来週" });
  await call("ticket.create", { title: "今週のチケット", iteration: "s1" });
  await call("ticket.create", { title: "もう 1 つのチケット", iteration: "s1" });
  await call("ticket.create", { title: "未割り当てのチケット" });
  await call("ticket.move", { ticket: "t2", status: "in_progress" });
  browser = await chromium.launch().catch((error: unknown) => {
    throw new Error(
      `Chromium を起動できない。mise run playwright:install を実行する（${String(error)}）`,
    );
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await fixture?.cleanup();
});

describe("吹き出しの一覧（UI-15）", () => {
  it("左パネルのカンバンの行と節の見出しの一覧は幅の中に出て、選ぶと入力欄が開く。行を別の節にドラッグしても Status は変わらない", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const row = page.locator('.column[data-status="todo"] .row-item', {
      has: page.locator('a[href="#/tickets/t1"]'),
    });
    await row.waitFor();
    await drag(page, row, page.locator('.column[data-status="review"] summary'));
    await page.waitForTimeout(300);
    expect((await show("t1")).status).toBe("todo");
    expect(await page.locator('.column[data-status="todo"] a[href="#/tickets/t1"]').count()).toBe(
      1,
    );

    expect((await openMenu(page, row))[0]).toContain("おすすめ");
    await page.locator(".ask-menu [role=menuitem]").first().click();
    await page.locator(".ask-composer").waitFor();
    await page.keyboard.press("Escape");

    const heading = page.locator('.column[data-status="in_progress"] > summary');
    expect((await openMenu(page, heading)).length).toBeGreaterThan(0);
    expect(await page.locator(".notice.error").count()).toBe(0);
    await page.close();
  });

  it("左パネルのバックログの行と区画の見出しの一覧は幅の中に出る。行を別の区画にドラッグしても Iteration は変わらない", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/backlog`, { waitUntil: "networkidle" });
    const section = (head: string) => page.locator(".backlog-section").filter({ hasText: head });
    const row = page.locator(".backlog-rows li", { has: page.locator('a[href="#/tickets/t3"]') });
    await row.waitFor();
    await drag(page, row, section("来週").locator("summary"));
    await page.waitForTimeout(300);
    expect((await show("t3")).iteration).toBeUndefined();
    // 0 件の区画にも作るボタン（+）は出さない
    expect(await page.getByRole("button", { name: "Iteration を作る" }).count()).toBe(0);

    expect((await openMenu(page, row)).length).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    expect((await openMenu(page, section("今週").locator("summary"))).length).toBeGreaterThan(0);
    await page.close();
  });

  it("パネルの Iteration の詳細は開始・閉じる・外すのボタンを出さず、行の一覧に「s1 から外す」を出す", async () => {
    const page = await browser.newPage({ viewport: { width: PANEL_WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=panel#/iterations/s1`, { waitUntil: "networkidle" });
    const row = page.locator("tr", { has: page.locator('a[href="#/tickets/t1"]') }).first();
    await row.waitFor();
    for (const name of ["開始する", "閉じる", "外す", "足す"])
      expect(await page.getByRole("button", { name, exact: true }).count(), name).toBe(0);
    expect(await openMenu(page, row, PANEL_WIDTH)).toContainEqual(
      expect.stringContaining("s1 から外す"),
    );
    await page.close();
  });

  it("広い画面のカンバンのカードを別の列にドラッグしても Status は変わらない", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${server.url}#/board`, { waitUntil: "networkidle" });
    const card = page.locator(".card", { has: page.locator('a[href="#/tickets/t1"]') });
    await card.waitFor();
    await drag(page, card, page.locator('.column[data-status="in_progress"]'));
    await page.waitForTimeout(300);
    expect((await show("t1")).status).toBe("todo");
    expect(await page.getByRole("button", { name: "+ Iteration を作る" }).count()).toBe(0);
    await page.close();
  });
});
