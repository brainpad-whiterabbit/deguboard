// 吹き出しの一覧（UI-15）。dg serve の画面を Chromium で開き、
// カンバンとバックログの行・区画の見出し、Iteration の詳細の行の吹き出しを押すと頼むことの一覧が画面の中に出て、
// 選ぶと入力欄が開くことと、入力欄の頼むことの札が（入らなければ折り返して）幅に収まり、閉じるボタンが残ること、行をドラッグしても書き込みの要求を送らずデータが変わらないこと（画面から書き込むのはチケット詳細と設定画面だけ。ADR-027）を確かめる。
// 行の左端の帯（styles.css の [data-select-id]::before）は、押すと 1 件を選ぶ・外すになり、足しても行の配置は変わらず、hover で薄く、hover のない画面では常に薄く出ることを確かめる。
// 帯の幅は 12px（STRIP_PX と同じ）で、内側の端（11px）は選び、外側の端（13px）は詳細を開くことも確かめる。
// 帯を押したままなぞると通った行をまとめて選ぶ（マウスとペン。タッチは選ばずスクロール）、帯の外から始めたなぞりは選ばず、一覧の端では画面の外の行まで続けて選べることも確かめる。
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCommand, init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
/** 左パネルの幅 */
const WIDTH = 300;
/** 札が確実に折り返す狭い幅 */
const NARROW_WIDTH = 200;
/** エディタのパネルの幅（Iteration の詳細は段分けの一覧で出す） */
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

/**
 * page がこの後に送る書き込みのコマンドの要求（POST の /api/commands/<name> で、core のコマンドが write のもの）を集める。
 * 書き込みかどうかは core のコマンド定義の write の印で決める（packages/web の write-commands.test.ts と同じ考え方）
 */
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const match = /\/api\/commands\/([^/?#]+)$/.exec(new URL(request.url()).pathname);
    if (!match) return;
    const name = decodeURIComponent(match[1]!);
    if (findCommand(name)?.write) writes.push(name);
  });
  return writes;
}

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
    const writes = watchWrites(page);
    await drag(page, row, page.locator('.column[data-status="review"] summary'));
    // 要求は離した直後に出るので、固定の待ちは遅れて出る要求を拾うための補い
    await page.waitForTimeout(300);
    expect(writes, "ドラッグで送った書き込みのコマンド").toEqual([]);
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
    const writes = watchWrites(page);
    await drag(page, row, section("来週").locator("summary"));
    // 要求は離した直後に出るので、固定の待ちは遅れて出る要求を拾うための補い
    await page.waitForTimeout(300);
    expect(writes, "ドラッグで送った書き込みのコマンド").toEqual([]);
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
    // パネルは段分けの一覧（TicketSections）。未完了の段は開いている
    await page.goto(`${server.url}?surface=panel#/iterations/s1`, { waitUntil: "networkidle" });
    const row = page
      .locator(".ticket-sections ul.rows > li", { has: page.locator('a[href="#/tickets/t1"]') })
      .first();
    await row.waitFor();
    for (const name of ["開始する", "閉じる", "外す", "足す"])
      expect(await page.getByRole("button", { name, exact: true }).count(), name).toBe(0);
    expect(await openMenu(page, row, PANEL_WIDTH)).toContainEqual(
      expect.stringContaining("s1 から外す"),
    );
    await page.close();
  });

  it("左パネルのカンバンの行を別の節にドラッグしても Status は変わらない", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const row = page.locator(".column .row-item", { has: page.locator('a[href="#/tickets/t1"]') });
    await row.waitFor();
    const writes = watchWrites(page);
    await drag(page, row, page.locator('.column[data-status="in_progress"]'));
    // 要求は離した直後に出るので、固定の待ちは遅れて出る要求を拾うための補い
    await page.waitForTimeout(300);
    expect(writes, "ドラッグで送った書き込みのコマンド").toEqual([]);
    expect((await show("t1")).status).toBe("todo");
    expect(await page.getByRole("button", { name: "+ Iteration を作る" }).count()).toBe(0);
    await page.close();
  });

  it.each([WIDTH, NARROW_WIDTH])(
    "幅 %ipx の左パネルの入力欄は頼むことの札を（入らなければ折り返して）幅の中に収め、すべての札を選べて、閉じるボタンも残る",
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
      const row = page.locator('.column[data-status="in_progress"] .row-item', {
        has: page.locator('a[href="#/tickets/t2"]'),
      });
      await row.waitFor();
      await openMenu(page, row, width);
      await page.locator(".ask-menu [role=menuitem]").first().click();
      const composer = page.locator(".ask-composer");
      await composer.waitFor();
      const chips = composer.locator("button.ask-suggestion");
      await expect.poll(() => chips.count()).toBeGreaterThan(1);
      const count = await chips.count();
      // 折り返すのは札が 1 行に入らないときだけなので、折り返したことは札が確実に入らない 200px で確かめる。
      // 300px で 1 行に収まるかは札の顔ぶれと名前で決まり、in_progress の t2 の札（再開する・様子を聞く・変える・検討する・自由に）は
      // s25 の頼むことの変更（t670〜t679）の後は 300px の 1 行に収まる。収まるときに折り返さないのは正しい画面なので、300px では幅に収まることだけを見る
      if (width === NARROW_WIDTH) {
        const rows = new Set(
          await chips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y))),
        );
        expect(rows.size, "札の行の数").toBeGreaterThanOrEqual(2);
      }
      for (let i = 0; i < count; i++) {
        const box = (await chips.nth(i).boundingBox())!;
        expect(box.x, `札 ${i} の左端`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `札 ${i} の右端`).toBeLessThanOrEqual(width);
        // 幅の外に隠れず、押せる
        await chips.nth(i).click();
        expect(await chips.nth(i).getAttribute("aria-pressed"), `札 ${i} を選ぶ`).toBe("true");
      }
      // 閉じるボタンの右端は小数の丸めで幅を 0.5px 超えることがある（幅 200px で 200.27px を実測）。
      // 札と違って溢れは見た目に出ない差なので、0.5px までの超えは許す
      const close = (await composer.getByRole("button", { name: "閉じる" }).boundingBox())!;
      expect(close.x + close.width, "閉じるボタンの右端").toBeLessThanOrEqual(width + 0.5);
      await composer.getByRole("button", { name: "閉じる" }).click();
      expect(await composer.count()).toBe(0);
      await page.close();
    },
  );
});

