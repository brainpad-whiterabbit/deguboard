// 行の番号の下の PR のリンク（UI-2）。dg serve の画面を Chromium で開き、カンバンとバックログと履歴で PR の番号があるチケットの行は番号の下に PR の印と #番号を出し、
// ない行は今と同じ高さ・列の幅で出ることを確かめる。リンクは詳細の PR の欄と同じ URL を新しいタブで開き、詳細は開かず、行の選択も変えず、Tab では止まらない。
// リポジトリの web の URL がわからないときは、リンクにせず #番号を文字だけで出す。
// web の URL は画面が /api/status の web_url で受け取るので、GitHub の URL の形に書き換えて見せる（手元の bare リモートは GitHub ではないため）。
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
/** 左パネルの幅 */
const WIDTH = 300;
/** パネルの幅（詳細の画面） */
const PANEL_WIDTH = 800;
/** 画面に出す GitHub の URL（/api/status の web_url をこれに書き換える） */
const GITHUB = "https://github.com/o/r";
/** PR の番号（t2 に付ける） */
const PR = 7;
/** todo のまま PR の番号を持つ行（t4。頭の印がない行の番号の列を見る） */
const PR_TODO = 142;
/** 終えたチケットの PR の番号（t5。履歴の行を見る） */
const PR_DONE = 1234;

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

/** 行の包み（選べる行の ID を持つ要素）。t1 は PR のない行、t2 は PR のある行 */
const rowOf = (page: Page, id: string) => page.locator(`[data-select-id="${id}"]`);

/** 行の番号の下の PR のリンク */
const prLinkOf = (page: Page, id: string) => rowOf(page, id).locator(".row-pr a");

/** 行の左端 6px（帯の幅 12px の真ん中）の位置 */
async function stripPoint(row: Locator): Promise<{ x: number; y: number }> {
  const box = (await row.boundingBox())!;
  return { x: box.x + 6, y: box.y + box.height / 2 };
}

const boxOf = async (locator: Locator) => (await locator.boundingBox())!;

/**
 * タイトルの左端を、PR のない行と比べて確かめる（t727 の案 B）。
 * 番号の列は番号と PR のリンクのうち広いほうに広がり（styles.css の .row-pr の注釈）、タイトルはその列の右に、
 * PR のない行と同じ間隔（番号とタイトルのあいだ）で並ぶ。PR の文字が番号より狭ければ、タイトルは PR のない行と同じ位置になる。
 * 番号の左端と PR のリンクの左端は揃っている前提（揃いは別の確かめで見る）
 */
async function expectTitleAfterNumberColumn(pr: Locator, plain: Locator): Promise<void> {
  const [codeP, codeN, titleP, titleN, link] = await Promise.all([
    boxOf(pr.locator("code")),
    boxOf(plain.locator("code")),
    boxOf(pr.locator(".row-title")),
    boxOf(plain.locator(".row-title")),
    boxOf(pr.locator(".row-pr-link")),
  ]);
  const gap = titleN.x - codeN.x - codeN.width;
  const column = Math.max(codeP.width, link.width);
  expect(
    Math.abs(titleP.x - (codeP.x + column + gap)),
    "タイトルの左端は番号の列（番号と PR のリンクのうち広いほう）の右",
  ).toBeLessThan(0.5);
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
  await call("ticket.create", { title: "PR のないチケット", iteration: "s1" });
  await call("ticket.create", { title: "PR のあるチケット", iteration: "s1" });
  await call("ticket.create", { title: "PR のない進行中のチケット", iteration: "s1" });
  await call("ticket.create", { title: "PR のある todo のチケット", iteration: "s1" });
  await call("ticket.move", { ticket: "t2", status: "in_progress" });
  await call("ticket.move", { ticket: "t3", status: "in_progress" });
  await call("ticket.update", { ticket: "t2", pr: PR });
  await call("ticket.update", { ticket: "t4", pr: PR_TODO });
  // 履歴の行（t5 は PR のある 1 行のタイトル、t6 は PR のない行、t7 は PR のある 2 行のタイトル）
  await call("ticket.create", { title: "PR のある終えたチケット", iteration: "s1" });
  await call("ticket.create", { title: "PR のない終えたチケット", iteration: "s1" });
  await call("ticket.create", {
    title: "左パネルの幅ではタイトルが 2 行に折り返す長さの、PR のある終えたチケットの題",
    iteration: "s1",
  });
  await call("ticket.update", { ticket: "t5", pr: PR_DONE });
  await call("ticket.update", { ticket: "t7", pr: PR });
  for (const ticket of ["t5", "t6", "t7"]) await call("ticket.move", { ticket, status: "done" });
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

/**
 * 新しい画面を開く。webUrl が true なら /api/status の web_url を GitHub の URL にする（false なら手元のリモートのまま、web の URL はない）。
 * GitHub へのリンクは取らず（開いたタブの URL だけを見る）
 */
async function openPage(
  hash: string,
  { surface = "sidebar", webUrl = true }: { surface?: "sidebar" | "panel"; webUrl?: boolean } = {},
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: { width: surface === "sidebar" ? WIDTH : PANEL_WIDTH, height: 800 },
  });
  await context.route(`${GITHUB}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>ok</p>" }),
  );
  const page = await context.newPage();
  if (webUrl) {
    await page.route("**/api/status", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      await route.fulfill({
        response: res,
        json: { ...body, data: { ...body.data, web_url: GITHUB } },
      });
    });
  }
  await page.goto(`${server.url}?surface=${surface}#${hash}`, { waitUntil: "networkidle" });
  return { page, context };
}

