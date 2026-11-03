// 画面の配置の確認（t58）。dg serve の画面を Chromium で ?surface=sidebar の配置で開き、
// サイドバーの幅（300px・260px）とライト・ダークで、横スクロールが出ないことと、文字が決めた行数に収まることを確かめる。
// 行数の基準：
// - タブ（nav a）、カンバンの見出し、チケットの行でない行のタイトル（Epic など .row-title）は 1 行。折り返してはいけない
//   カンバンの見出しは、Iteration の見出し（.sidebar-head .head-line：札の列・漏斗の段、名前・期間・目標の段、進みの帯の段）と
//   状態の節の見出し（.column summary h2）、履歴の見方の切り替え（.view-switch）
// - ほかの画面の見出し（バックログ・履歴の summary、Epic の h2 など）は検査しない
// - チケットの行のタイトル（.ticket-row .row-title）は 2 行まで。サイドバーでは 2 行で切る CSS（-webkit-line-clamp: 2）なので、3 行以上は崩れ
// 行数は要素の枠の中に見えている行だけを数える（2 行で切られて隠れた行は数えない）
// カンバンの行の右端（担当の印・Plan の番号など）は、行の枠からはみ出さず、タイトルと重ならないことも確かめる
// 設定画面（#/config）は、確認の帯を開き、長い worktree.root と actions.test のリストを入れた状態で、部品が幅からはみ出さないことを別に確かめる
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
/**
 * サイドバーで出す画面。履歴は閉じた Iteration の行（目標の長いものを含む）を出す。
 * Run の画面はブラウザだけに置き、左パネルには出さない（UI-9・UI-12。#/runs はカンバンとして開く）ので含めない
 */
const PAGES = ["#/board", "#/backlog", "#/epics/e1", "#/history"];
/** 左パネルのタブの数（カンバン・バックログ・履歴。Run のタブは出さない。UI-12） */
const SIDEBAR_TABS = 3;
const LONG = "サイドバーの配置を確かめるための、かなり長めのタイトルのチケット";

/** 設定画面の長い worktree.root。区切り（空白）がないので、折り返せないと横にはみ出す */
const LONG_ROOT =
  "../deguboard-layout-check-repository.worktrees/a-very-long-directory-name-without-any-spaces";
