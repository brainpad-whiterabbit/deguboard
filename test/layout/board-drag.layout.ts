// カンバンの列の間のドラッグ（t275。UI-2・UI-7）。dg serve の画面を Chromium で開き、チケットを別の列に落とすと ticket move で
// Status が変わって列が移り、Workflow の制約で拒否されたら理由を出して元の列に戻ることを確かめる。広い画面とサイドバーの幅の両方で試す。
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
const WORKFLOW = "software-development";

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

const statusOf = async (ticket: string) =>
  (await call<{ status: string }>("ticket.show", { ticket })).status;

/** Status の列（節） */
const column = (page: Page, status: string) => page.locator(`.column[data-status="${status}"]`);

/** 列の中のチケットへのリンク */
const linkIn = (page: Page, status: string, ticket: string) =>
  column(page, status).locator(`a[href="#/tickets/${ticket}"]`).first();

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
    template: WORKFLOW,
  });
  server = await startServer({ cwd: fixture.cloneA, port: 0, user: "layout", staticDir: WEB_DIST });
  // todo → review を誰にも許さない制約を足し、拒否される遷移を作る
  const { definition } = await call<{ definition: Record<string, unknown> }>("workflow.show", {
    workflow: WORKFLOW,
  });
  await call("workflow.set", {
    workflow: WORKFLOW,
    definition: { ...definition, transitions: [{ from: "todo", to: "review", by: [] }] },
  });
  await call("iteration.create", { name: "今週" });
  await call("iteration.start", { iteration: "s1" });
  await call("ticket.create", { title: "広い画面で動かすチケット", iteration: "s1" });
  await call("ticket.create", { title: "サイドバーで動かすチケット", iteration: "s1" });
  await call("ticket.create", { title: "拒否されるチケット", iteration: "s1" });
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

describe("カンバンの列の間のドラッグ", () => {
  it("広い画面で別の列（in_progress）に落とすと ticket move で Status が変わり、その列に移る", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${server.url}#/board`);
    const card = page.locator(".card", { has: page.locator('a[href="#/tickets/t1"]') });
    await card.waitFor();
    await drag(page, card, column(page, "in_progress"));
    await expect.poll(() => statusOf("t1")).toBe("in_progress");
    await linkIn(page, "in_progress", "t1").waitFor();
    expect(await column(page, "todo").locator('a[href="#/tickets/t1"]').count()).toBe(0);
    expect(await page.locator(".notice.error").count()).toBe(0);
    await page.close();
  });

  it("サイドバーの幅でも行をドラッグして別の節に移せる", async () => {
    const page = await browser.newPage({ viewport: { width: 300, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`);
    const row = column(page, "todo").locator(".row-drag", {
      has: page.locator('a[href="#/tickets/t2"]'),
    });
    await row.waitFor();
    await drag(page, row, column(page, "in_progress").locator("summary"));
    await expect.poll(() => statusOf("t2")).toBe("in_progress");
    await linkIn(page, "in_progress", "t2").waitFor();
    expect(await column(page, "todo").locator('a[href="#/tickets/t2"]').count()).toBe(0);
    expect(await page.locator(".notice.error").count()).toBe(0);
    await page.close();
  });

  it("Workflow の制約で拒否されたら理由を出し、元の列（todo）に戻す", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${server.url}#/board`);
    const card = page.locator(".card", { has: page.locator('a[href="#/tickets/t3"]') });
    await card.waitFor();
    await drag(page, card, column(page, "review"));
    const notice = page.locator(".notice.error");
    await notice.waitFor();
    expect(await notice.textContent()).toContain(
      "todo から review への遷移は Workflow がこの主体に許していない",
    );
    expect(await statusOf("t3")).toBe("todo");
    await linkIn(page, "todo", "t3").waitFor();
    expect(await column(page, "review").locator('a[href="#/tickets/t3"]').count()).toBe(0);
    await page.close();
  });
});
