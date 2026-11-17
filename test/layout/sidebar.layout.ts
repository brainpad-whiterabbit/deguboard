// 画面の配置の確認（t58）。dg serve の画面を Chromium で ?surface=sidebar の配置で開き、
// サイドバーの幅（300px・260px、一部は 320px も）とライト・ダーク（最初の検査は表示言語の日本語・英語も。language.ts）で、横スクロールが出ないことと、文字が決めた行数に収まることを確かめる。
// 行数の基準：
// - タブ（nav a）、カンバンの見出し、チケットの行でない行のタイトル（Epic など .row-title）は 1 行。折り返してはいけない
//   カンバンの見出しは、Iteration の見出し（.sidebar-head .head-line：札の列・漏斗の段、名前・期間・何日目の段、進みの帯の段。状態ごとの件数の段も 1 行）と
//   状態の節の見出し（.column summary h2）、履歴の見方の切り替え（.view-switch の「見方」）。チケットの見方の結果の切り替え（.result-switch）は別に確かめる
// - ほかの画面の見出し（バックログ・履歴の summary、Epic の h2 など）は検査しない
// - カンバンの見出しの目標（.sidebar-head .head-goal）は 3 行まで。3 行で切る CSS（-webkit-line-clamp: 3）なので、4 行以上は崩れ
// - チケットの行のタイトル（.ticket-row .row-title）は 2 行まで。サイドバーでは 2 行で切る CSS（-webkit-line-clamp: 2）なので、3 行以上は崩れ
// 行数は要素の枠の中に見えている行だけを数える（2 行で切られて隠れた行は数えない）
// カンバンの行の右端（担当の印・Plan の番号など）は、行の枠からはみ出さず、タイトルと重ならないことも確かめる
// カンバンをスクロールして見出しが抜けたら、上の端の 1 行の帯と、その下に貼り付く状態の節の見出しが出ることも確かめる。
// バックログと履歴は、スクロールしても検索の行と、その下に貼り付く見出しが残ることを確かめる
// 設定画面（#/config）は、確認の帯を開き、長い worktree.root と actions.test のリストを入れた状態で、部品が幅からはみ出さないことを別に確かめる。
// guide.notes.* の表の変更した行の印が 1 つだけであることも、左パネルとパネルの配置で確かめる
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  init,
  iterationClose,
  iterationStart,
  openContext,
  runCommand,
  runStart,
  runFinish,
} from "../../packages/core/src/index.js";
import { amendRunning } from "../../packages/core/src/run/record.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";
import { LANGUAGES, useLanguage } from "./language.js";
import { SETUP_OVERRIDE } from "./setup-override.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
const WIDTHS = [300, 260];
const SCHEMES = ["light", "dark"] as const;
/**
 * サイドバーで出す画面。履歴は閉じた Iteration の行（目標の長いものを含む）を出す。
 * Run の画面はない（画面の配置は UI-12。前の版の #/runs はカンバンとして開く）
 */
const PAGES = ["#/board", "#/backlog", "#/epics/e1", "#/history"];
/** 左パネルのタブの数（カンバン・バックログ・履歴。UI-12） */
const SIDEBAR_TABS = 3;
const LONG = "サイドバーの配置を確かめるための、かなり長めのタイトルのチケット";

/** 設定画面の長い worktree.root。区切り（空白）がないので、折り返せないと横にはみ出す */
const LONG_ROOT =
  "../deguboard-layout-check-repository.worktrees/a-very-long-directory-name-without-any-spaces";
const TEST_COMMAND = ["mise", "run", "check", "--", "--reporter=verbose", "packages/web/src/pages"];

/**
 * 履歴の区切りの見出しの検査で固定する手元の時間帯と今の時刻（t874）。
 * 閉じた Iteration の期間（formatPeriod）は手元時刻の時刻・分と、今と違う年なら年を出すので、どちらも固定しないと回した時刻で見出しの長さが変わる
 */
const TIMEZONE = "Asia/Tokyo";
const NOW = "2026-06-15T12:00:00+09:00";
/** 典型の長さ（同じ日に閉じた。06/10 09:28–13:24 · 4 時間）の s8。1 行に収まる */
const TYPICAL_PERIOD = { start: "2026-06-10T09:28:00+09:00", end: "2026-06-10T13:24:00+09:00" };
/** 日をまたいで閉じた長い期間（2025/12/31 22:10–01/01 08:00 · 10 時間）の s9。幅 300px では折り返す */
const LONG_PERIOD = { start: "2025-12-31T22:10:00+09:00", end: "2026-01-01T08:00:00+09:00" };

const RUN_NOW = Date.now();
const RUN_CASES = [
  { ticket: "t18", result: "failure", tone: "failed" },
  { ticket: "t19", result: "interrupted", tone: "failed" },
  { ticket: "t20", result: "waiting", tone: "waiting" },
] as const;

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