const TEST_COMMAND = ["mise", "run", "check", "--", "--reporter=verbose", "packages/web/src/pages"];

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
  // 閉じた Iteration（履歴）・進行中の Iteration・長い名前の Epic と、状態の揃ったチケット。
  // ほかの Iteration を始める前に active のものを閉じる（IT-1）
  await call("iteration.create", { name: "終わった週" });
  await call("iteration.start", { iteration: "s1" });
  await call("iteration.close", { iteration: "s1" });
  // s2 は作るだけにし、s8 を閉じた後に始める（active の Iteration は Project に 1 つ。IT-1）
  await call("iteration.create", { name: "今週" });
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
  // 作業中の多い Plan（実行計画の帯の 2 行目が長くなる）：t1・t7〜t11 が作業中、t12 が t7・t8・t9 を待つ
  for (let i = 7; i <= 12; i++) {
    await call("ticket.create", { title: `計画のチケット ${i}`, iteration: "s2" });
  }
  for (const id of ["t7", "t8", "t9", "t10", "t11"]) {
    await call("ticket.move", { ticket: id, status: "in_progress" });
  }
  await call("plan.create", {
    tickets: ["t1", "t7", "t8", "t9", "t10", "t11", "t12"],
    after: { t12: ["t7", "t8", "t9"] },
  });
  await call("plan.approve", { plan: "p1" });
  // 担当の印（t1 は人、t7 は Codex の Run の agent、t8 は Run のない agent、t10 は汎用の agent）
  await call("ticket.update", { ticket: "t7", assignee: "agent" });
  await call("run.start", { ticket: "t7", step: "implement", agent: "codex" });
  await call("ticket.update", { ticket: "t8", assignee: "agent" });
  await call("ticket.update", { ticket: "t10", assignee: "agent" });
  await call("run.start", { ticket: "t10", step: "implement", agent: "my-bot" });
  // 予定の Iteration を足し、見出しの札の列が幅に入らず横にスクロールするようにする（s3〜s7）
  for (let i = 3; i <= 7; i++) await call("iteration.create", { name: `予定の週 ${i}` });
  // 目標の長い閉じた Iteration（s8）：完了・中止・持ち越しのチップがすべて出る履歴の行
  await call("iteration.create", {
    name: "sprint8",
    goal: "左パネルを主画面にして、カンバンとバックログと履歴をサイドバーの幅で使えるようにする",
  });
  for (let i = 13; i <= 15; i++)
    await call("ticket.create", { title: `閉じた週のチケット ${i}`, iteration: "s8" });
  await call("iteration.start", { iteration: "s8" });
  await call("ticket.move", { ticket: "t13", status: "done" });
  await call("ticket.move", { ticket: "t14", status: "abandoned" });
  await call("iteration.close", { iteration: "s8" });
  await call("iteration.start", { iteration: "s2" });
  // 設定画面：長い worktree.root（区切りのない長いパス）と、項目の多い actions.test
  await call("config.set", { key: "worktree.root", value: LONG_ROOT });
  await call("config.set", { key: "actions.test", value: TEST_COMMAND });
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
      /** 1 行の検査をするカンバンの見出しの数。種類ごとに分けて数え、クラス名が変わって検査が黙って消えないようにする */
      headLines: document.querySelectorAll(".sidebar-head .head-line").length,
      sectionHeadings: document.querySelectorAll(".column summary h2").length,
      viewSwitches: document.querySelectorAll(".view-switch").length,
      wrapped: [
        ...overflowing("nav a", 1),
        ...overflowing(".sidebar-head .head-line", 1),
        ...overflowing(".column summary h2", 1),
        ...overflowing(".view-switch", 1),
        ...overflowing(".row-title:not(.ticket-row .row-title)", 1),
        ...overflowing(".ticket-row .row-title", 2),
      ],
      /** 担当の印の数（検査が黙って消えないように数える） */
      assigneeMarks: document.querySelectorAll(".kanban-row .assignee-mark").length,
      /** 右端が行の枠からはみ出すか、タイトルと重なるカンバンの行 */
      rowEndClashes: [...document.querySelectorAll(".kanban-row")].flatMap((row) => {
        const end = row.querySelector(".row-end")?.getBoundingClientRect();
        const title = row.querySelector(".row-title")?.getBoundingClientRect();
        if (!end || !title) return [];
        const box = row.getBoundingClientRect();
        const outside = end.right > box.right + 0.5 || end.left < box.left - 0.5;
        const overlap = end.left < title.right - 0.5 && title.left < end.right - 0.5;
        return outside || overlap ? [`${row.querySelector("code")?.textContent}`] : [];
      }),
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
    "幅 %ipx で、どの画面も横スクロールが出ず、タブ・見出し・チケットでない行のタイトルは 1 行、チケットの行のタイトルは 2 行までに収まる",
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
          expect(m.tabs, `${hash} のタブ`).toBe(SIDEBAR_TABS);
          expect(m.wrapped, `${hash} で決めた行数を超えた要素`).toEqual([]);
          // カンバンの長いタイトルは 2 行に折り返す（1 行で切る CSS に戻ったら気づけるように）
          if (hash === "#/board") {
            expect(m.twoLineTitles, `${hash} で 2 行に折り返したタイトル`).toBeGreaterThan(0);
            expect(m.headLines, `${hash} の Iteration の見出しの段`).toBeGreaterThan(0);
            expect(m.sectionHeadings, `${hash} の状態の節の見出し`).toBeGreaterThan(0);
            expect(m.assigneeMarks, `${hash} の担当の印`).toBeGreaterThanOrEqual(4);
            expect(m.rowEndClashes, `${hash} で右端がはみ出すか重なる行`).toEqual([]);
          }
          if (hash === "#/history") expect(m.viewSwitches, `${hash} の見方の切り替え`).toBe(1);
          expect(m.color, `${hash} の文字と背景の色`).not.toBe(m.background);
        }
      } finally {
        await context.close();
      }
    },
  );
});