describe("行の番号の下の PR のリンク（UI-2）", () => {
  it("カンバンの PR のある行は番号の下に PR の印と #番号を出し、PR のない行は今と同じ高さと列の幅で出る", async () => {
    // 比べる PR のない行は同じ列・同じ頭の印（進行中の着手済みの印）の t3。t1 は todo で頭の印がない
    const { page, context } = await openPage("/board");
    const plain = rowOf(page, "t3");
    const pr = rowOf(page, "t2");
    await pr.waitFor();
    expect((await pr.locator(".row-pr").textContent())?.trim()).toBe(`#${PR}`);
    expect(await plain.locator(".row-pr").count(), "PR のない行に PR の欄はない").toBe(0);
    expect(await plain.getAttribute("class"), "PR のない行の包み").not.toContain("pr-row");

    // 番号の左端は PR のない行と同じ。タイトルは番号の列の右（列の幅は PR の文字の幅しだいで広がる）
    const [codeP, codeN] = await Promise.all([
      boxOf(pr.locator("code")),
      boxOf(plain.locator("code")),
    ]);
    expect(Math.abs(codeP.x - codeN.x), "番号の左端").toBeLessThan(0.5);
    await expectTitleAfterNumberColumn(pr, plain);

    // PR の印とリンクは番号の左端に揃う（番号の下の 2 段目）
    const link = await boxOf(pr.locator(".row-pr-link"));
    expect(Math.abs(link.x - codeP.x), "PR の欄の左端は番号の左端").toBeLessThan(0.5);
    expect(link.y, "PR の欄は番号の下").toBeGreaterThanOrEqual(codeP.y + codeP.height - 1);

    // 行の高さ：PR のない行は今と同じ。1 段目（番号の行）の高さも同じ。行のリンク（.ticket-row）は 2 段にまたがるので（styles.css）、
    // その箱は行の全体と同じ高さになり、PR のある行の全体は 2 段の分だけ高い
    expect(Math.abs(codeP.height - codeN.height), "1 段目の高さ（番号）").toBeLessThan(0.5);
    const anchorN = await boxOf(plain.locator("a.ticket-row"));
    expect((await boxOf(pr)).height, "PR のある行の全体").toBeGreaterThan(
      (await boxOf(plain)).height + 8,
    );
    expect(
      Math.abs((await boxOf(plain)).height - anchorN.height),
      "PR のない行の全体",
    ).toBeLessThan(0.5);
    await context.close();
  });

  it("頭の印のない todo の行でも、PR の欄は番号の左端に揃い、タイトルと番号は PR のない行と同じ位置", async () => {
    const { page, context } = await openPage("/board");
    const plain = rowOf(page, "t1");
    const pr = rowOf(page, "t4");
    await pr.waitFor();
    expect((await pr.locator(".row-pr").textContent())?.trim()).toBe(`#${PR_TODO}`);
    const [codeP, codeN, link] = [
      await boxOf(pr.locator("code")),
      await boxOf(plain.locator("code")),
      await boxOf(pr.locator(".row-pr-link")),
    ];
    expect(Math.abs(codeP.x - codeN.x), "番号の左端").toBeLessThan(0.5);
    await expectTitleAfterNumberColumn(pr, plain);
    expect(Math.abs(link.x - codeP.x), "PR の欄の左端は番号の左端").toBeLessThan(0.5);
    await context.close();
  });

  it("バックログの PR のある行も番号の下に PR の欄を出し、PR のない行は出さない", async () => {
    const { page, context } = await openPage("/backlog");
    const pr = rowOf(page, "t2");
    await pr.waitFor();
    expect((await pr.locator(".row-pr").textContent())?.trim()).toBe(`#${PR}`);
    expect(await rowOf(page, "t1").locator(".row-pr").count()).toBe(0);
    const codeP = await boxOf(pr.locator("code"));
    const link = await boxOf(pr.locator(".row-pr-link"));
    expect(Math.abs(link.x - codeP.x), "PR の欄の左端は番号の左端").toBeLessThan(0.5);
    await expectTitleAfterNumberColumn(pr, rowOf(page, "t1"));
    await context.close();
  });

  it("リンクを押すと詳細と同じ URL を新しいタブで開き、詳細は開かず、選択も変えない", async () => {
    const { page, context } = await openPage("/board");
    const pr = rowOf(page, "t2");
    const plain = rowOf(page, "t1");
    await pr.waitFor();
    // 先に t1 を帯で選んでおき、PR のリンクを押しても選びが変わらないことを見る
    const strip = await stripPoint(plain);
    await page.mouse.click(strip.x, strip.y);
    expect(await plain.getAttribute("data-selected"), "帯で t1 を選んだ").not.toBeNull();

    const link = prLinkOf(page, "t2");
    expect(await link.getAttribute("target")).toBe("_blank");
    const href = (await link.getAttribute("href"))!;
    expect(href).toBe(`${GITHUB}/pull/${PR}`);
    const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
    expect(popup.url()).toBe(href);
    await popup.close();

    expect(page.url(), "詳細は開かない").toContain("#/board");
    expect(await plain.getAttribute("data-selected"), "選びは変わらない").not.toBeNull();
    expect(await pr.getAttribute("data-selected"), "PR のリンクでは選ばれない").toBeNull();
    await context.close();
  });

  it("2 段目の空いたところを押しても詳細は開かず、選択も変えない（頭の印の列・左の余白・右の空きも含む）", async () => {
    const { page, context } = await openPage("/board");
    const pr = rowOf(page, "t2");
    const noHead = rowOf(page, "t4");
    const plain = rowOf(page, "t1");
    await pr.waitFor();
    await noHead.waitFor();
    const strip = await stripPoint(plain);
    await page.mouse.click(strip.x, strip.y);
    expect(await plain.getAttribute("data-selected"), "帯で t1 を選んだ").not.toBeNull();
    const hashBefore = new URL(page.url()).hash;

    for (const row of [pr, noHead]) {
      const cell = await boxOf(row.locator(".row-pr"));
      const y = cell.y + cell.height / 2;
      // 2 段目の左端・中ほど・右端（リンクの右の空き）のどこも、包みではなく欄（.row-pr）が受ける
      // 左端は帯（幅 12px。帯は行の左端で選ぶ）の外の余白から見る
      for (const x of [cell.x + 12.5, cell.x + cell.width / 2, cell.x + cell.width - 3]) {
        const inCell = await page.evaluate(
          ({ px, py }: { px: number; py: number }) =>
            document.elementFromPoint(px, py)?.closest(".row-pr") != null,
          { px: x, py: y },
        );
        expect(inCell, `2 段目の x=${Math.round(x)} は欄が受ける`).toBe(true);
        await page.mouse.click(x, y);
      }
    }
    expect(await plain.getAttribute("data-selected"), "選びは変わらない").not.toBeNull();
    expect(await pr.getAttribute("data-selected")).toBeNull();
    expect(await noHead.getAttribute("data-selected")).toBeNull();
    expect(new URL(page.url()).hash, "詳細は開かない").toBe(hashBefore);
    await context.close();
  });

  it("PR のある行は 1 段目と 2 段目のどちらの左端の帯を押しても 1 件を選ぶ・外すになり、詳細は開かない", async () => {
    const { page, context } = await openPage("/board");
    const pr = rowOf(page, "t2");
    await pr.waitFor();
    const hashBefore = new URL(page.url()).hash;
    const row = await boxOf(pr);
    const firstLine = await boxOf(pr.locator("a.ticket-row"));
    const secondLine = await boxOf(pr.locator(".row-pr"));
    const points = [
      { name: "1 段目", y: firstLine.y + firstLine.height / 2 },
      { name: "2 段目", y: secondLine.y + secondLine.height / 2 },
    ];
    for (const { name, y } of points) {
      // 帯の真ん中（左端から 6px）の点は、子で覆われず行の要素そのものが受ける
      const x = row.x + 6;
      const hitsRow = await page.evaluate(
        ({ px, py }: { px: number; py: number }) =>
          document.elementFromPoint(px, py) === document.querySelector('[data-select-id="t2"]'),
        { px: x, py: y },
      );
      expect(hitsRow, `${name} の帯の点は行そのものが受ける`).toBe(true);
      await page.mouse.click(x, y);
      expect(
        await pr.getAttribute("data-selected"),
        `${name} の帯で選ぶ・外す（押すたびに切り替わる）`,
      ).toBe(name === "1 段目" ? "" : null);
    }
    expect(new URL(page.url()).hash, "詳細は開かない").toBe(hashBefore);
    await context.close();
  });

  it("PR のある行は 2 段目にもホバーの背景が付く", async () => {
    const { page, context } = await openPage("/board");
    const pr = rowOf(page, "t2");
    await pr.waitFor();
    const cell = await boxOf(pr.locator(".row-pr"));
    await page.mouse.move(cell.x + cell.width - 3, cell.y + cell.height / 2);
    const bg = await pr.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, "2 段目にホバーの背景").not.toBe("rgba(0, 0, 0, 0)");
    await context.close();
  });

  it("PR のリンクは Tab で止まらず（tabIndex -1）、行の主リンクだけに止まる", async () => {
    const { page, context } = await openPage("/board");
    await rowOf(page, "t2").waitFor();
    expect(await prLinkOf(page, "t2").evaluate((el) => (el as HTMLAnchorElement).tabIndex)).toBe(
      -1,
    );
    await rowOf(page, "t2").locator("a.ticket-row").focus();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const inPrLink = await page.evaluate(
        () => document.activeElement?.closest(".row-pr") != null,
      );
      expect(inPrLink, `Tab ${i + 1} 回目で PR のリンクに止まらない`).toBe(false);
    }
    await context.close();
  });

  it("リポジトリの web の URL がわからないときは、リンクにせず #番号を文字だけで出す", async () => {
    const { page, context } = await openPage("/board", { webUrl: false });
    const pr = rowOf(page, "t2");
    await pr.waitFor();
    expect((await pr.locator(".row-pr").textContent())?.trim()).toBe(`#${PR}`);
    expect(await pr.locator(".row-pr a").count(), "リンクにしない").toBe(0);
    await context.close();
  });

  describe("履歴の行（チケットの見方）", () => {
    const HISTORY = "/history?view=ticket";

    it("PR のある行は番号のすぐ下に PR の印と #番号を出し、行の高さは PR のない行と同じ。付記に PR を書かない", async () => {
      const { page, context } = await openPage(HISTORY);
      const pr = rowOf(page, "t5");
      const plain = rowOf(page, "t6");
      await pr.waitFor();
      expect((await pr.locator(".row-pr").textContent())?.trim()).toBe(`#${PR_DONE}`);
      expect(await pr.locator(".row-pr svg").count(), "PR の印").toBe(1);
      expect(await plain.locator(".row-pr").count(), "PR のない行に PR の欄はない").toBe(0);
      for (const row of [pr, plain])
        expect(await row.locator(".history-ticket-meta").textContent()).not.toMatch(/#\d|PR/);

      const [codeP, codeN, link, titleP, meta] = await Promise.all([
        boxOf(pr.locator("code")),
        boxOf(plain.locator("code")),
        boxOf(pr.locator(".row-pr-link")),
        boxOf(pr.locator(".row-title")),
        boxOf(pr.locator(".history-ticket-note")),
      ]);
      expect(Math.abs(codeP.x - codeN.x), "番号の左端").toBeLessThan(0.5);
      expect(Math.abs(link.x - codeP.x), "PR の欄の左端は番号の左端").toBeLessThan(0.5);
      expect(link.y, "PR の欄は番号の下").toBeGreaterThanOrEqual(codeP.y + codeP.height - 1);
      // 1 行のタイトルでは、PR は付記の横（同じ高さ）に並び、タイトルと付記に重ならない
      expect(Math.abs(link.y + link.height / 2 - (meta.y + meta.height / 2))).toBeLessThan(1.5);
      expect(link.x + link.width, "PR は付記の左").toBeLessThanOrEqual(meta.x);
      expect(link.x + link.width, "PR はタイトルの左").toBeLessThanOrEqual(titleP.x);
      expect(
        Math.abs((await boxOf(pr)).height - (await boxOf(plain)).height),
        "行の高さ",
      ).toBeLessThan(0.5);
      await context.close();
    });

    it("タイトルが 2 行の行は、PR をタイトルの 2 行目の横に出し、行を増やさない", async () => {
      const { page, context } = await openPage(HISTORY);
      const pr = rowOf(page, "t7");
      await pr.waitFor();
      const [code, link, title, row, main, meta] = await Promise.all([
        boxOf(pr.locator("code")),
        boxOf(pr.locator(".row-pr-link")),
        boxOf(pr.locator(".row-title")),
        boxOf(pr),
        boxOf(pr.locator("a.ticket-row")),
        boxOf(pr.locator(".history-ticket-meta")),
      ]);
      expect(title.height, "タイトルは 2 行").toBeGreaterThan(code.height * 1.5);
      const secondLine = { top: title.y + title.height / 2, bottom: title.y + title.height };
      const mid = link.y + link.height / 2;
      expect(mid, "PR はタイトルの 2 行目の高さ").toBeGreaterThan(secondLine.top);
      expect(mid).toBeLessThan(secondLine.bottom);
      expect(link.x + link.width, "PR はタイトルの左").toBeLessThanOrEqual(title.x);
      // 行は 1 段目（2 行のタイトル）と付記の段だけ
      expect(Math.abs(row.height - main.height - meta.height), "行の高さ").toBeLessThan(0.5);
      await context.close();
    });

    it("リンクを押すと PR を新しいタブで開き、行の選択と開いている画面を変えず、Tab では止まらない", async () => {
      const { page, context } = await openPage(HISTORY);
      const pr = rowOf(page, "t5");
      const plain = rowOf(page, "t6");
      await pr.waitFor();
      const strip = await stripPoint(plain);
      await page.mouse.click(strip.x, strip.y);
      expect(await plain.getAttribute("data-selected"), "帯で t6 を選んだ").not.toBeNull();
      const hashBefore = new URL(page.url()).hash;

      const link = prLinkOf(page, "t5");
      expect(await link.evaluate((el) => (el as HTMLAnchorElement).tabIndex)).toBe(-1);
      const href = (await link.getAttribute("href"))!;
      expect(href).toBe(`${GITHUB}/pull/${PR_DONE}`);
      const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
      expect(popup.url()).toBe(href);
      await popup.close();

      expect(new URL(page.url()).hash, "詳細は開かない").toBe(hashBefore);
      expect(await plain.getAttribute("data-selected"), "選びは変わらない").not.toBeNull();
      expect(await pr.getAttribute("data-selected"), "PR のリンクでは選ばれない").toBeNull();
      await context.close();
    });
  });

  it("PR の欄は詳細の PR の欄と同じ URL を指す", async () => {
    const { page, context } = await openPage("/tickets/t2", { surface: "panel" });
    const detail = page.locator(`a[href$="/pull/${PR}"]`).first();
    await detail.waitFor();
    expect(await detail.getAttribute("href")).toBe(`${GITHUB}/pull/${PR}`);
    await context.close();
  });
});