/** 決めた日時を今の時刻としてコマンドを呼ぶ（Iteration の started_at・closed_at を固定するため。dg serve の API は時刻を渡せない） */
async function atTime(
  iso: string,
  command: typeof iterationStart | typeof iterationClose,
  input: { iteration: string },
): Promise<void> {
  const ctx = await openContext({
    cwd: fixture.cloneA,
    actor: { user: "layout" },
    now: () => new Date(iso),
  });
  await runCommand(command, ctx, input);
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
  // s2 は作るだけにし、s8 を閉じた後に始める（active の Iteration はカンバンに 1 つ。IT-1）。
  // 目標はサイドバーの幅で 3 行を超える長さにし、カンバンの見出しが 3 行で切るかを確かめる
  await call("iteration.create", {
    name: "今週",
    goal: `e1 を仕上げる。t1・t2 を終え、${LONG}${LONG}を見直して、カンバンの見出しで目標の全文が 3 行を超えても崩れないことを確かめる`,
  });
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
  await call("ticket.move", { ticket: "t2", status: "review" });
  await call("ticket.move", { ticket: "t3", status: "done", override: SETUP_OVERRIDE });
  await call("ticket.move", { ticket: "t4", status: "abandoned" });
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
  // Plan の中の depends_on（t11 が t10 を待つ）。グラフの凡例に depends_on の 2 項目が出る
  await call("ticket.update", { ticket: "t11", depends_on: ["t10"] });
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
  // s8 と s9 の実績の期間は固定の日時で書き、区切りの見出しの長さが回した時刻で変わらないようにする（t874）
  await atTime(TYPICAL_PERIOD.start, iterationStart, { iteration: "s8" });
  await call("ticket.move", { ticket: "t13", status: "done", override: SETUP_OVERRIDE });
  await call("ticket.move", { ticket: "t14", status: "abandoned" });
  await atTime(TYPICAL_PERIOD.end, iterationClose, { iteration: "s8" });
  // 日をまたいで閉じた Iteration（s9）：区切りの見出しが幅 300px で折り返す長さの期間。続く行は 2 件（t16・t17）
  await call("iteration.create", { name: "日をまたいだ週" });
  for (let i = 16; i <= 17; i++)
    await call("ticket.create", { title: `日をまたいだ週のチケット ${i}`, iteration: "s9" });
  await atTime(LONG_PERIOD.start, iterationStart, { iteration: "s9" });
  await call("ticket.move", { ticket: "t16", status: "done", override: SETUP_OVERRIDE });
  await call("ticket.move", { ticket: "t17", status: "abandoned" });
  await atTime(LONG_PERIOD.end, iterationClose, { iteration: "s9" });
  await call("iteration.start", { iteration: "s2" });
  // t1 の claim は planned の Iteration を開始する（ticket.claim は s2 を始める。t594）ので、s2 を始めた後に claim する。
  // 先に claim すると s2 が active になり、s8 の開始が IT-1 で拒否される
  await call("ticket.claim", { ticket: "t1", without_branch: true });
  await call("run.start", { ticket: "t1", step: "implement", agent: "claude-code" });
  // 4 回の Run：最後の失敗・中断（2 時間前）と返事待ち（59 分）を、長いタイトルと一緒に測る（t888）。
  for (const { ticket, result } of RUN_CASES) {
    await call("ticket.create", { title: LONG, iteration: "s2" });
    await call("ticket.move", { ticket, status: result === "waiting" ? "in_progress" : "review" });
    for (let i = 0; i < 4; i++) {
      const start = RUN_NOW - (8 - i) * 3_600_000;
      const ctx = await openContext({
        cwd: fixture.cloneA,
        actor: { user: "layout" },
        now: () => new Date(start),
      });
      const run = await runCommand(runStart, ctx, { ticket, step: "implement", agent: "codex" });
      if (i === 3 && result === "waiting") {
        await amendRunning(ctx.repo, run.data.id, {
          waiting_since: new Date(RUN_NOW - 59 * 60_000).toISOString(),
        });
      } else {
        ctx.now = () => new Date(i === 3 ? RUN_NOW - 2 * 3_600_000 : start + 60_000);
        await runCommand(runFinish, ctx, {
          run: run.data.id,
          result: i === 3 && result !== "waiting" ? result : "success",
        });
      }
    }
  }
  // 設定画面：長い worktree.root（区切りのない長いパス）と、項目の多い actions.test
  await call("config.set", { key: "worktree.root", value: LONG_ROOT });
  await call("config.set", { key: "actions.test", value: TEST_COMMAND });
  // guide.notes.* の表の、変更した行（印が 1 つだけかを確かめる）
  await call("config.set", { key: "guide.notes.plan", value: "Plan の前に読む" });
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
      headGoals: document.querySelectorAll(".sidebar-head .head-goal").length,
      sectionHeadings: document.querySelectorAll(".column summary h2").length,
      viewSwitches: document.querySelectorAll(
        '.view-switch[aria-label="見方"], .view-switch[aria-label="View by"]',
      ).length,
      wrapped: [
        ...overflowing("nav a", 1),
        ...overflowing(".sidebar-head .head-line", 1),
        ...overflowing(".sidebar-head .head-goal", 3),
        ...overflowing(".sidebar-head .status-counts", 1),
        ...overflowing(".column summary h2", 1),
        ...overflowing('.view-switch[aria-label="見方"]', 1),
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

// 英語の文は日本語より長くなりやすいので、表示言語が英語（VS Code の data-language）の画面でも同じに確かめる（t383）
describe.each(
  SCHEMES.flatMap((scheme) => LANGUAGES.map((language) => [scheme, language] as const)),
)("サイドバーの配置（%s・%s）", (scheme, language) => {
  it.each(WIDTHS)(
    "幅 %ipx で、どの画面も横スクロールが出ず、タブ・見出し・チケットでない行のタイトルは 1 行、チケットの行のタイトルは 2 行までに収まる",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      await useLanguage(context, language);
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
              path: `.playwright-mcp/layout-${scheme}-${language}-${width}-${hash.replace(/\W+/g, "_")}.png`,
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
            expect(m.headGoals, `${hash} の Iteration の目標の行`).toBe(1);
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

// run.recent はチケットとは別に読み込まれるので、丸がない空の行を測って成功させない（t888）。
describe.each(
  SCHEMES.flatMap((scheme) => LANGUAGES.map((language) => [scheme, language] as const)),
)("カンバンの Run の並び（%s・%s）", (scheme, language) => {
  it.each([320, ...WIDTHS])(
    "幅 %ipx で、失敗・中断・返事待ちの丸と文字が行に収まり、タイトルと重ならない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      await useLanguage(context, language);
      const page = await context.newPage();
      await page.clock.install({ time: RUN_NOW });
      try {
        await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
        const colors: string[] = [];
        for (const { ticket, result, tone } of RUN_CASES) {
          const row = page
            .locator(".row-item")
            .filter({ has: page.locator("code", { hasText: new RegExp(`^${ticket}$`) }) });
          await row.locator(".run-pips").waitFor();
          await expect.poll(() => row.locator(".run-pip").count()).toBe(3);
          expect(await row.locator(".run-pips-more").textContent()).toBe("+1");
          expect(await row.locator(`.run-pip.run-${result}.is-last`).count()).toBe(1);
          const caption = await row.locator(".run-pips-caption").textContent();
          const expected =
            language === "ja"
              ? {
                  failure: "失敗 · 2時間前",
                  interrupted: "中断 · 2時間前",
                  waiting: "返事待ち · 59分",
                }
              : {
                  failure: "Failure · 2h ago",
                  interrupted: "Interrupted · 2h ago",
                  waiting: "Awaiting reply · 59m",
                };
          expect(caption).toBe(expected[result]);
          expect(await row.getAttribute("class")).toContain(`run-tone-${tone}`);
          const m = await row.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const title = el.querySelector(".row-title")!.getBoundingClientRect();
            const parts = [
              ...el.querySelectorAll(".run-pips, .run-pip, .run-pips-more, .run-pips-caption"),
            ];
            return {
              outside: parts
                .filter((part) => {
                  const r = part.getBoundingClientRect();
                  return (
                    r.left < box.left - 0.5 ||
                    r.right > box.right + 0.5 ||
                    r.top < box.top - 0.5 ||
                    r.bottom > box.bottom + 0.5
                  );
                })
                .map((part) => part.className),
              overlaps: parts
                .filter((part) => {
                  const r = part.getBoundingClientRect();
                  return (
                    Math.min(r.right, title.right) - Math.max(r.left, title.left) > 0.5 &&
                    Math.min(r.bottom, title.bottom) - Math.max(r.top, title.top) > 0.5
                  );
                })
                .map((part) => part.className),
              color: getComputedStyle(el).backgroundColor,
            };
          });
          expect(m.outside, `${ticket} で行からはみ出す部品`).toEqual([]);
          expect(m.overlaps, `${ticket} でタイトルと重なる部品`).toEqual([]);
          expect(m.color, `${ticket} の地の色`).not.toBe("rgba(0, 0, 0, 0)");
          colors.push(m.color);
        }
        expect(colors[0], "失敗と中断は同じ色").toBe(colors[1]);
        expect(colors[2], "返事待ちは失敗と違う色").not.toBe(colors[0]);
      } finally {
        await context.close();
      }
    },
  );
});

// dg serve は ?surface= がなければ左パネルの配置で出す（ブラウザだけの配置はない。画面の正本は UI-12 の VS Code 拡張で、dg serve は開発用）
it("?surface= を付けなければサイドバーの配置で開き、前の版の Run の画面のハッシュはカンバンになる", async () => {
  const context = await browser.newContext({ viewport: { width: 300, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${server.url}#/runs`, { waitUntil: "networkidle" });
    await page.locator("nav a").first().waitFor();
    await page.locator(".row").first().waitFor();
    const m = await page.evaluate(() => ({
      surface: document.querySelector<HTMLElement>(".app")?.dataset["surface"],
      tabs: document.querySelectorAll("nav a").length,
      active: document.querySelector("nav a[aria-current='page']")?.getAttribute("href"),
      scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    }));
    expect(m.surface).toBe("sidebar");
    expect(m.tabs).toBe(SIDEBAR_TABS);
    expect(m.active).toMatch(/^#\/board/);
    expect(m.scroll[0], "横スクロール").toBeLessThanOrEqual(m.scroll[1]!);
  } finally {
    await context.close();
  }
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
          const toggle = page.locator('[role=group][aria-label="見方"]');
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
    "幅 %ipx で、検索欄が幅いっぱいで、その下の結果の切り替えが 1 行に収まり画面から溢れない（中止を選んだときも）",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        for (const result of ["", "&result=abandoned"]) {
          await page.goto(`${server.url}?surface=sidebar#/history?view=ticket${result}`, {
            waitUntil: "networkidle",
          });
          const group = page.locator('[role=group][aria-label="結果"]');
          await group.waitFor();
          const m = await group.evaluate((el) => {
            const search = document.querySelector('input[type="search"]')!.getBoundingClientRect();
            const buttons = [...el.querySelectorAll("button")].map((b) =>
              b.getBoundingClientRect(),
            );
            const main = document.querySelector(".page")!;
            const box = main.getBoundingClientRect();
            const pad = parseFloat(getComputedStyle(main).paddingRight);
            return {
              count: buttons.length,
              pressed: el.querySelectorAll('button[aria-pressed="true"]').length,
              selects: document.querySelectorAll(".toolbar select").length,
              searchRight: search.right,
              searchWidth: search.width,
              searchBottom: search.bottom,
              top: el.getBoundingClientRect().top,
              tops: new Set(buttons.map((b) => Math.round(b.top))).size,
              right: Math.max(...buttons.map((b) => b.right)),
              width: box.right - pad,
              pageScroll: main.scrollWidth,
              pageClient: main.clientWidth,
            };
          });
          const label = `結果「${result}」`;
          expect(m.selects, `${label} 結果の select はない`).toBe(0);
          expect(m.count, `${label} のボタン`).toBeGreaterThanOrEqual(2);
          expect(m.count, `${label} のボタン`).toBeLessThanOrEqual(3);
          expect(m.pressed, `${label} で選んだものが 1 つ`).toBe(1);
          expect(m.searchWidth, `${label} 検索欄が潰れない`).toBeGreaterThan(200);
          expect(m.searchRight, `${label} 検索欄が幅いっぱい`).toBeGreaterThanOrEqual(m.width - 2);
          expect(m.top, `${label} 結果の切り替えが検索欄の下`).toBeGreaterThanOrEqual(
            m.searchBottom,
          );
          expect(m.tops, `${label} で 1 行`).toBe(1);
          expect(m.right, `${label} で幅に収まる`).toBeLessThanOrEqual(m.width + 0.5);
          expect(m.pageScroll, `${label} で画面が横に溢れない`).toBeLessThanOrEqual(m.pageClient);
        }
      } finally {
        await context.close();
      }
    },
  );
});

// 区切りの見出しは Iteration の番号・期間・件数を 1 行で出し、収まらなければ CSS（flex-wrap）のとおり折り返す。
// 期間の長さが回した時刻で変わらないよう、Iteration の日時（TYPICAL_PERIOD・LONG_PERIOD）と画面の今の時刻・時間帯を固定する（t874）
describe.each(
  SCHEMES.flatMap((scheme) =>
    [
      { iteration: "s8", lines: "1 行", period: "06/10 09:28–13:24 · 4 時間" },
      { iteration: "s9", lines: "折り返す", period: "2025/12/31 22:10–01/01 08:00 · 10 時間" },
    ].map((c) => ({ scheme, ...c })),
  ),
)(
  "履歴のチケットの見方の区切りの見出し（$scheme・$iteration）",
  ({ scheme, iteration, lines, period }) => {
    it(`幅 300px で${lines}で、スクロールすると一覧の上に貼り付いて、下の行が透けない`, async () => {
      // 行が少なくてもスクロールできるよう、高さを小さくする
      const context = await browser.newContext({
        viewport: { width: 300, height: 220 },
        colorScheme: scheme,
        timezoneId: TIMEZONE,
      });
      const page = await context.newPage();
      try {
        await page.clock.setFixedTime(new Date(NOW));
        await page.goto(`${server.url}?surface=sidebar#/history?view=ticket`, {
          waitUntil: "networkidle",
        });
        await page.locator(".history-divider").first().waitFor();
        const m = await page.evaluate(async (id) => {
          const main = document.querySelector<HTMLElement>(".page")!;
          const divider = [...document.querySelectorAll<HTMLElement>(".history-divider")].find(
            (d) => d.firstElementChild?.textContent === id,
          )!;
          const row = divider.nextElementSibling!;
          const parts = [...divider.children].map((c) => c.getBoundingClientRect());
          // 行の数は文字の矩形で数える（期間の中で折り返しても数え漏らさない）。今の行の下端より下から始まったら次の行
          const range = document.createRange();
          range.selectNodeContents(divider);
          const rects = [...range.getClientRects()]
            .filter((r) => r.width > 0)
            .sort((a, b) => a.top - b.top);
          let lineCount = 0;
          let bottom = -Infinity;
          for (const r of rects) {
            if (r.top >= bottom - 1) {
              lineCount++;
              bottom = r.bottom;
            } else bottom = Math.max(bottom, r.bottom);
          }
          const before = divider.getBoundingClientRect();
          const box = main.getBoundingClientRect();
          const padTop = parseFloat(getComputedStyle(main).paddingTop);
          const padRight = parseFloat(getComputedStyle(main).paddingRight);
          // 左パネルの区切りは、上の端に貼り付いた検索の行と結果の絞り込みの下に貼り付く（t965）
          const stuckOffset = parseFloat(getComputedStyle(divider).top) + padTop;
          // 区切りの元の位置が貼り付く所より 20px 上に出るまで送る（続く行が 2 件あるので、次の区切りにはまだ押されない）
          main.scrollTop += before.top - (box.top + stuckOffset) + 20;
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const after = divider.getBoundingClientRect();
          const result = document.querySelector(".result-switch")!.getBoundingClientRect();
          return {
            texts: [...divider.children].map((c) => c.textContent),
            lineCount,
            right: Math.max(...parts.map((p) => p.right)),
            width: box.right - padRight,
            scrolled: main.scrollTop,
            stuckTop: after.top,
            stuckAt: result.bottom,
            resultTop: result.top - box.top,
            rowTop: row.getBoundingClientRect().top,
            dividerBottom: after.bottom,
            bg: getComputedStyle(divider).backgroundColor,
            // 上の余白（.page の padding）に行が透けないよう塗り足す高さ
            cover: parseFloat(getComputedStyle(divider, "::before").height),
            padTop,
            pageScroll: main.scrollWidth,
            pageClient: main.clientWidth,
          };
        }, iteration);
        expect(m.texts, "番号・期間・件数").toEqual([iteration, period, "2 件"]);
        if (iteration === "s8") expect(m.lineCount, "典型の長さの区切りは 1 行").toBe(1);
        else expect(m.lineCount, "長い期間の区切りは折り返す").toBeGreaterThan(1);
        expect(m.right, "区切りが幅に収まる").toBeLessThanOrEqual(m.width + 0.5);
        expect(m.scrolled, "スクロールできた").toBeGreaterThan(0);
        expect(
          Math.abs(m.stuckTop - m.stuckAt),
          "検索の行と結果の絞り込みの下に貼り付く",
        ).toBeLessThanOrEqual(1);
        expect(m.resultTop, "結果の絞り込みは検索の行の下に残る").toBeGreaterThan(30);
        expect(m.rowTop, "行は区切りの下をくぐる").toBeLessThan(m.dividerBottom);
        expect(m.bg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
        expect(m.cover, "上の余白も塗る").toBeGreaterThanOrEqual(m.padTop);
        expect(m.pageScroll, "画面が横に溢れない").toBeLessThanOrEqual(m.pageClient);
      } finally {
        await context.close();
      }
    });
  },
);

// 履歴をスクロールしても、検索の行を上の端に残し、その下に見方ごとの見出しを貼り付ける（UI-5、t965）。
// Iteration の見方は開いた行の見出しが検索の行の下に貼り付いて次の行に押し出され、押すと畳む（Epic の見方は同じ CSS の行）。
// チケットの見方は結果の絞り込みが検索の行の下の 2 段目に残る（区切りの見出しはその下。上の区切りの見出しの検査）。
// 貼り付いた検索欄・見出しにフォーカスしても一覧が動かないこと（寄せ先の分だけ戻さない）も確かめる
describe.each(SCHEMES)("左パネルの履歴の上の端に残す検索の行と見出し（%s）", (scheme) => {
  it("幅 300px の Iteration の見方で、開いた行の見出しは検索の行の下に貼り付いて次の行に押し出され、フォーカスしても一覧は動かず、押すと畳んで見出しが見え、打ち込むと一番上へ戻る", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 260 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/history`, { waitUntil: "networkidle" });
      const summaryOf = (id: string) =>
        page.locator("summary.history-row", {
          has: page.locator("code", { hasText: new RegExp(`^${id}$`) }),
        });
      for (const id of ["s8", "s9"]) {
        await summaryOf(id).click();
        await page.locator(`details[open] > summary.history-row code:text-is("${id}")`).waitFor();
      }
      // 持ち越しの読み込みで行の中身が伸びるのを待つ
      await page.locator(".history-carried").waitFor();
      const stuck = await page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        // 後ろの行が短く一覧の終わりで止まるので、下に余白を足して送れるようにする
        main.style.paddingBottom = "600px";
        const offset = (el: Element) => el.getBoundingClientRect().top - box.top + main.scrollTop;
        const search = document.querySelector<HTMLElement>(".history-search")!;
        const [first, second] = [...document.querySelectorAll("details.history-item[open]")];
        const head = first!.querySelector<HTMLElement>(":scope > summary")!;
        const next = second!.querySelector<HTMLElement>(":scope > summary")!;
        // 最初の開いた行（s8）の見出しの元の位置が検索の行の下より 40px 上に出るまで送る
        main.scrollTop = offset(first!) - 32 + 40;
        await frame();
        const scrolled = main.scrollTop;
        const rect = search.getBoundingClientRect();
        const headRect = head.getBoundingClientRect();
        const row = first!.querySelector(".history-ticket")!.getBoundingClientRect();
        const toggle = document.querySelector('[role=group][aria-label="見方"]')!;
        // 貼り付いた検索欄と見出しにフォーカスしても一覧は動かない（寄せ先の分だけ戻さない）
        search.querySelector("input")!.focus();
        await frame();
        const afterSearchFocus = main.scrollTop;
        head.focus();
        await frame();
        const afterHeadFocus = main.scrollTop;
        const result = {
          scrolled,
          top: rect.top - box.top,
          height: rect.height,
          searchBottom: rect.bottom,
          searchBg: getComputedStyle(search).backgroundColor,
          toggleBottom: toggle.getBoundingClientRect().bottom - box.top,
          headTop: headRect.top,
          headBg: getComputedStyle(head).backgroundImage,
          headBgColor: getComputedStyle(head).backgroundColor,
          bubbles: head.querySelectorAll(".ask-bubble").length,
          rowTop: row.top,
          headBottom: headRect.bottom,
          afterSearchFocus,
          afterHeadFocus,
          nextTop: 0,
          firstBottom: 0,
          stillTop: 0,
        };
        // 次の開いた行（s9）の見出しが検索の行の下に来るまで送ると、前の行の見出しは押し出される
        main.scrollTop = offset(second!) - 32;
        await frame();
        result.nextTop = next.getBoundingClientRect().top;
        result.firstBottom = head.getBoundingClientRect().bottom;
        result.stillTop = search.getBoundingClientRect().top - box.top;
        // 最初の行の見出しが貼り付いている所へ戻す
        main.scrollTop = scrolled;
        await frame();
        return result;
      });
      expect(stuck.scrolled, "スクロールできた").toBeGreaterThan(0);
      expect(Math.abs(stuck.top), "検索の行は一覧の上の端に貼り付く").toBeLessThanOrEqual(1);
      expect(stuck.height, "検索の行の高さ").toBe(32);
      expect(stuck.searchBg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(stuck.toggleBottom, "見方の切り替えは残さない").toBeLessThanOrEqual(stuck.top + 1);
      expect(
        Math.abs(stuck.headTop - stuck.searchBottom),
        "開いた行の見出しは検索の行の下",
      ).toBeLessThanOrEqual(1);
      expect(stuck.headBg, "開いた行の色を重ねる").toContain("gradient");
      expect(stuck.headBgColor, "下の行が透けないよう地の色で塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(stuck.bubbles, "貼り付いた見出しも頼める").toBe(1);
      expect(stuck.rowTop, "行は見出しの下をくぐる").toBeLessThan(stuck.headBottom);
      expect(stuck.afterSearchFocus, "検索欄にフォーカスしても一覧は動かない").toBe(stuck.scrolled);
      expect(stuck.afterHeadFocus, "見出しにフォーカスしても一覧は動かない").toBe(stuck.scrolled);
      expect(
        Math.abs(stuck.nextTop - stuck.searchBottom),
        "次の行の見出しが検索の行の下に来る",
      ).toBeLessThanOrEqual(1);
      expect(stuck.firstBottom, "前の行の見出しは押し出される").toBeLessThanOrEqual(
        stuck.nextTop + 1,
      );
      expect(Math.abs(stuck.stillTop), "検索の行は残ったまま").toBeLessThanOrEqual(1);

      // 貼り付いた見出しで Shift+F10 を押すと頼む一覧が出る
      await summaryOf("s8").focus();
      await page.keyboard.press("Shift+F10");
      const menu = page.locator(".ask-menu");
      await menu.waitFor();
      await menu.locator("[role=menuitem]").first().focus();
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      expect(
        await page.evaluate(() => document.querySelector(".page")!.scrollTop),
        "頼む一覧を開いて閉じても一覧は動かない",
      ).toBe(stuck.scrolled);

      // 貼り付いた見出しを押すと畳み、畳んだ行の見出しが検索の行の下に見える所まで一覧を戻す
      await summaryOf("s8").click();
      await page.locator("details.history-item:not([open]) > summary code:text-is('s8')").waitFor();
      await page.waitForFunction(() => {
        const main = document.querySelector(".page")!;
        const search = document.querySelector(".history-search")!.getBoundingClientRect();
        const head = [...document.querySelectorAll("summary.history-row")]
          .find((s) => s.querySelector("code")?.textContent === "s8")!
          .getBoundingClientRect();
        return head.top >= search.bottom - 1 && head.bottom <= main.getBoundingClientRect().bottom;
      });

      // 貼り付いた検索欄に打ち込むと一番上へ戻る
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".page")!.scrollTop = 200;
      });
      await page.getByRole("searchbox").fill("s9");
      await page.waitForFunction(() => document.querySelector(".page")!.scrollTop === 0);
    } finally {
      await context.close();
    }
  });

  it("幅 300px のチケットの見方で、結果の絞り込みは検索の行の下の 2 段目に残り、フォーカスしても一覧は動かず、打ち込むと一番上へ戻る", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 220 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/history?view=ticket`, {
        waitUntil: "networkidle",
      });
      await page.locator(".history-divider").first().waitFor();
      const m = await page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        const main = document.querySelector<HTMLElement>(".page")!;
        main.style.paddingBottom = "600px";
        main.scrollTop = 150;
        await frame();
        const box = main.getBoundingClientRect();
        const search = document.querySelector(".history-search")!.getBoundingClientRect();
        const group = document.querySelector<HTMLElement>(".result-switch")!;
        const rect = group.getBoundingClientRect();
        const scrolled = main.scrollTop;
        group.querySelector("button")!.focus();
        await frame();
        const afterFocus = main.scrollTop;
        document.querySelector<HTMLElement>(".history-search input")!.focus();
        await frame();
        return {
          scrolled,
          searchTop: search.top - box.top,
          searchBottom: search.bottom,
          top: rect.top,
          tops: new Set(
            [...group.querySelectorAll("button")].map((b) =>
              Math.round(b.getBoundingClientRect().top),
            ),
          ).size,
          bg: getComputedStyle(group).backgroundColor,
          afterFocus,
          afterSearchFocus: main.scrollTop,
        };
      });
      expect(m.scrolled, "スクロールできた").toBe(150);
      expect(Math.abs(m.searchTop), "検索の行は一覧の上の端に貼り付く").toBeLessThanOrEqual(1);
      expect(Math.abs(m.top - m.searchBottom), "結果の絞り込みは検索の行の下").toBeLessThanOrEqual(
        1,
      );
      expect(m.tops, "結果の絞り込みは 1 行の文字の切り替え").toBe(1);
      expect(m.bg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(m.afterFocus, "結果の切り替えにフォーカスしても一覧は動かない").toBe(m.scrolled);
      expect(m.afterSearchFocus, "検索欄にフォーカスしても一覧は動かない").toBe(m.scrolled);
      await page.getByRole("searchbox").fill("t1");
      await page.waitForFunction(() => document.querySelector(".page")!.scrollTop === 0);
    } finally {
      await context.close();
    }
  });
});