// データの件数は 1〜2 桁なので、3 桁の件数を検索中に出したとき（「177 / 208」など）の幅はここでは試していない
describe.each(SCHEMES)("履歴の見方の切り替え（%s）", (scheme) => {
  it.each([320, ...WIDTHS])(
    "幅 %ipx で、どの見方でも検索中（バッジが「当たった数 / 全体」）でも、切り替えが折り返さず画面から溢れない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        for (const view of ["iteration", "epic", "ticket"]) {
          await page.goto(`${server.url}?surface=sidebar#/history?view=${view}`, {
            waitUntil: "networkidle",
          });
          const toggle = page.locator(".view-switch");
          await toggle.waitFor();
          for (const query of ["", "番号"]) {
            await page.getByLabel("チケットを探す").fill(query);
            const m = await toggle.evaluate((el) => {
              const buttons = [...el.querySelectorAll("button")].map((b) =>
                b.getBoundingClientRect(),
              );
              // .page は overflow: auto なので、はみ出しは文書の横スクロールに出ず隠れる。.page の中身の右端と比べる
              const main = document.querySelector(".page")!;
              const right = main.getBoundingClientRect().right;
              return {
                texts: [...el.querySelectorAll("button")].map((b) => b.textContent),
                tops: new Set(buttons.map((b) => Math.round(b.top))).size,
                right: Math.max(...buttons.map((b) => b.right)),
                width: right - parseFloat(getComputedStyle(main).paddingRight),
                pageScroll: main.scrollWidth,
                pageClient: main.clientWidth,
              };
            });
            const label = `${view}・検索「${query}」`;
            expect(m.texts, `${label} のボタン`).toHaveLength(3);
            if (query)
              for (const t of m.texts)
                expect(t, `${label} のバッジ`).toMatch(/\d+\u2009\/\u2009\d+$/);
            expect(m.tops, `${label} で折り返していない`).toBe(1);
            // 300px 以上では全体が見える。それより狭いと切り替えの中だけが横にスクロールし、画面は横に溢れない
            if (width >= 300) expect(m.right, `${label} で幅に収まる`).toBeLessThanOrEqual(m.width);
            expect(m.pageScroll, `${label} で画面が横に溢れない`).toBeLessThanOrEqual(m.pageClient);
          }
        }
      } finally {
        await context.close();
      }
    },
  );
});

describe.each(SCHEMES)("履歴のチケットの見方の絞り込み（%s）", (scheme) => {
  it.each([320, 300])(
    "幅 %ipx で、検索欄と結果の絞り込みが 1 行に収まり、画面から溢れない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/history?view=ticket`, {
          waitUntil: "networkidle",
        });
        const filter = page.locator(".history-filter");
        await filter.waitFor();
        await page.locator(".history-ticket").first().waitFor();
        const m = await filter.evaluate((el) => {
          const search = el.querySelector('input[type="search"]')!.getBoundingClientRect();
          const select = el.querySelector("select")!.getBoundingClientRect();
          const main = document.querySelector(".page")!;
          const right = main.getBoundingClientRect().right;
          return {
            selects: document.querySelectorAll(".toolbar select").length,
            sameLine: select.top < search.bottom && search.top < select.bottom,
            searchWidth: search.width,
            right: Math.max(search.right, select.right),
            width: right - parseFloat(getComputedStyle(main).paddingRight),
            pageScroll: main.scrollWidth,
            pageClient: main.clientWidth,
          };
        });
        expect(m.selects, "絞り込みは結果のセレクトだけ").toBe(1);
        expect(m.sameLine, "検索欄と結果の絞り込みが 1 行").toBe(true);
        expect(m.searchWidth, "検索欄が潰れない").toBeGreaterThan(100);
        expect(m.right, "幅に収まる").toBeLessThanOrEqual(m.width + 0.5);
        expect(m.pageScroll, "画面が横に溢れない").toBeLessThanOrEqual(m.pageClient);
      } finally {
        await context.close();
      }
    },
  );
});

