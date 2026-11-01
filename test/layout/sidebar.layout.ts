// 画面の配置の確認（t58）。dg serve の画面を Chromium で ?surface=sidebar の配置で開き、
// サイドバーの幅（300px・260px）とライト・ダークで、横スクロールが出ないことと、文字が決めた行数に収まることを確かめる。
// 行数の基準：
// - タブ（nav a）と、チケットの行でない行のタイトル（Epic・Run など .row-title）は 1 行。折り返してはいけない
// - チケットの行のタイトル（.ticket-row .row-title）は 2 行まで。サイドバーでは 2 行で切る CSS（-webkit-line-clamp: 2）なので、3 行以上は崩れ
// 行数は要素の枠の中に見えている行だけを数える（2 行で切られて隠れた行は数えない）
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
const WIDTHS = [300, 260];
const SCHEMES = ["light", "dark"] as const;
/** サイドバーで出す画面。履歴は閉じた Iteration の行を、Run は実行中と完了した Run を出す */
const PAGES = ["#/board", "#/backlog", "#/epics/e1", "#/history", "#/runs"];
const LONG = "サイドバーの配置を確かめるための、かなり長めのタイトルのチケット";

let fixture: Fixture;
let server: { url: string; close(): Promise<void> };
let browser: Browser;

async function call(name: string, input: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${server.url}api/commands/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  const body = (await res.json()) as { ok: boolean; data?: unknown; error?: unknown };
  if (!body.ok) throw new Error(`${name} が失敗した: ${JSON.stringify(body.error)}`);
  return body.data;
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
  // 閉じた Iteration（履歴）・進行中の Iteration・長い名前の Epic と、状態の揃ったチケット
  await call("iteration.create", { name: "終わった週" });
  await call("iteration.start", { iteration: "s1" });
  await call("iteration.close", { iteration: "s1" });
  await call("iteration.create", { name: "今週" });
  await call("iteration.start", { iteration: "s2" });
  await call("epic.create", {
    title: "とても長い名前の Epic：サイドバーの幅で省略されるかを確かめる",
  });
  for (let i = 1; i <= 6; i++) {
    await call("ticket.create", {
      title: `${LONG}番号 ${i} です`,
      acceptance: ["a"],
      iteration: "s2",
      epic: "e1",
      priority: "high",
      labels: ["ui", "web"],
    });
  }
  await call("ticket.claim", { ticket: "t1", without_branch: true });
  await call("ticket.move", { ticket: "t2", status: "review" });
  await call("ticket.move", { ticket: "t3", status: "done" });
  await call("ticket.move", { ticket: "t4", status: "abandoned" });
  await call("run.start", { ticket: "t1", step: "implement", agent: "claude-code" });
  const done = (await call("run.start", {
    ticket: "t3",
    step: "implement",
    agent: "claude-code",
  })) as {
    id: string;
  };
  await call("run.finish", { run: done.id, result: "success" });
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
 * 画面の幅と、決めた行数に収まらない要素を集める。
 * 行は「文字の矩形が、今の行の下端より下から始まったら次の行」で数える（大きさの違う文字が並んでも上端のずれで誤らない）。
 * 要素の枠の下端より下にある矩形は、切られて見えない行なので数えない
 */
function measure(page: Page) {
  return page.evaluate(() => {
    const lineCount = (el: Element) => {
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()]
        .filter((r) => r.width > 0 && r.top < box.bottom - 1)
        .sort((a, b) => a.top - b.top);
      let lines = 0;
      let bottom = -Infinity;
      for (const r of rects) {
        if (r.top >= bottom - 1) {
          lines++;
          bottom = r.bottom;
        } else bottom = Math.max(bottom, r.bottom);
      }
      return lines;
    };
    const overflowing = (selector: string, max: number) =>
      [...document.querySelectorAll(selector)]
        .filter((el) => lineCount(el) > max)
        .map((el) => `${selector}（${max} 行まで）: ${el.textContent?.slice(0, 20)}`);
    const style = getComputedStyle(document.body);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      tabs: document.querySelectorAll("nav a").length,
      rows: document.querySelectorAll(".row").length,
      wrapped: [
        ...overflowing("nav a", 1),
        ...overflowing(".row-title:not(.ticket-row .row-title)", 1),
        ...overflowing(".ticket-row .row-title", 2),
      ],
      /** 2 行まで折り返したチケットの行のタイトルの数（長いタイトルで 2 行に折り返すことを確かめる） */
      twoLineTitles: [...document.querySelectorAll(".ticket-row .row-title")].filter(
        (el) => lineCount(el) === 2,
      ).length,
      background: style.backgroundColor,
      color: style.color,
    };
  });
}

describe.each(SCHEMES)("サイドバーの配置（%s）", (scheme) => {
  it.each(WIDTHS)(
    "幅 %ipx で、どの画面も横スクロールが出ず、タブは 1 行、チケットの行のタイトルは 2 行までに収まる",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        for (const hash of PAGES) {
          await page.goto(`${server.url}?surface=sidebar${hash}`, { waitUntil: "networkidle" });
          await page.locator("nav a").first().waitFor();
          // 読み込み中が終わるのを待つ（カンバンとバックログはチケットの行が出る）
          if (hash === "#/board" || hash === "#/backlog")
            await page.locator(".row").first().waitFor();
          const m = await measure(page);
          if (m.scrollWidth > m.clientWidth || m.wrapped.length > 0) {
            // 崩れた画面は後から見られるように残す（.gitignore の .playwright-mcp/）
            await page.screenshot({
              path: `.playwright-mcp/layout-${scheme}-${width}-${hash.replace(/\W+/g, "_")}.png`,
              fullPage: true,
            });
          }
          expect(m.scrollWidth, `${hash} の横スクロール`).toBeLessThanOrEqual(m.clientWidth);
          expect(m.tabs, `${hash} のタブ`).toBe(4);
          expect(m.wrapped, `${hash} で決めた行数を超えた要素`).toEqual([]);
          // カンバンの長いタイトルは 2 行に折り返す（1 行で切る CSS に戻ったら気づけるように）
          if (hash === "#/board")
            expect(m.twoLineTitles, `${hash} で 2 行に折り返したタイトル`).toBeGreaterThan(0);
          expect(m.color, `${hash} の文字と背景の色`).not.toBe(m.background);
        }
      } finally {
        await context.close();
      }
    },
  );
});

it("ライトとダークで背景の色が変わる（prefers-color-scheme が効いている）", async () => {
  const colors: string[] = [];
  for (const scheme of SCHEMES) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${server.url}?surface=sidebar#/board`);
    await page.locator("nav a").first().waitFor();
    colors.push((await measure(page)).background);
    await context.close();
  }
  expect(colors[0]).not.toBe(colors[1]);
});