// 見出しの進みの帯の行が上へ抜けたら、上の端に 1 行の帯を出し、状態の節の見出しをその下に貼り付ける（UI-2、t962）。
// 帯は一覧を動かさずに出し入れし、節の見出しは次の節の見出しに押し出されて入れ替わる
describe.each(SCHEMES)("左パネルのカンバンの上の端に残す帯（%s）", (scheme) => {
  it("幅 300px で、見出しが抜けたら 1 行の帯を上の端に出して一覧は動かさず、節の見出しは帯の下に貼り付いて次の節に押し出され、下の行が透けない", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 360 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
      await page.locator(".board .column").first().waitFor();
      const before = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const mark = document.querySelector<HTMLElement>(".sidebar-head .status-band")!;
        return {
          banded: !!document.querySelector(".sticky-band-bar"),
          // 進みの帯の行が上の端（帯の高さの所）より上へ抜けるまで送る量
          past: mark.getBoundingClientRect().bottom - box.top - 20,
          boardOffset:
            document.querySelector(".board")!.getBoundingClientRect().top -
            box.top +
            main.scrollTop,
        };
      });
      expect(before.banded, "見出しが見えている間は帯を出さない").toBe(false);

      // 帯を出す前後で、行の一覧の中の位置が変わらない（帯は動かさずに重ねる）
      await page.evaluate((y) => {
        document.querySelector<HTMLElement>(".page")!.scrollTop = y;
      }, before.past);
      await page.locator(".sticky-band-bar").waitFor();
      const stuck = await page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const bar = document.querySelector<HTMLElement>(".sticky-band-bar")!;
        const rect = bar.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(bar.querySelector(".board-band-top")!);
        // 行の数は文字の矩形で数える。今の行の下端より下から始まったら次の行（大きさの違う番号と名前の上端のずれで誤らない）
        let lines = 0;
        let lineBottom = -Infinity;
        for (const r of [...range.getClientRects()]
          .filter((r) => r.width > 0)
          .sort((a, b) => a.top - b.top)) {
          if (r.top >= lineBottom - 1) {
            lines++;
            lineBottom = r.bottom;
          } else lineBottom = Math.max(lineBottom, r.bottom);
        }
        const board = document.querySelector<HTMLElement>(".board")!;
        return {
          text: bar.textContent,
          top: rect.top - box.top,
          height: rect.height,
          left: rect.left - box.left,
          right: box.right - rect.right,
          lines,
          bg: getComputedStyle(bar).backgroundColor,
          boardOffset: board.getBoundingClientRect().top - box.top + main.scrollTop,
          pageScroll: main.scrollWidth,
          pageClient: main.clientWidth,
        };
      });
      expect(stuck.text, "番号・名前・n/m").toMatch(/^s2今週\d+\/\d+$/);
      expect(Math.abs(stuck.top), "一覧の上の端に貼り付く").toBeLessThanOrEqual(1);
      expect(stuck.height, "帯の高さ").toBe(26);
      expect(stuck.lines, "番号と名前は 1 行").toBe(1);
      expect(
        Math.abs(stuck.left) + Math.abs(stuck.right),
        "左右の余白まで塗る",
      ).toBeLessThanOrEqual(1);
      expect(stuck.bg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(stuck.pageScroll, "画面が横に溢れない").toBeLessThanOrEqual(stuck.pageClient);
      expect(stuck.boardOffset, "帯を出しても一覧は動かない").toBe(before.boardOffset);

      // 最初の節（Todo）の見出しが帯の下に貼り付くまで送り、さらに次の節の見出しが来たら押し出されて入れ替わる
      const sections = await page.evaluate(async () => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const [first, second] = [
          ...document.querySelectorAll<HTMLElement>(".board > details.column[open]"),
        ].map((d) => d.querySelector<HTMLElement>("summary")!);
        const bandBottom = document
          .querySelector(".sticky-band-bar")!
          .getBoundingClientRect().bottom;
        const offset = (el: HTMLElement) =>
          el.getBoundingClientRect().top - box.top + main.scrollTop;
        // 最初の節の見出しの元の位置から少し先へ
        main.scrollTop = offset(first!.parentElement!) - 26 + 30;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const firstTop = first!.getBoundingClientRect().top;
        const row = first!.parentElement!.querySelector(".rows")!.getBoundingClientRect();
        const bg = getComputedStyle(first!).backgroundColor;
        // 次の節の見出しが帯の下の所に来るまで送る
        main.scrollTop = offset(second!.parentElement!) - 26;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return {
          bandBottom,
          firstTop,
          rowTop: row.top,
          bg,
          secondTop: second!.getBoundingClientRect().top,
          firstBottom: first!.getBoundingClientRect().bottom,
        };
      });
      expect(
        Math.abs(sections.firstTop - sections.bandBottom),
        "節の見出しは帯の下",
      ).toBeLessThanOrEqual(1);
      expect(sections.rowTop, "行は節の見出しの下をくぐる").toBeLessThan(sections.firstTop);
      expect(sections.bg, "節の見出しも塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(
        Math.abs(sections.secondTop - sections.bandBottom),
        "次の節の見出しが帯の下に来る",
      ).toBeLessThanOrEqual(1);
      expect(sections.firstBottom, "前の節の見出しは押し出される").toBeLessThanOrEqual(
        sections.secondTop + 1,
      );

      // 帯の名前を押すと一番上へ戻り、帯が消える
      await page.locator(".board-band-top").click();
      await page.waitForFunction(() => !document.querySelector(".sticky-band-bar"));
      expect(await page.evaluate(() => document.querySelector(".page")!.scrollTop)).toBe(0);
    } finally {
      await context.close();
    }
  });

  // 帯の ▾ で札の列を一覧の上に重ねて開き、Epic で絞っている間は帯の 2 行目に絞り込みの札を出す（t963）
  it("幅 300px で、絞っている間は帯の 2 行目に札を出して節の見出しをその下に貼り付け、▾ で開いた札の列は一覧を動かさずに重なり、帯の外を押すと閉じる", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 360 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/board?epic=e1`, {
        waitUntil: "networkidle",
      });
      await page.locator(".board .column").first().waitFor();
      await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const mark = document.querySelector<HTMLElement>(".sidebar-head .status-band")!;
        main.scrollTop = mark.getBoundingClientRect().bottom - main.getBoundingClientRect().top;
      });
      await page.locator(".sticky-band-bar").waitFor();
      const filtered = await page.evaluate(async () => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const bar = document
          .querySelector<HTMLElement>(".sticky-band-bar")!
          .getBoundingClientRect();
        const filters = document.querySelector<HTMLElement>(".sticky-band .board-band-filters")!;
        const rect = filters.getBoundingClientRect();
        const first = document.querySelector<HTMLElement>(".board > details.column[open]")!;
        const offset = first.getBoundingClientRect().top - box.top + main.scrollTop;
        // 最初の節の見出しが帯の下に貼り付くまで送る
        main.scrollTop = offset;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return {
          text: filters.textContent,
          barBottom: bar.bottom,
          top: rect.top,
          height: rect.height,
          right: rect.right,
          pageRight: box.right,
          stackBottom: document.querySelector(".sticky-band-stack")!.getBoundingClientRect().bottom,
          summaryTop: first.querySelector("summary")!.getBoundingClientRect().top,
        };
      });
      expect(filtered.text, "Epic の札").toMatch(/^e1 .+×$/);
      expect(Math.abs(filtered.top - filtered.barBottom), "札は帯の下の行").toBeLessThanOrEqual(1);
      expect(filtered.height, "札の行の高さ").toBe(22);
      expect(filtered.right, "札の行が幅に収まる").toBeLessThanOrEqual(filtered.pageRight + 0.5);
      expect(
        Math.abs(filtered.summaryTop - filtered.stackBottom),
        "節の見出しは札の行の下に貼り付く",
      ).toBeLessThanOrEqual(1);

      const before = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".page")!;
        return {
          scrollTop: main.scrollTop,
          boardOffset:
            document.querySelector(".board")!.getBoundingClientRect().top -
            main.getBoundingClientRect().top +
            main.scrollTop,
        };
      });
      const toggle = page.getByRole("button", { name: "Iteration・Epic・担当を切り替える" });
      // 押しても、帯の部品へ寄せるスクロール（scroll-padding-top）で一覧が上へ戻って帯が消えない
      await toggle.click();
      await page.locator("#board-band-drop").waitFor();
      const dropped = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const drop = document.querySelector<HTMLElement>("#board-band-drop")!;
        const rect = drop.getBoundingClientRect();
        return {
          top: rect.top,
          filtersBottom: document
            .querySelector(".sticky-band .board-band-filters")!
            .getBoundingClientRect().bottom,
          left: rect.left - box.left,
          right: box.right - rect.right,
          bg: getComputedStyle(drop.closest(".sticky-band-stack")!).backgroundColor,
          chips: !!drop.querySelector(".iteration-chips") && !!drop.querySelector(".epic-chips"),
          counts: !!drop.querySelector(".status-counts"),
          scrollTop: main.scrollTop,
          boardOffset:
            document.querySelector(".board")!.getBoundingClientRect().top -
            box.top +
            main.scrollTop,
          pageScroll: main.scrollWidth,
          pageClient: main.clientWidth,
        };
      });
      expect(
        Math.abs(dropped.top - dropped.filtersBottom),
        "札の列は帯の下に重ねる",
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(dropped.left) + Math.abs(dropped.right),
        "左右の余白まで塗る",
      ).toBeLessThanOrEqual(1);
      expect(dropped.bg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(dropped.chips && dropped.counts, "札の列と件数").toBe(true);
      expect(dropped.scrollTop, "開いても位置は変わらない").toBe(before.scrollTop);
      expect(dropped.boardOffset, "開いても一覧は動かない").toBe(before.boardOffset);
      expect(dropped.pageScroll, "画面が横に溢れない").toBeLessThanOrEqual(dropped.pageClient);
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");

      // 帯の外（一覧の下のほう）を押すと閉じる
      await page.mouse.click(150, 340);
      await page.waitForFunction(() => !document.querySelector("#board-band-drop"));
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");

      // キーボードで開き、Esc で閉じる。フォーカスしても一覧は動かない
      await toggle.focus();
      await page.keyboard.press("Enter");
      await page.locator("#board-band-drop").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#board-band-drop"));
      expect(
        await page.evaluate(() => document.activeElement?.classList.contains("board-band-toggle")),
        "Esc で ▾ へフォーカスを戻す",
      ).toBe(true);
      expect(await page.evaluate(() => document.querySelector(".page")!.scrollTop)).toBe(
        before.scrollTop,
      );
    } finally {
      await context.close();
    }
  });
});

// バックログをスクロールしても、検索の行を上の端に残し、Iteration の区画の見出しをその下に貼り付ける（UI-3、t964）。
// 絞っている間は、よく使う絞り込みの行が抜けたら効いている条件の札の行を検索の行の下に重ね、区画の見出しはその下に貼り付く
describe.each(SCHEMES)("左パネルのバックログの上の端に残す検索の行（%s）", (scheme) => {
  it("幅 300px で、検索の行は上の端に残り、フォーカスしても一覧は動かず、区画の見出しはその下に貼り付いて次の区画に押し出され、絞っている間は札の行を一覧を動かさずに重ね、打ち込むと一番上へ戻る", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 360 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/backlog`, { waitUntil: "networkidle" });
      await page.locator(".backlog-section").first().waitFor();
      const stuck = await page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const search = document.querySelector<HTMLElement>(".backlog-search")!;
        const offset = (el: HTMLElement) =>
          el.getBoundingClientRect().top - box.top + main.scrollTop;
        const [first, second] = [...document.querySelectorAll<HTMLElement>(".backlog-section")].map(
          (d) => d.querySelector<HTMLElement>("summary")!,
        );
        // 最初の区画（s2）の見出しの元の位置から、2 段の見出しの高さより先へ
        main.scrollTop =
          offset(first!.parentElement!) - 32 + first!.getBoundingClientRect().height + 20;
        await frame();
        const rect = search.getBoundingClientRect();
        const firstTop = first!.getBoundingClientRect().top;
        const row = first!.parentElement!.querySelector(".ticket-row")!.getBoundingClientRect();
        const bg = getComputedStyle(first!).backgroundColor;
        const headBottom = first!.getBoundingClientRect().bottom - box.top;
        const pad = parseFloat(getComputedStyle(main).scrollPaddingTop);
        // 貼り付いた検索欄にフォーカスしても一覧は動かない（寄せ先の分だけ戻さない）
        const scrolled = main.scrollTop;
        search.querySelector("input")!.focus();
        await frame();
        const afterSearchFocus = main.scrollTop;
        search.querySelector("input")!.blur();
        // 次の区画の見出しが検索の行の下の所に来るまで送る。後ろの区画が短く一覧の終わりで止まるので、下に余白を足して送れるようにする
        main.style.paddingBottom = "600px";
        main.scrollTop = offset(second!.parentElement!) - 32;
        await frame();
        return {
          top: rect.top - box.top,
          height: rect.height,
          searchBottom: rect.bottom,
          searchBg: getComputedStyle(search).backgroundColor,
          firstTop,
          rowTop: row.top,
          bg,
          headBottom,
          pad,
          scrolled,
          afterSearchFocus,
          secondTop: second!.getBoundingClientRect().top,
          firstBottom: first!.getBoundingClientRect().bottom,
          stillTop: search.getBoundingClientRect().top - box.top,
          pageScroll: main.scrollWidth,
          pageClient: main.clientWidth,
        };
      });
      expect(Math.abs(stuck.top), "検索の行は一覧の上の端に貼り付く").toBeLessThanOrEqual(1);
      expect(stuck.height, "検索の行の高さ").toBe(32);
      expect(stuck.searchBg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(
        Math.abs(stuck.firstTop - stuck.searchBottom),
        "区画の見出しは検索の行の下",
      ).toBeLessThanOrEqual(1);
      expect(stuck.rowTop, "行は区画の見出しの下をくぐる").toBeLessThan(stuck.firstTop);
      expect(stuck.bg, "区画の見出しも塗る").not.toBe("rgba(0, 0, 0, 0)");
      // キーで上へ行を移っても、検索の行と 2 段の区画の見出しの下に行が隠れないよう、寄せ先はその下まで下げる
      expect(stuck.pad, "寄せ先は貼り付いた見出しの下").toBeGreaterThanOrEqual(stuck.headBottom);
      expect(stuck.scrolled, "スクロールできた").toBeGreaterThan(0);
      expect(stuck.afterSearchFocus, "検索欄にフォーカスしても一覧は動かない").toBe(stuck.scrolled);
      expect(
        Math.abs(stuck.secondTop - stuck.searchBottom),
        "次の区画の見出しが検索の行の下に来る",
      ).toBeLessThanOrEqual(1);
      expect(stuck.firstBottom, "前の区画の見出しは押し出される").toBeLessThanOrEqual(
        stuck.secondTop + 1,
      );
      expect(Math.abs(stuck.stillTop), "検索の行は残ったまま").toBeLessThanOrEqual(1);
      expect(stuck.pageScroll, "画面が横に溢れない").toBeLessThanOrEqual(stuck.pageClient);

      // 絞っていない間は札の行を出さない
      expect(await page.locator(".sticky-band .backlog-band-filters").count()).toBe(0);

      // 一番上で high で絞り、よく使う絞り込みの行が抜けるまで送ると、検索の行の下に札の行を重ねる
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".page")!.scrollTop = 0;
      });
      await page.getByRole("button", { name: "high", exact: true }).click();
      const before = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const quick = document.querySelector<HTMLElement>(".quick-filters")!;
        main.scrollTop = quick.getBoundingClientRect().bottom - main.getBoundingClientRect().top;
        return {
          scrollTop: main.scrollTop,
          layoutOffset:
            document.querySelector(".backlog-layout")!.getBoundingClientRect().top -
            main.getBoundingClientRect().top +
            main.scrollTop,
        };
      });
      await page.locator(".sticky-band .backlog-band-filters").waitFor();
      const filtered = await page.evaluate(async () => {
        const main = document.querySelector<HTMLElement>(".page")!;
        const box = main.getBoundingClientRect();
        const filters = document.querySelector<HTMLElement>(".sticky-band .backlog-band-filters")!;
        const rect = filters.getBoundingClientRect();
        const stack = document.querySelector<HTMLElement>(".sticky-band-stack")!;
        const layoutOffset =
          document.querySelector(".backlog-layout")!.getBoundingClientRect().top -
          box.top +
          main.scrollTop;
        const first = document.querySelector<HTMLElement>(".backlog-section")!;
        main.scrollTop = first.getBoundingClientRect().top - box.top + main.scrollTop;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return {
          text: filters.textContent,
          top: rect.top,
          height: rect.height,
          left: stack.getBoundingClientRect().left - box.left,
          right: box.right - stack.getBoundingClientRect().right,
          searchBottom: document.querySelector(".backlog-search")!.getBoundingClientRect().bottom,
          bg: getComputedStyle(stack).backgroundColor,
          layoutOffset,
          stackBottom: stack.getBoundingClientRect().bottom,
          summaryTop: first.querySelector("summary")!.getBoundingClientRect().top,
          summaryBottom: first.querySelector("summary")!.getBoundingClientRect().bottom - box.top,
          pad: parseFloat(getComputedStyle(main).scrollPaddingTop),
        };
      });
      expect(filtered.text, "効いている条件の札と件数").toMatch(/^優先度 high×\d+ \/ \d+ 件$/);
      expect(
        Math.abs(filtered.top - filtered.searchBottom),
        "札の行は検索の行の下",
      ).toBeLessThanOrEqual(1);
      expect(filtered.height, "札の行の高さ").toBe(22);
      expect(
        Math.abs(filtered.left) + Math.abs(filtered.right),
        "左右の余白まで塗る",
      ).toBeLessThanOrEqual(1);
      expect(filtered.bg, "下の行が透けないよう塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(filtered.layoutOffset, "札の行を出しても一覧は動かない").toBe(before.layoutOffset);
      expect(
        Math.abs(filtered.summaryTop - filtered.stackBottom),
        "区画の見出しは札の行の下に貼り付く",
      ).toBeLessThanOrEqual(1);
      expect(filtered.pad, "札の行を出しても寄せ先は貼り付いた見出しの下").toBeGreaterThanOrEqual(
        filtered.summaryBottom,
      );

      // 貼り付いた検索欄に打ち込むと一番上へ戻る
      await page.getByRole("searchbox", { name: "検索" }).fill("番号");
      await page.waitForFunction(() => document.querySelector(".page")!.scrollTop === 0);
    } finally {
      await context.close();
    }
  });
});