describe("行の左端の帯で 1 件ずつ選ぶ（UI-15）", () => {
  /** 行の左端から x px の、行の高さの真ん中の位置（帯の幅は 12px） */
  async function pointAt(row: Locator, x: number): Promise<{ x: number; y: number }> {
    const box = (await row.boundingBox())!;
    return { x: box.x + x, y: box.y + box.height / 2 };
  }

  /** 行の左端の帯の中（6px。帯の幅 12px の真ん中） */
  const stripPoint = (row: Locator) => pointAt(row, 6);

  /** 行の左端の帯を押す */
  async function clickStrip(page: Page, row: Locator): Promise<void> {
    const { x, y } = await stripPoint(row);
    await page.mouse.click(x, y);
  }

  /** 行の疑似要素（帯）の不透明度 */
  const stripOpacity = (row: Locator) =>
    row.evaluate((el) => getComputedStyle(el, "::before").opacity);

  /** 選べる行の並び（位置と、中身の最初の要素の位置と大きさ）。帯の有無で比べる */
  const layoutOf = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-select-id]")].map((el) => {
        const r = el.getBoundingClientRect();
        const c = el.firstElementChild?.getBoundingClientRect();
        return [
          r.x,
          r.y,
          r.width,
          r.height,
          c?.x ?? -1,
          c?.y ?? -1,
          c?.width ?? -1,
          c?.height ?? -1,
        ];
      }),
    );

  const todoRow = (page: Page) =>
    page.locator('.column[data-status="todo"] .row-item', {
      has: page.locator('a[href="#/tickets/t1"]'),
    });

  /**
   * 行の位置と大きさが続けて 3 回同じになるまで待って返す。
   * カンバンの見出しは目標・何日目・件数をあとから非同期に出すので、出た直後の行はまだ動くことがあり、
   * 動く前に測った座標で帯を押すと行の本体に当たって詳細へ移る。落ち着かなければ理由を言って短い時間で落とす
   */
  async function settledBox(page: Page, row: Locator, timeout = 5_000) {
    const deadline = Date.now() + timeout;
    let last = "";
    let same = 0;
    for (;;) {
      const box = await row.boundingBox();
      const key = JSON.stringify(box);
      same = box && key === last ? same + 1 : 0;
      last = key;
      if (box && same >= 2) return box;
      if (Date.now() > deadline)
        throw new Error(`行の位置が ${timeout}ms のあいだ落ち着かない（最後に測った位置: ${key}）`);
      await page.waitForTimeout(50);
    }
  }

  /** 描画が落ち着いてから行の左端の帯（6px）を押す */
  async function clickSettledStrip(page: Page, row: Locator): Promise<void> {
    const box = await settledBox(page, row);
    await page.mouse.click(box.x + 6, box.y + box.height / 2);
  }

  it("帯を押すと、その 1 件を選ぶ・外すの切り替えになり、詳細は開かない。行の本体を押すと詳細を開き選択を外す", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    // 外れたときに、テストのタイムアウト（60 秒）まで待たずに理由の分かる失敗にする
    page.setDefaultTimeout(5_000);
    const wait = { timeout: 5_000 };
    const hash = () => new URL(page.url()).hash;
    try {
      await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
      const row = todoRow(page);
      await row.waitFor();
      await clickSettledStrip(page, row);
      await expect
        .poll(() => row.getAttribute("data-selected"), { ...wait, message: "帯を押して選ぶ" })
        .toBe("");
      expect(hash(), "詳細は開かない").toBe("#/board");
      await clickSettledStrip(page, row);
      await expect
        .poll(() => row.getAttribute("data-selected"), {
          ...wait,
          message: "帯をもう一度押して外す",
        })
        .toBeNull();
      expect(hash(), "詳細は開かない").toBe("#/board");

      await clickSettledStrip(page, row);
      await expect
        .poll(() => row.getAttribute("data-selected"), { ...wait, message: "帯を押して選ぶ" })
        .toBe("");
      expect(hash(), "詳細は開かない").toBe("#/board");
      await row.locator('a[href="#/tickets/t1"]').first().click();
      await expect.poll(hash, { ...wait, message: "行の本体は詳細を開く" }).toBe("#/tickets/t1");
      await expect
        .poll(() => row.getAttribute("data-selected"), {
          ...wait,
          message: "詳細を開くと選択は外れる",
        })
        .toBeNull();
    } finally {
      await page.close();
    }
  });

  it("帯は行の余白に重なり、帯の有無で行の位置・大きさと中身の位置が変わらない", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    await todoRow(page).waitFor();
    const withStrip = await layoutOf(page);
    const style = await page.addStyleTag({
      content: "[data-select-id]::before{display:none !important}",
    });
    const withoutStrip = await layoutOf(page);
    await style.evaluate((el) => (el as Element).remove());
    expect(withStrip.length, "選べる行の数").toBeGreaterThan(0);
    expect(withStrip).toEqual(withoutStrip);
    const position = await todoRow(page).evaluate((el) => {
      const before = getComputedStyle(el, "::before");
      return { position: before.position, width: before.width };
    });
    expect(position).toEqual({ position: "absolute", width: "12px" });
    await page.close();
  });

  it("帯の幅は 12px。内側の端（11px）を押すと 1 件を選び、外側（13px）を押すと詳細を開く", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const row = todoRow(page);
    await row.waitFor();
    const inner = await pointAt(row, 11);
    await page.mouse.click(inner.x, inner.y);
    expect(await row.getAttribute("data-selected"), "内側の端（11px）は帯で選ぶ").toBe("");
    expect(new URL(page.url()).hash, "帯では詳細を開かない").toBe("#/board");
    const outer = await pointAt(row, 13);
    await page.mouse.click(outer.x, outer.y);
    // 詳細は押したあとに画面を切り替えるので、着くまで待つ
    await expect.poll(() => new URL(page.url()).hash).toBe("#/tickets/t1");
    await page.close();
  });

  it("hover のある画面では、マウスを載せた行の帯だけ薄く色付く", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const row = todoRow(page);
    await row.waitFor();
    // ほかの行（in_progress の t2）は、載せた行の帯が薄くなっても 0 のまま
    const other = page.locator('.column[data-status="in_progress"] .row-item', {
      has: page.locator('a[href="#/tickets/t2"]'),
    });
    await other.waitFor();
    await page.mouse.move(0, 0);
    expect(await stripOpacity(row), "載せていないときは透明").toBe("0");
    expect(await stripOpacity(other), "載せていないときは透明（ほかの行）").toBe("0");
    await row.hover({ position: { x: 3, y: 5 } });
    expect(parseFloat(await stripOpacity(row)), "載せたとき薄く色付く").toBeGreaterThan(0);
    expect(await stripOpacity(other), "載せていないほかの行の帯は 0 のまま").toBe("0");
    await page.close();
  });

  it("hover のない画面（タッチ）では、帯を常に薄く色付け、選んだ行は今の選択の色（不透明）で出す", async () => {
    // タッチの画面は、タッチの文脈（hasTouch・isMobile）で開く。CDP の media の上書きでは hover: none にならない
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const row = todoRow(page);
    await row.waitFor();
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await page.mouse.move(0, 0);
    expect(await stripOpacity(row), "載せていなくても薄く色付く").toBe("0.35");
    await clickStrip(page, row);
    expect(await stripOpacity(row), "選んだ行は不透明").toBe("1");
    await context.close();
  });
});