describe.each(SCHEMES)("履歴の Iteration の行（%s）", (scheme) => {
  it.each([320, ...WIDTHS])(
    "幅 %ipx で、目標は 2 行までで、件数のチップが行の枠からはみ出さず目標と重ならない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/history`, { waitUntil: "networkidle" });
        const row = page.locator(".history-row", { hasText: "sprint8" });
        await row.waitFor();
        const m = await row.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const name = el.querySelector(".name")!;
          const nameBox = name.getBoundingClientRect();
          const chips = [...el.querySelectorAll(".counts .badge")].map((b) =>
            b.getBoundingClientRect(),
          );
          const main = document.querySelector(".page")!;
          return {
            chips: [...el.querySelectorAll(".counts .badge")].map((b) => b.textContent),
            // 見えている行の数：文字の矩形の上端のうち、枠の中にあるものを数える
            nameLines: (() => {
              const range = document.createRange();
              range.selectNodeContents(name);
              const tops = [...range.getClientRects()]
                .filter((r) => r.top < nameBox.bottom - 1)
                .map((r) => Math.round(r.top));
              return new Set(tops).size;
            })(),
            chipsInside: chips.every((c) => c.left >= box.left && c.right <= box.right + 0.5),
            chipsBelowName: chips.every((c) => c.top >= nameBox.bottom - 0.5),
            pageScroll: main.scrollWidth,
            pageClient: main.clientWidth,
          };
        });
        expect(m.chips).toEqual(["完了 1", "中止 1", "持ち越し 1"]);
        expect(m.nameLines, "目標が見えている").toBeGreaterThan(0);
        expect(m.nameLines, "目標は 2 行まで").toBeLessThanOrEqual(2);
        expect(m.chipsInside, "チップが行の枠に収まる").toBe(true);
        expect(m.chipsBelowName, "チップが目標と重ならない").toBe(true);
        expect(m.pageScroll, "画面が横に溢れない").toBeLessThanOrEqual(m.pageClient);
      } finally {
        await context.close();
      }
    },
  );
});

describe.each(SCHEMES)("実行計画の帯（%s）", (scheme) => {
  it.each(WIDTHS)(
    "幅 %ipx で、作業中の多い Plan の 2 行目が折り返して横に溢れず、番号と文字が重ならない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
        await page.locator(".plan-sub").first().waitFor();
        const m = await page.evaluate(() => {
          const sub = document.querySelector(".plan-sub")!;
          const main = document.querySelector(".page")!;
          // 2 行目の文字の塊（番号・見出し・「待ち」）。どの 2 つも重ならないこと
          const parts = [
            ...sub.querySelectorAll("code, .plan-sub-label, .plan-wait > span:last-child"),
          ].map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }));
          const overlaps: string[] = [];
          for (let i = 0; i < parts.length; i++) {
            for (let j = i + 1; j < parts.length; j++) {
              const a = parts[i]!.r;
              const b = parts[j]!.r;
              const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (x > 0.5 && y > 0.5) overlaps.push(`${parts[i]!.text} と ${parts[j]!.text}`);
            }
          }
          return {
            text: sub.textContent,
            subScroll: sub.scrollWidth,
            subClient: sub.clientWidth,
            pageScroll: main.scrollWidth,
            pageClient: main.clientWidth,
            docScroll: document.documentElement.scrollWidth,
            docClient: document.documentElement.clientWidth,
            overlaps,
          };
        });
        if (m.overlaps.length > 0 || m.subScroll > m.subClient || m.pageScroll > m.pageClient) {
          await page.screenshot({
            path: `.playwright-mcp/layout-plan-band-${scheme}-${width}.png`,
            fullPage: true,
          });
        }
        expect(m.text).toBe("作業中t1t7t8t9t10t11次t12t7t8t9待ち");
        expect(m.subScroll, "2 行目の横の溢れ").toBeLessThanOrEqual(m.subClient);
        expect(m.pageScroll, "画面（.page）の横スクロール").toBeLessThanOrEqual(m.pageClient);
        expect(m.docScroll, "文書の横スクロール").toBeLessThanOrEqual(m.docClient);
        expect(m.overlaps, "重なった文字").toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});