describe.each(SCHEMES)("履歴の中止の行（%s）", (scheme) => {
  it("点は塗らない輪（border）で、完了の点は塗り、タイトルは薄く打ち消し線がない", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 900 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/history?view=ticket`, {
        waitUntil: "networkidle",
      });
      await page.locator(".history-ticket.abandoned").first().waitFor();
      const m = await page.evaluate(() => {
        const read = (sel: string) => {
          const row = document.querySelector(sel)!;
          const dot = getComputedStyle(row.querySelector(".status-dot")!);
          const title = getComputedStyle(row.querySelector(".row-title")!);
          return {
            bg: dot.backgroundColor,
            borderWidth: parseFloat(dot.borderTopWidth),
            borderStyle: dot.borderTopStyle,
            borderColor: dot.borderTopColor,
            boxSizing: dot.boxSizing,
            width: dot.width,
            opacity: parseFloat(title.opacity),
            decoration: title.textDecorationLine,
          };
        };
        return {
          abandoned: read(".history-ticket.abandoned"),
          done: read(".history-ticket:not(.abandoned)"),
        };
      });
      expect(m.abandoned.bg, "中止の点は塗らない").toBe("rgba(0, 0, 0, 0)");
      expect(m.abandoned.borderWidth, "中止の点は border の輪").toBeGreaterThan(0);
      expect(m.abandoned.borderStyle).toBe("solid");
      expect(m.abandoned.borderColor, "輪の色が見える").not.toBe("rgba(0, 0, 0, 0)");
      expect(m.abandoned.boxSizing, "白抜きの点と同じ border-box").toBe("border-box");
      expect(m.abandoned.width, "輪も完了の点と同じ大きさ").toBe(m.done.width);
      expect(m.abandoned.opacity, "中止のタイトルは薄い").toBeLessThan(1);
      expect(m.abandoned.decoration, "打ち消し線を使わない").toBe("none");
      expect(m.done.bg, "完了の点は塗る").not.toBe("rgba(0, 0, 0, 0)");
      expect(m.done.borderWidth, "完了の点に輪はない").toBe(0);
      expect(m.done.opacity, "完了のタイトルは薄くしない").toBe(1);
    } finally {
      await context.close();
    }
  });
});

describe.each(SCHEMES)("履歴の Iteration の行（%s）", (scheme) => {
  it.each([320, ...WIDTHS])(
    "幅 %ipx で、目標は 2 行までで、件数が 1 段目の右端で行の枠からはみ出さず目標と重ならない",
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/history`, { waitUntil: "networkidle" });
        const row = page.locator(".history-row", { hasText: "左パネルを主画面" });
        await row.waitFor();
        const m = await row.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const name = el.querySelector(".name")!;
          const nameBox = name.getBoundingClientRect();
          const chips = [...el.querySelectorAll(".counts > span")].map((b) =>
            b.getBoundingClientRect(),
          );
          const main = document.querySelector(".page")!;
          return {
            chips: [...el.querySelectorAll(".counts > span")].map((b) => b.textContent),
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
            chipsBesideName: chips.every((c) => c.left >= nameBox.right - 0.5),
            pageScroll: main.scrollWidth,
            pageClient: main.clientWidth,
          };
        });
        expect(m.chips).toEqual(["1", "中止 1", "持ち越し 1"]);
        expect(m.nameLines, "目標が見えている").toBeGreaterThan(0);
        expect(m.nameLines, "目標は 2 行まで").toBeLessThanOrEqual(2);
        expect(m.chipsInside, "件数が行の枠に収まる").toBe(true);
        expect(m.chipsBesideName, "件数が目標の右に並び重ならない").toBe(true);
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

