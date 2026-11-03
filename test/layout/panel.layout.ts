// パネルのチケット詳細の配置の確認（t286）。dg serve の画面を Chromium で ?surface=panel の配置で開き、
// s10 で決めた配置を確かめる（jsdom では幅と位置を測れないので、ここで確かめる）：
// - 右の列（属性）は 2 列のとき 248px に固定し、画面が広くても広がらない（t265）
// - タイトルと属性の 1 行の帯（.detail-head）は、スクロールしても .page の上端に残る。2 列でも、
//   1 列（幅 800px 以下）で右の列（属性）までスクロールしても残る（t263・t265）
// - Run の一覧は、パネルの幅（380px）でも横にスクロールしない（t267）
// ブラウザが要るので mise run test には入れず、mise run test:layout で回す（先に mise run build と mise run playwright:install）

import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, openContext, runCommand } from "../../packages/core/src/index.js";
import { createFixture, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";

const WEB_DIST = path.resolve(import.meta.dirname, "../../packages/web/dist");
const SCHEMES = ["light", "dark"] as const;
/** 本文を長くして、2 列でも左の列の中でスクロールできるようにする */
const LONG_BODY = [
  "## 概要",
  "",
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `パネルの配置を確かめるための本文の段落 ${i + 1}。スクロールしても帯が上に残るかを見る。`,
  ).flatMap((line) => [line, ""]),
  "## 受け入れ条件",
  "",
  "- [ ] 右の列が 248px",
  "- [ ] 帯が上に残る",
].join("\n");
/** 長いモデル名。Run の 1 行に入らなければ省略され、横にスクロールしてはいけない */
const LONG_MODEL = "a-very-long-model-name-for-checking-the-panel-run-list-layout-20261103";

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
  await call("epic.create", { title: "パネルの配置を確かめる Epic" });
  await call("ticket.create", { title: "依存先のチケット", iteration: "s1" });
  // t2：長い本文・属性の多いチケット。依存先（t1）が終わっていないので本文の上に帯も出る
  await call("ticket.create", {
    title: "パネルのチケット詳細の配置を確かめるための、かなり長めのタイトルのチケット",
    body: LONG_BODY,
    iteration: "s1",
    epic: "e1",
    priority: "high",
    labels: ["ui", "web", "layout"],
    depends_on: ["t1"],
  });
  await call("ticket.claim", { ticket: "t2", without_branch: true });
  // Run：長いモデル名・再試行・失敗の理由のある閉じた Run と、実行中の Run
  for (const [step, result] of [
    ["implement", "failure"],
    ["implement", "success"],
    ["review", "success"],
  ] as const) {
    const run = await call<{ id: string }>("run.start", {
      ticket: "t2",
      step,
      agent: "claude-code",
      model: LONG_MODEL,
    });
    await call("run.finish", {
      run: run.id,
      result,
      ...(result === "failure"
        ? { error: "テストが落ちたのでやり直した。理由の文が長くても横にはみ出さない" }
        : { retry_reasons: ["見直しの指摘を直した", "型の誤りを直した"] }),
    });
  }
  await call("run.start", { ticket: "t2", step: "implement", agent: "my-bot", model: LONG_MODEL });
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

/** 幅 width・高さ height の ?surface=panel でチケット t2 の詳細を開き、Run と属性が出るまで待つ */
async function openDetail(width: number, scheme: (typeof SCHEMES)[number], height = 600) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(`${server.url}?surface=panel#/tickets/t2`, { waitUntil: "networkidle" });
  await page.locator(".detail-head").waitFor();
  await page.locator(".ticket-run").first().waitFor();
  await page.locator(".props-groups").waitFor();
  return { context, page };
}

/** 崩れた画面を後から見られるように残す（.gitignore の .playwright-mcp/） */
async function keep(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `.playwright-mcp/panel-${name}.png` });
}

/** .page を target までスクロールし、帯の上端と .page の上端の差を測る */
function stickyAt(page: Page, target: "bottom" | "aside") {
  return page.evaluate((target) => {
    const main = document.querySelector<HTMLElement>(".page")!;
    if (target === "bottom") main.scrollTop = main.scrollHeight;
    else document.querySelector(".detail > aside")!.scrollIntoView({ block: "start" });
    const head = document.querySelector(".detail-head")!.getBoundingClientRect();
    const box = main.getBoundingClientRect();
    const aside = document.querySelector(".detail > aside")!.getBoundingClientRect();
    return {
      scrollTop: main.scrollTop,
      gap: head.top - box.top,
      height: head.height,
      /** 右の列の上端が帯の下端より上まで来たか（右の列までスクロールしたか） */
      asideReached: aside.top <= box.top + head.height,
    };
  }, target);
}