describe.each(SCHEMES)("状態の節と実行計画の帯の見出し（%s）", (scheme) => {
  it.each(WIDTHS)(
    "幅 %ipx で、見出しは大文字にせず帯と同じ文字の形で、件数を塗るのは終わっていない節だけ。名前と件数が重ならない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
        await page.locator(".plan-band-head").waitFor();
        const m = await page.evaluate(() => {
          const shape = (el: Element) => {
            const s = getComputedStyle(el);
            return `${s.textTransform} ${s.fontSize} ${s.fontWeight} ${s.letterSpacing}`;
          };
          const sections = [...document.querySelectorAll("details.column")].map((d) => {
            const h2 = d.querySelector("summary h2")!;
            const label = h2.querySelector("span:not(.status-dot):not(.section-count)")!;
            const count = h2.querySelector(".section-count")!;
            const a = label.getBoundingClientRect();
            const b = count.getBoundingClientRect();
            return {
              status: d.getAttribute("data-status"),
              shape: shape(h2),
              painted: getComputedStyle(count).backgroundColor !== "rgba(0, 0, 0, 0)",
              overlap: a.right > b.left + 0.5 || b.right > h2.getBoundingClientRect().right + 0.5,
            };
          });
          return { band: shape(document.querySelector(".plan-band-head")!), sections };
        });
        expect(m.sections.map((s) => s.status)).toEqual([
          "todo",
          "in_progress",
          "review",
          "done",
          "abandoned",
        ]);
        for (const s of m.sections) {
          expect(s.shape, `${s.status} の見出しの文字の形`).toBe(m.band);
          expect(s.overlap, `${s.status} の名前と件数の重なり`).toBe(false);
        }
        expect(m.band.startsWith("none "), "見出しを大文字に変えない").toBe(true);
        expect(Object.fromEntries(m.sections.map((s) => [s.status, s.painted]))).toEqual({
          todo: true,
          in_progress: true,
          review: true,
          done: false,
          abandoned: false,
        });
      } finally {
        await context.close();
      }
    },
  );
});

describe.each(SCHEMES)("Iteration の札の列（%s）", (scheme) => {
  it.each(WIDTHS)(
    "幅 %ipx で、札が幅に入らないときは札の列だけが横にスクロールし、選んでいる札が列の見える範囲にある",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        // 既定（active の s2）と、列の両端にある札（先頭の すべて・最後の Iteration の s7）を選んだとき
        for (const [query, label] of [
          ["", "s2"],
          ["?iteration=s7", "s7"],
          ["?iteration=*", "すべて"],
        ] as const) {
          await page.goto(`${server.url}?surface=sidebar#/board${query}`, {
            waitUntil: "networkidle",
          });
          await page.locator(".iteration-chip[aria-pressed=true]").waitFor();
          const m = await page.evaluate(() => {
            const strip = document.querySelector(".iteration-chips")!;
            const chip = strip.querySelector('[aria-pressed="true"]')!;
            const main = document.querySelector(".page")!;
            const s = strip.getBoundingClientRect();
            const c = chip.getBoundingClientRect();
            return {
              chips: strip.querySelectorAll(".iteration-chip").length,
              selected: chip.textContent,
              stripScroll: strip.scrollWidth,
              stripClient: strip.clientWidth,
              visible: c.left >= s.left - 0.5 && c.right <= s.right + 0.5,
              pageScroll: main.scrollWidth,
              pageClient: main.clientWidth,
              docScroll: document.documentElement.scrollWidth,
              docClient: document.documentElement.clientWidth,
            };
          });
          if (!m.visible || m.pageScroll > m.pageClient || m.docScroll > m.docClient) {
            await page.screenshot({
              path: `.playwright-mcp/layout-iteration-chips-${scheme}-${width}-${label}.png`,
              fullPage: true,
            });
          }
          // すべて・s2〜s7・+ の 8 枚
          expect(m.chips, `${label} の札の数`).toBe(8);
          expect(m.selected, "選んでいる札").toMatch(new RegExp(`^${label}`));
          expect(m.stripScroll, "札の列が幅に入らない").toBeGreaterThan(m.stripClient);
          expect(m.visible, `${label} の札が列の見える範囲にある`).toBe(true);
          expect(m.pageScroll, "画面（.page）の横スクロール").toBeLessThanOrEqual(m.pageClient);
          expect(m.docScroll, "文書の横スクロール").toBeLessThanOrEqual(m.docClient);
        }
      } finally {
        await context.close();
      }
    },
  );
});