describe.each(SCHEMES)("実行計画のグラフの凡例（%s）", (scheme) => {
  it.each(WIDTHS)("幅 %ipx で、depends_on を含む凡例が折り返して幅に収まる", async (width) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
      await page.locator("button.plan-toggle").first().click();
      await page.locator(".plan-graph-legend").waitFor();
      const m = await page.evaluate(() => {
        const legend = document.querySelector(".plan-graph-legend")!;
        const graph = document.querySelector(".plan-graph")!;
        return {
          // 凡例の並びは 待ち中・待ち終わり・after・depends_on（t729）
          labels: [...legend.querySelectorAll(":scope > span")].map((s) => s.textContent),
          legendScroll: legend.scrollWidth,
          legendClient: legend.clientWidth,
          graphScroll: graph.scrollWidth,
          graphClient: graph.clientWidth,
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
        };
      });
      expect(m.labels).toEqual(["待ち中", "待ち終わり", "after", "depends_on"]);
      expect(m.legendScroll, "凡例の横の溢れ").toBeLessThanOrEqual(m.legendClient);
      expect(m.graphScroll, "グラフの横スクロールに凡例が入らない").toBeLessThanOrEqual(
        Math.max(m.graphClient, m.legendClient),
      );
      expect(m.docScroll, "文書の横スクロール").toBeLessThanOrEqual(m.docClient);
    } finally {
      await context.close();
    }
  });
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
          // すべて・s2〜s7 の 7 枚
          expect(m.chips, `${label} の札の数`).toBe(7);
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