describe.each(SCHEMES)("パネルのチケット詳細の配置（%s）", (scheme) => {
  it.each([1100, 1600])("幅 %ipx で、2 列になり右の列が 248px に固定される", async (width) => {
    const { context, page } = await openDetail(width, scheme);
    try {
      const m = await page.evaluate(() => {
        const main = document.querySelector(".detail-main")!.getBoundingClientRect();
        const aside = document.querySelector(".detail > aside")!.getBoundingClientRect();
        return { aside: aside.width, mainRight: main.right, asideLeft: aside.left };
      });
      if (m.aside !== 248) await keep(page, `${scheme}-${width}-aside`);
      expect(m.aside, "右の列の幅").toBe(248);
      expect(m.asideLeft, "右の列が本文の右に並ぶ").toBeGreaterThan(m.mainRight);
    } finally {
      await context.close();
    }
  });

  it.each([
    [1100, "bottom"],
    [800, "aside"],
    [800, "bottom"],
    [600, "aside"],
  ] as const)(
    "幅 %ipx で %s までスクロールしても、見出しの帯が .page の上端に残る",
    async (width, target) => {
      // 高さを右の列より低くし、1 列で右の列の上端までスクロールできるようにする（左の列が画面の上に消える）
      const { context, page } = await openDetail(width, scheme, 360);
      try {
        const columns = await page.evaluate(
          () =>
            getComputedStyle(document.querySelector(".detail")!).gridTemplateColumns.split(" ")
              .length,
        );
        expect(columns, "列の数").toBe(width > 800 ? 2 : 1);
        const m = await stickyAt(page, target);
        if (Math.abs(m.gap) > 1) await keep(page, `${scheme}-${width}-${target}-sticky`);
        // スクロールしていなければ帯が上にあるのは当たり前なので、スクロールしたことも確かめる
        expect(m.scrollTop, "スクロールした量").toBeGreaterThan(m.height);
        if (target === "aside") expect(m.asideReached, "右の列までスクロールした").toBe(true);
        expect(Math.abs(m.gap), "帯の上端と .page の上端の差").toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    },
  );

  it("幅 380px で、Run の一覧が横にスクロールせず、画面も横に溢れない", async () => {
    const { context, page } = await openDetail(380, scheme);
    try {
      // 開いた Run の詳細（失敗の理由など）もはみ出さないことを見るため、すべて開く
      for (const summary of await page.locator(".ticket-run > summary").all())
        await summary.click();
      const m = await page.evaluate(() => {
        const runs = document.querySelector<HTMLElement>(".runs")!;
        const list = document.querySelector<HTMLElement>(".ticket-runs")!;
        const main = document.querySelector<HTMLElement>(".page")!;
        const right = runs.getBoundingClientRect().right;
        // 行（summary）は overflow: hidden なので、はみ出しても横スクロールにならず隠れる。
        // 行と開いた詳細の中の部品の右端が Run の節の右端を越えないことも確かめる
        const partRights = [
          ...list.querySelectorAll(".ticket-run > summary > *, .ticket-run-detail > *"),
        ].map((el) => el.getBoundingClientRect().right);
        return {
          parts: partRights.length,
          runs: [runs.scrollWidth, runs.clientWidth],
          list: [list.scrollWidth, list.clientWidth],
          page: [main.scrollWidth, main.clientWidth],
          doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
          over: partRights.filter((r) => r > right + 0.5).length,
        };
      });
      const wide = (pair: number[]) => pair[0]! > pair[1]!;
      if (wide(m.runs) || wide(m.list) || wide(m.page) || wide(m.doc) || m.over > 0)
        await keep(page, `${scheme}-380-runs`);
      expect(m.parts, "Run の行と詳細の部品の数").toBeGreaterThan(4 * 4);
      expect(m.runs[0], "Run の節の横スクロール").toBeLessThanOrEqual(m.runs[1]!);
      expect(m.list[0], "Run の一覧の横スクロール").toBeLessThanOrEqual(m.list[1]!);
      expect(m.page[0], ".page の横スクロール").toBeLessThanOrEqual(m.page[1]!);
      expect(m.doc[0], "画面の横スクロール").toBeLessThanOrEqual(m.doc[1]!);
      expect(m.over, "Run の節からはみ出した部品").toBe(0);
    } finally {
      await context.close();
    }
  });
});