describe.each(SCHEMES)("設定画面（%s）", (scheme) => {
  it.each(WIDTHS)(
    "幅 %ipx で、確認の帯を開いても、長い worktree.root と actions.test のリストがあっても横にはみ出さない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/config`, { waitUntil: "networkidle" });
        const root = page.locator('[data-key="worktree.root"] input[type="text"]');
        await root.waitFor();
        // 長い値のまま、確認の帯を開く（保存はしない）
        await root.fill(`${LONG_ROOT}/next`);
        await root.blur();
        await page.locator(".config-confirm").waitFor();
        const m = await page.evaluate(() => {
          const main = document.querySelector(".page")!;
          const box = main.getBoundingClientRect();
          const right = box.right - parseFloat(getComputedStyle(main).paddingRight);
          // 項目の中の部品が .page の中身の幅から右にはみ出していないか
          const outside = [
            ...document.querySelectorAll(
              ".config-field, .config-field input, .config-field select, .config-list-item, .config-confirm, .config-confirm code, .config-confirm button",
            ),
          ]
            .filter((el) => el.getBoundingClientRect().right > right + 0.5)
            .map((el) => `${el.className || el.tagName}: ${el.textContent?.slice(0, 20)}`);
          return {
            tabs: document.querySelectorAll("nav a").length,
            fields: document.querySelectorAll(".config-field").length,
            listItems: document.querySelectorAll('[data-key="actions.test"] .config-list-item')
              .length,
            confirm: document.querySelector(".config-confirm")?.textContent ?? "",
            outside,
            pageScroll: main.scrollWidth,
            pageClient: main.clientWidth,
            docScroll: document.documentElement.scrollWidth,
            docClient: document.documentElement.clientWidth,
          };
        });
        if (m.outside.length > 0 || m.pageScroll > m.pageClient || m.docScroll > m.docClient) {
          await page.screenshot({
            path: `.playwright-mcp/layout-config-${scheme}-${width}.png`,
            fullPage: true,
          });
        }
        // 設定画面でもサイドバーのタブ（カンバン・バックログ・履歴）は出したまま
        expect(m.tabs, "タブ").toBe(SIDEBAR_TABS);
        expect(m.fields, "設定の項目").toBeGreaterThan(10);
        expect(m.listItems, "actions.test の項目").toBe(TEST_COMMAND.length);
        expect(m.confirm, "確認の帯に新しい値").toContain(`${LONG_ROOT}/next`);
        expect(m.outside, "幅からはみ出した部品").toEqual([]);
        expect(m.pageScroll, "画面（.page）の横スクロール").toBeLessThanOrEqual(m.pageClient);
        expect(m.docScroll, "文書の横スクロール").toBeLessThanOrEqual(m.docClient);
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