describe("エージェントに頼む吹き出し（UI-15）", () => {
  /** カンバンの todo の行の吹き出しの不透明度（マウスを載せた行とそれ以外） */
  const opacities = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".column .row-item > .ask-bubble")].map((b) =>
        Number(getComputedStyle(b).opacity),
      ),
    );

  it.each(WIDTHS)(
    "幅 %ipx で、ふだんは隠して右端の印を見せ、マウスを載せた行にだけ出し、押した一覧は画面の中に収まる",
    async (width) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
        const rows = page.locator(".column .row-item");
        await rows.first().waitFor();
        await page.mouse.move(0, 0);
        expect(
          (await opacities(page)).every((o) => o === 0),
          "ふだんは隠す",
        ).toBe(true);
        const row = rows.nth(1);
        await row.hover();
        const shown = await opacities(page);
        expect(shown[1], "マウスを載せた行").toBe(1);
        expect(
          shown.filter((o) => o > 0),
          "ほかの行は隠したまま",
        ).toHaveLength(1);
        await row.locator(".ask-bubble").click();
        const menu = page.locator(".ask-menu");
        await menu.waitFor();
        await expect.poll(() => menu.locator("[role=menuitem]").count()).toBeGreaterThan(0);
        const box = (await menu.boundingBox())!;
        expect(box.x, "一覧の左端").toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, "一覧の右端").toBeLessThanOrEqual(width);
        expect(await menu.locator("[role=menuitem]").first().textContent()).toContain("おすすめ");
      } finally {
        await context.close();
      }
    },
  );

  it("タッチの画面（hover: none）では、マウスを載せなくても吹き出しを出す", async () => {
    const context = await browser.newContext({
      viewport: { width: 300, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=sidebar#/board`, { waitUntil: "networkidle" });
      await page.locator(".column .row-item").first().waitFor();
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
      const all = await opacities(page);
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((o) => o > 0)).toBe(true);
    } finally {
      await context.close();
    }
  });
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

// 表の行は .config-field の左の線と th の影の両方が付きうる。どちらか 1 つだけが印になる（t842）
it.each(["sidebar", "panel"])(
  "設定画面（%s）の guide.notes.* の表で、変更した行の印は 1 つだけ",
  async (surface) => {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}?surface=${surface}#/config`, { waitUntil: "networkidle" });
      const row = page.locator('tr[data-key="guide.notes.plan"]');
      await row.waitFor();
      const marks = await row.evaluate((tr) => {
        const transparent = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";
        const line = (el: Element) => {
          const s = getComputedStyle(el);
          return (
            s.borderLeftStyle !== "none" &&
            parseFloat(s.borderLeftWidth) > 0 &&
            !transparent(s.borderLeftColor)
          );
        };
        const th = tr.querySelector("th")!;
        return {
          modified: tr.classList.contains("modified"),
          marks: [
            line(tr) ? "行の左の線" : "",
            line(th) ? "th の左の線" : "",
            getComputedStyle(th).boxShadow !== "none" ? "th の影" : "",
          ].filter(Boolean),
        };
      });
      expect(marks.modified, "変更した行").toBe(true);
      expect(marks.marks, "変更した行の印").toHaveLength(1);
    } finally {
      await context.close();
    }
  },
);

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
