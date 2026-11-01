// バックログの区画の間のドラッグ（t76）。dg serve の画面を Chromium で開き、チケットを別の区画に落とすと Iteration が変わり、
// 拒否されたら理由を出して元の区画に戻ることを確かめる。広い画面とサイドバーの幅の両方で試す。
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");

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

const iterationOf = async (ticket: string) =>
  (await call<{ iteration?: string }>("ticket.show", { ticket })).iteration;

/** 区画（見出しに含む文で探す） */
const section = (page: Page, head: string) =>
  page.locator(".backlog-section").filter({ hasText: head });

/** source をつかんで target の上で離す。PointerSensor は 4px 動かしてから始まる */
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 12), { steps: 10 });
  await page.mouse.up();
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
  await call("ticket.create", { title: "未割り当てのチケット" });
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

describe("バックログの区画の間のドラッグ", () => {
  it("広い画面で別の区画（Iteration なし）に落とすと Iteration が変わり、画面に映る", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${server.url}#/backlog`);
    const row = page.locator("tr", { has: page.locator('a[href="#/tickets/t1"]') }).first();
    await row.waitFor();
    await drag(page, row, section(page, "Iteration なし"));
    await expect.poll(() => iterationOf("t1")).toBeUndefined();
    await section(page, "Iteration なし").locator('a[href="#/tickets/t1"]').first().waitFor();
    await page.close();
  });

  it("サイドバーの幅でもドラッグで移せる", async () => {
    const page = await browser.newPage({ viewport: { width: 300, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/backlog`);
    const row = page.locator(".row-drag", { has: page.locator('a[href="#/tickets/t2"]') });
    await row.waitFor();
    await drag(page, row, section(page, "来週"));
    await expect.poll(() => iterationOf("t2")).toBe("s2");
    await page.close();
  });

  it("拒否されたら理由を出し、元の区画に戻す", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${server.url}#/backlog`);
    const row = page.locator("tr", { has: page.locator('a[href="#/tickets/t1"]') }).first();
    await row.waitFor();
    // 画面が知らないうちに落とし先の Iteration を閉じる（画面は読み直していないので planned のまま見える）
    await call("iteration.close", { iteration: "s2" });
    await drag(page, row, section(page, "来週"));
    await page.locator(".notice.error").waitFor();
    expect(await iterationOf("t1")).toBeUndefined();
    await section(page, "Iteration なし").locator('a[href="#/tickets/t1"]').first().waitFor();
    await page.close();
  });
});