describe("行の左端の帯をなぞって、通った行をまとめて選ぶ（UI-15）", () => {
  type Point = { x: number; y: number };
  /** 画面に出ている選べる行（畳んだ節の中は高さ 0 なので除く）。並びは画面の順 */
  type Row = { id: string; x: number; y: number; height: number };
  /** 行の左端の帯を押す点（帯の幅 12px の真ん中の 6px、行の高さの真ん中） */
  const stripOf = (row: Row) => ({ x: row.x + 6, y: row.y + row.height / 2 });

  const visibleRows = (rows: Locator) =>
    rows.evaluateAll((els) =>
      els.flatMap((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0
          ? [{ id: el.getAttribute("data-select-id")!, x: r.x, y: r.y, height: r.height }]
          : [];
      }),
    ) as Promise<Row[]>;

  /** 選んでいる行の ID（画面の順） */
  const selectedIn = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-selected]")].map((el) =>
        el.getAttribute("data-select-id"),
      ),
    );

  /** 行の縦スクロールの容器（selection.tsx の scrollerOf と同じ決め方。なければ画面全体）の位置と送り */
  const scrollerOf = (row: Locator) =>
    row.evaluate((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) {
          const r = p.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            scrollTop: p.scrollTop,
            max: p.scrollHeight - p.clientHeight,
          };
        }
      }
      return {
        top: 0,
        bottom: window.innerHeight,
        scrollTop: window.scrollY,
        max: document.documentElement.scrollHeight - window.innerHeight,
      };
    });

  /** マウスで from を押したまま to まで動かし、ms のあいだ止めてから離す（端で止めると自動スクロールが送り続ける） */
  async function sweepMouse(page: Page, from: Point, to: Point, ms = 0): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    if (ms > 0) await page.waitForTimeout(ms);
    await page.mouse.up();
  }

  /** 押すと 1 件を選ぶ・外す（帯のクリック） */
  async function clickStrip(page: Page, row: Row): Promise<void> {
    const p = stripOf(row);
    await page.mouse.click(p.x, p.y);
  }

  const boardRows = (page: Page) => page.locator('.column[data-status="todo"] [data-select-id]');

  beforeAll(async () => {
    for (let i = 1; i <= 16; i++)
      await call("ticket.create", { title: `なぞる ${i}`, iteration: "s1" });
    // 履歴の行に出すため、終えたチケットを 5 件作る
    for (let i = 1; i <= 5; i++) {
      const done = await call<{ id: string }>("ticket.create", {
        title: `終えた ${i}`,
        iteration: "s1",
      });
      await call("ticket.move", { ticket: done.id, status: "done" });
    }
  }, 120_000);

  /** t703 と同じ 4 か所（カンバン・バックログ・詳細の中の行・履歴）で、なぞると間の行を選ぶ */
  const PLACES: {
    name: string;
    query: string;
    hash: string;
    width: number;
    rows: (page: Page) => Locator;
  }[] = [
    {
      name: "カンバン",
      query: "?surface=sidebar",
      hash: "#/board",
      width: WIDTH,
      rows: boardRows,
    },
    {
      name: "バックログ",
      query: "?surface=sidebar",
      hash: "#/backlog",
      width: WIDTH,
      rows: (page) =>
        page.locator(".backlog-section").filter({ hasText: "今週" }).locator("[data-select-id]"),
    },
    {
      name: "Iteration の詳細の中の行",
      query: "?surface=panel",
      hash: "#/iterations/s1",
      width: PANEL_WIDTH,
      rows: (page) => page.locator(".ticket-sections [data-select-id]"),
    },
    {
      name: "履歴",
      query: "?surface=sidebar",
      // 終えたチケットの一覧（履歴の見方の「チケット」）。Iteration の節は閉じた Iteration だけなので、ここで見る
      hash: "#/history?view=ticket",
      width: WIDTH,
      rows: (page) => page.locator("[data-select-id]"),
    },
  ];

  for (const place of PLACES) {
    it(`${place.name}：帯を押したまま上下になぞると、通った行をまとめて選ぶ。詳細は開かない`, async () => {
      const page = await browser.newPage({ viewport: { width: place.width, height: 800 } });
      await page.goto(`${server.url}${place.query}${place.hash}`, { waitUntil: "networkidle" });
      const rows = await visibleRows(place.rows(page));
      expect(rows.length, "なぞる行の数").toBeGreaterThanOrEqual(5);
      await sweepMouse(page, stripOf(rows[1]!), stripOf(rows[3]!));
      expect(await selectedIn(page)).toEqual(rows.slice(1, 4).map((row) => row.id));
      expect(new URL(page.url()).hash, "詳細は開かない").toBe(place.hash);
      await page.close();
    });
  }

  it("選んである行の帯からなぞり始めると、通った行を外す", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const rows = await visibleRows(boardRows(page));
    const picked = [0, 2, 3, 4].map((i) => rows[i]!);
    for (const row of picked) await clickStrip(page, row);
    expect(await selectedIn(page)).toEqual(picked.map((row) => row.id));
    await sweepMouse(page, stripOf(rows[2]!), stripOf(rows[4]!));
    expect(await selectedIn(page), "通った行（2 から 4）を外す").toEqual([rows[0]!.id]);
    await page.close();
  });

  it("行の本体（帯の外）から始めたなぞりでは行を選ばない", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const rows = await visibleRows(boardRows(page));
    const body = { x: rows[1]!.x + 30, y: rows[1]!.y + rows[1]!.height / 2 };
    await sweepMouse(page, body, stripOf(rows[3]!));
    expect(await selectedIn(page)).toEqual([]);
    await page.close();
  });

  it("ペンで帯をなぞっても、通った行をまとめて選ぶ", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const rows = await visibleRows(boardRows(page));
    const cdp = await page.context().newCDPSession(page);
    const from = stripOf(rows[1]!);
    const to = stripOf(rows[3]!);
    const pen = { button: "left" as const, pointerType: "pen" as const };
    await cdp.send("Input.dispatchMouseEvent", {
      ...pen,
      type: "mousePressed",
      x: from.x,
      y: from.y,
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        ...pen,
        type: "mouseMoved",
        x: from.x,
        y: from.y + ((to.y - from.y) * i) / 10,
        buttons: 1,
      });
    }
    await cdp.send("Input.dispatchMouseEvent", {
      ...pen,
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      buttons: 0,
      clickCount: 1,
    });
    expect(await selectedIn(page)).toEqual(rows.slice(1, 4).map((row) => row.id));
    await page.close();
  });

  it("タッチで帯をなぞっても選ばず、一覧のスクロールになる", async () => {
    // タッチの画面は、タッチの文脈（hasTouch・isMobile）で開く
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: 480 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const rows = await visibleRows(boardRows(page));
    // 画面の下のほうの行の帯から、指を上へ動かす（一覧は下へ送られる）
    const start = stripOf(rows.filter((row) => row.y < 400).at(-1)!);
    const before = await scrollerOf(boardRows(page).first());
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x, y: start.y - ((start.y - 20) * i) / 12 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    expect(await selectedIn(page), "タッチでは選ばない").toEqual([]);
    expect(
      (await scrollerOf(boardRows(page).first())).scrollTop,
      "一覧がスクロールした",
    ).toBeGreaterThan(before.scrollTop);
    await context.close();
  });

  it("一覧の下端に来ると下へスクロールし、見えている範囲の外の行まで続けて選べる", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 480 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const rows = await visibleRows(boardRows(page));
    const last = rows.at(-1)!;
    expect(last.y, "最後の行は画面の外にある").toBeGreaterThan(480);
    const scroller = await scrollerOf(boardRows(page).first());
    await sweepMouse(page, stripOf(rows[0]!), { x: 3, y: scroller.bottom - 4 }, 1500);
    const selected = await selectedIn(page);
    expect(selected, "画面の外の最後の行まで選ぶ").toContain(last.id);
    expect((await scrollerOf(boardRows(page).first())).scrollTop).toBeGreaterThan(0);
    await page.close();
  });

  it("一覧の上端に来ると上へスクロールし、見えていない上の行まで続けて選べる", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 480 } });
    await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
    const rows = await visibleRows(boardRows(page));
    // 先に一覧を下へ送っておき、最初の行が画面の外に出るようにする
    await boardRows(page)
      .last()
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(100);
    const after = await visibleRows(boardRows(page));
    const first = after.find((row) => row.id === rows[0]!.id)!;
    expect(first.y, "最初の行は画面の外にある").toBeLessThan(0);
    const from = after.filter((row) => row.y > 0 && row.y < 440).at(-1)!;
    const scroller = await scrollerOf(boardRows(page).first());
    await sweepMouse(page, stripOf(from), { x: 3, y: scroller.top + 4 }, 1500);
    expect(await selectedIn(page), "画面の外の最初の行まで選ぶ").toContain(rows[0]!.id);
    await page.close();
  });
});
