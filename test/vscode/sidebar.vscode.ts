// VS Code の実機で左パネルの Webview を確かめる（t439）。bare リモート付きの一時リポジトリを dg init し、
// 拡張開発ホストを Xvfb 上に起動して（host.ts）、Activity Bar の deguboard からサイドバーのビューを開き：
// - カンバンにチケットの行が出て、タブ（バックログ）に切り替えても戻しても行が出ること
// - 行を押すとエディタ領域のパネルに詳細が開くこと（Webview → 拡張ホストのやり取り）
// - ウィンドウ全体（ワークベンチと Webview）に CSP 違反と捕まえていない例外が 1 つもないこと（検出が効くことは、Webview の中でわざと違反と例外を起こして確かめる）
// - 未 push のコミットがある間はタイトル行の同期のボタンが点付きになり、押して同期すると元に戻ること（UI-6）
// - ライトとダークのテーマでスクリーンショット（カンバン・バックログ・「表示」のメニュー・行のラベルで絞ったところ・統合済みの名前で絞ったところ・詳細のラベルの語彙の選択・更新日で並べたメニューと行・選んだ行の帯と ID のコピーの形のメニューとコピーした後の帯・頼む小窓とコピーした後のボタン・Epic の札に触れて光らせた行・選んでいる Epic の見出し・Run の丸と回数を出した Done の行・実行計画の依存グラフ・設定画面と振り返りの節と Workflow のタブ・履歴の見方の切り替え）を test/vscode/screenshots/ に出すこと
// - 導入のチェックリストの「アンインストール」の節で、消すものを確かめてから一時リポジトリを外せること（閉じた節・開いた節・確認・外した後の知らせを撮る。
//   ボードを消すので、ボードの要る検査の後に置く。HOME は一時ディレクトリなので、手元の個人の設定には触れない）
// VS Code 本体のダウンロードと画面が要るので mise run test には入れず、mise run test:vscode で回す（先に mise run build）

import { access, appendFile } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  configSet,
  configUnset,
  epicCreate,
  init,
  iterationCreate,
  iterationStart,
  labelAdd,
  labelAxisSet,
  openContext,
  planApprove,
  planCreate,
  RECOMMENDED_RETRO_METRICS,
  retroMetric,
  retroPerspective,
  runCommand,
  runFinish,
  runStart,
  syncStatus,
  ticketClaim,
  ticketCreate,
  ticketMove,
  ticketUpdate,
  uninstallRouteOf,
  workflowSet,
} from "../../packages/core/src/index.js";
import { withWrite } from "../../packages/core/src/git/write.js";
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

/** 画面を撮る準備で、PR を作らずにチケットを done にする理由（境目の requires の pr_merged を人が外す。t1039） */
const DONE_OVERRIDE = "preparing the VS Code screen test without a PR";

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
  // 目標はカンバンの見出しで 3 行を超えて「…」で切れる長さにし、中の ID（e1・t1）はリンクにして撮る。
  // 実機の表示言語は英語で、日本語のフォントがない環境もあるので英語で書く
  await runCommand(iterationCreate, ctx, {
    name: "実機の週",
    goal: "Ship the first version of e1. Check how rows look with t1, move the claimed ticket to review this week, return the rest to the backlog, and write down what is left for the next Iteration",
  });
  await runCommand(iterationStart, ctx, { iteration: "s1" });
  await runCommand(epicCreate, ctx, { title: "実機の Epic" });
  // t1・t2 は s1 のカンバン、t3 はカンバンの作業中。バックログ（Iteration なし）にも行が出るよう 2 件目は入れない。
  // t1 だけ Epic e1 に入れ、札に触れて光らせる行と薄くする行を撮る。
  // 行のラベル（UI-2・UI-3）を撮るため、t1 は 4 つ（3 つと「+1」）のラベルと PR（ラベルは PR の右）、t2 は 1 つのラベル、
  // t3 は 1 つのラベルと手順のラベル（audit-s1。目立たない見た目）を持つ。
  // 札の色を軸ごとに分けて撮るため、軸 area（web・ui）と kind（docs・gate）の語彙を置き、cli と release は語彙にない名前（「?」の印）にする。
  await runCommand(labelAxisSet, ctx, {
    name: "area",
    description: "Which part the ticket touches",
  });
  await runCommand(labelAxisSet, ctx, { name: "kind", description: "What kind of change it is" });
  const vocabulary: Array<[string, string, string]> = [
    ["web", "area", "The screens of the web package"],
    ["ui", "area", "How the screens look and behave"],
    ["docs", "kind", "Documents for users and contributors"],
    ["gate", "kind", "The quality gate and its checks"],
  ];
  for (const [name, axis, description] of vocabulary)
    await runCommand(labelAdd, ctx, { name, axis, description });
  await runCommand(ticketCreate, ctx, {
    title: TITLES[0],
    acceptance: ["行が出る"],
    iteration: "s1",
    epic: "e1",
    labels: ["web", "docs", "ui", "cli"],
  });
  await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 12 });
  await runCommand(ticketCreate, ctx, {
    title: TITLES[1],
    acceptance: ["行が出る"],
    labels: ["release", "frontend"],
  });
  await runCommand(ticketCreate, ctx, {
    title: TITLES[2],
    acceptance: ["行が出る"],
    iteration: "s1",
    labels: ["gate", "audit-s1"],
  });
  await runCommand(ticketClaim, ctx, { ticket: "t3", without_branch: true });
  // 統合済みの名前で絞ったところを撮るため、frontend を web に統合した記録だけを labels.yaml に書き、t2 に統合の前の名前 frontend を残す。
  // dg label merge はチケットも書き換えるので、統合の後に残った古い名前（lint が指摘する）を作るために記録を直接書く
  await withWrite(
    ctx,
    () =>
      appendFile(
        path.join(ctx.repo.dataDir, "labels.yaml"),
        [
          "frontend:",
          "  axis: area",
          "  description: The old name of web",
          "  created_at: 2026-01-01T00:00:00Z",
          "  merged_into: web",
          "  merged_at: 2026-01-02T00:00:00Z",
          "",
        ].join("\n"),
      ),
    { message: "frontend を web に統合した記録を書く" },
  );
  // 設定画面の振り返りの節を撮るため、review に推薦の指標を 2 つ記録し、cost の問いを書き換え（変更あり）、既定にない観点 flow を足す（変更あり・指標なし）
  for (const id of ["first-pass-rate", "rounds-per-reviewed"] as const) {
    const metric = RECOMMENDED_RETRO_METRICS["review"]![id]!;
    await runCommand(retroMetric, ctx, { perspective: "review", id, ...metric });
  }
  await runCommand(retroPerspective, ctx, {
    id: "cost",
    question: "Where did the time and the tokens go, by ticket and by step?",
  });
  await runCommand(retroPerspective, ctx, {
    id: "flow",
    name: "Flow",
    question: "Did the work move from claim to merge without waiting for people?",
  });
  // 設定画面の Workflow のタブを撮るため、既定と違う値（WIP の上限・リリースの段階）と独自の段階を workflow.yaml に書く。
  // リリースの段階は既定（packages/core/src/workflow/resolve.ts）と違う決め方にし、行に変更ありの印を出す。
  // 既定が変わってこの値と同じになると印が出ず、設定画面のテストが待ち続けるので、そのときはここを直す。
  // ほかの画面を変えないよう、Status の表示名と境目は既定のままにする
  await runCommand(workflowSet, ctx, {
    definition: {
      wip: { in_progress: 3 },
      flow: {
        release: "ask_unless_auto",
        "deploy-staging": {
          decide: "always_ask",
          after: "audit",
          guide: "docs/flow/deploy-staging.md",
        },
      },
    },
  });
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
    // パネルの題はチケットの ID だけ（t1。t726）。ID の完全一致で待ち、ほかのタブの文字に当たらないようにする
    await host.page.locator(".part.editor .tab", { hasText: /^t1$/ }).waitFor();
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

  it("「表示」のメニューを開いたところと、行のラベルで絞ったところをライトとダークで撮る", async () => {
    const toggle = sidebar.locator(".board-head .view-toggle");
    await toggle.click();
    await sidebar.locator(".view-menu-list").waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("view-menu", theme);
      await access(shot.sidebar);
    }
    await host.page.keyboard.press("Escape");
    await sidebar.locator(".view-menu-list").waitFor({ state: "detached" });

    // 行のラベルを押すとそのラベルで絞り、見出しの下に × の札を出す。札の × で外す
    await sidebar.locator(".row-labels .row-label", { hasText: "docs" }).click();
    const chip = sidebar.locator(".filter-chips .filter-chip", { hasText: "docs" });
    await chip.waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("label-filter", theme);
      await access(shot.sidebar);
    }
    await chip.locator("button").click();
    await chip.waitFor({ state: "detached" });
    await sidebar.locator(".ticket-row", { hasText: TITLES[2] }).waitFor();
  });

  it("統合済みの名前で絞ると、カンバンの札に統合先で絞っていることを添え、バックログのラベルの選択に統合先を出すところをライトとダークで撮る", async () => {
    // 前の URL の統合済みの名前（frontend）で開くと、統合先の web で絞る
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/board?label=frontend";
    });
    const chip = sidebar.locator(".filter-chips .filter-chip", { hasText: "frontend" });
    await chip.waitFor();
    await sidebar.locator(".ticket-row", { hasText: TITLES[0] }).waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("label-merged", theme);
      await access(shot.sidebar);
    }
    await chip.locator("button").click();
    await chip.waitFor({ state: "detached" });

    // バックログは統合の前の名前が残った行（t2）の札を押して絞る。条件の札は一覧を送ったときの帯にだけ出るので、
    // 絞り込みの欄を開き、ラベルの選択に統合先の web が選ばれているところを撮る
    await sidebar.locator('nav a[href="#/backlog"]').click();
    await sidebar.locator(".ticket-row", { hasText: TITLES[1] }).waitFor();
    await sidebar.locator(".row-labels .row-label", { hasText: "frontend" }).click();
    const toggle = sidebar.locator(".filter-toggle.active");
    await toggle.click();
    const labelSelect = sidebar.locator("#backlog-filters select").nth(2);
    await expect.poll(() => labelSelect.inputValue()).toBe("web");
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("label-merged-backlog", theme);
      await access(shot.sidebar);
    }
    await labelSelect.selectOption("");
    await sidebar.locator(".filter-toggle.open").click();
    await sidebar.locator("#backlog-filters").waitFor({ state: "detached" });
    await sidebar.locator('nav a[href="#/board"]').click();
    await sidebar.locator(".ticket-row", { hasText: TITLES[0] }).waitFor();
  });

  it("詳細の属性の欄でラベルを直すとき、入力欄の下に軸ごとの語彙と説明が出たところをライトとダークで撮り、Esc で閉じる", async () => {
    const panel = host.panelFrame();
    // テーマを切り替えるとフォーカスが欄の外へ出て閉じるので、テーマごとに開き直す。表示言語は英語（「ラベルを変える」は Change Labels）
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      await panel.locator('[aria-label="Change Labels"]').click();
      await panel.locator(".label-picker").waitFor();
      const shot = await host.screenshot("label-picker", theme);
      await access(shot.window);
      await host.page.keyboard.press("Escape");
      await panel.locator(".label-picker").waitFor({ state: "detached" });
    }
  });

  it("「表示」の並び順で更新日を選んだメニューと、並びの札と行の相対の更新時刻をライトとダークで撮り、札の × で既定に戻す", async () => {
    await sidebar.locator(".board-head .view-toggle").click();
    await sidebar.locator(".view-menu-list").waitFor();
    // 実機の画面は英語なので、更新日は英語の名前（l10n-en.ts の 更新日）で引く。押す前の既定（優先度）も
    // 選ばれた印を持つので、押した項目そのものが選ばれるまで待つ
    const updated = sidebar.locator('.view-menu-group [role="menuitemradio"]', {
      hasText: "Updated",
    });
    await updated.click();
    await expect.poll(() => updated.getAttribute("aria-checked")).toBe("true");
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("sort-menu", theme);
      await access(shot.sidebar);
    }
    await host.page.keyboard.press("Escape");
    await sidebar.locator(".view-menu-list").waitFor({ state: "detached" });

    const chip = sidebar.locator(".filter-chips .sort-chip");
    await chip.waitFor();
    await sidebar.locator(".row-sub .row-updated").first().waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("sort-updated", theme);
      await access(shot.sidebar);
    }
    await chip.locator("button").click();
    await chip.waitFor({ state: "detached" });
    expect(await sidebar.locator(".row-updated").count()).toBe(0);
  });

  it("カンバンの Epic の札に触れるとその Epic の行を光らせ、ほかを薄くするところをライトとダークで撮る", async () => {
    const chip = sidebar.locator(".epic-chips .epic-chip", { hasText: "e1" });
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      await chip.hover();
      await sidebar.locator(".ticket-row.epic-hit", { hasText: TITLES[0] }).waitFor();
      await sidebar.locator(".ticket-row.epic-dim", { hasText: TITLES[2] }).waitFor();
      const shot = await host.screenshot("epic-highlight", theme);
      await access(shot.sidebar);
    }
    // 札から離れると戻る
    await sidebar.locator(".head-line.sub").hover();
    await sidebar.locator(".ticket-row.epic-hit, .ticket-row.epic-dim").first().waitFor({
      state: "detached",
    });
  });

  it("Epic で絞ると選んでいる Epic の見出しが出て、触れると吹き出しが出るところを、カンバンとバックログのライトとダークで撮る", async () => {
    const chip = sidebar.locator(".epic-chips .epic-chip", { hasText: "e1" });
    const head = sidebar.locator(".epic-head");
    await chip.click();
    await head.waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      await head.hover();
      const shot = await host.screenshot("epic-head", theme);
      await access(shot.sidebar);
    }
    // × で絞り込みを外すと見出しが消え、ほかの Epic の行が戻る
    await head.locator(".epic-head-clear").click();
    await head.waitFor({ state: "detached" });
    await sidebar.locator(".ticket-row", { hasText: TITLES[2] }).waitFor();

    // バックログは絞る前に区画の見出し（期間と、目標の中の ID のリンク）を撮り、そのあと「なし」で絞る（Iteration に入っていない t2 は Epic がない）
    await sidebar.locator('nav a[href="#/backlog"]').click();
    await sidebar.locator(".ticket-row", { hasText: TITLES[1] }).waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("backlog", theme);
      await access(shot.sidebar);
    }
    await sidebar.locator(".epic-chips .epic-chip.loose").click();
    await head.waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      await head.hover();
      const shot = await host.screenshot("epic-head-backlog", theme);
      await access(shot.sidebar);
    }
    await head.locator(".epic-head-clear").click();
    await head.waitFor({ state: "detached" });
    await sidebar.locator('nav a[href="#/board"]').click();
    await sidebar.locator(".ticket-row", { hasText: TITLES[0] }).waitFor();
  });

  it("カンバンで行を 2 件選ぶと、帯に「ID をコピー」と ▾ と × が 1 行に並び、▾ のメニューとコピーした後の帯をライトとダークで撮る", async () => {
    // 実機の画面は英語なので、名前は英語の訳（l10n-en.ts）で引く
    await sidebar.locator('nav a[href="#/board"]').click();
    for (const title of [TITLES[0], TITLES[2]]) {
      await sidebar.getByRole("link", { name: new RegExp(title) }).click({
        modifiers: ["ControlOrMeta"],
      });
    }
    const bar = sidebar.getByRole("region", { name: "Selected rows" });
    await bar.getByText("2 selected").waitFor();
    const copyIds = bar.getByRole("button", { name: "Copy IDs" });
    const formats = bar.getByRole("button", { name: "Choose what to copy" });
    const clear = bar.getByRole("button", { name: "Clear selection" });
    // 左パネルの幅で 1 行に収まる（ボタンの縦の位置がそろう）
    const tops = await Promise.all(
      [bar.getByRole("button", { name: "Ask" }), copyIds, formats, clear].map(
        async (b) => (await b.boundingBox())!.y,
      ),
    );
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(4);
    // × は帯の中に収まり、件数（2 selected）も切れない
    const barBox = (await bar.boundingBox())!;
    const clearBox = (await clear.boundingBox())!;
    expect(clearBox.x + clearBox.width).toBeLessThanOrEqual(barBox.x + barBox.width);
    const count = bar.getByText("2 selected");
    expect(await count.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("selection-bar", theme);
      await access(shot.sidebar);
    }
    await formats.click();
    const menu = sidebar.getByRole("menu", { name: "Copy as" });
    await menu.getByRole("menuitem", { name: /IDs and titles/ }).waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      if (!(await menu.isVisible())) await formats.click();
      await menu.waitFor();
      const shot = await host.screenshot("copy-formats", theme);
      await access(shot.sidebar);
    }
    // ▾ をもう一度押して閉じる（テーマを替えた後はフォーカスが Webview の外にあり、Esc が届かないことがある）
    await formats.click();
    await menu.waitFor({ state: "detached" });
    // コピーした後は、ボタンの下の行に何件の何をコピーしたかを少しの間出す（撮る前に押し直す）。
    // 知らせは COPY_NOTICE_MS で消えるので、撮り終えた後もまだ出ていれば撮った絵にも写っている。消えていたら撮り直す
    const copied = bar.getByText("Copied 2 IDs");
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      for (let attempt = 1; ; attempt++) {
        await copyIds.click();
        await copied.waitFor();
        const shot = await host.screenshot("ids-copied", theme);
        await access(shot.sidebar);
        if (await copied.isVisible()) break;
        if (attempt === 5) throw new Error(`コピーの知らせが写るように撮れなかった（${theme}）`);
      }
    }
    await clear.click();
    await bar.waitFor({ state: "detached" });
  });

  it("行の吹き出しから頼む小窓を開き、見出しの行・Skill の札・下の段のボタンと、コピーした後のボタンの ✓ をライトとダークで撮る。✓ で小窓の高さは変わらない（t1160）", async () => {
    await sidebar.locator('nav a[href="#/board"]').click();
    const row = sidebar.locator(".ticket-row", { hasText: TITLES[2] });
    await row.hover();
    await sidebar.getByRole("button", { name: "Ask Agent (Row t3)" }).click();
    await sidebar.getByRole("menuitem").first().click();
    const composer = sidebar.getByRole("region", { name: "Ask Agent" });
    await composer.locator(".ask-heading").getByText(TITLES[2]).waitFor();
    // 選んで開くと同時にコピーするので、ボタンの ✓ が出て戻ってから撮る
    const copy = composer.getByRole("button", { name: "Copy" });
    const done = composer.locator("button.ask-copy.ask-done");
    await done.waitFor();
    await done.waitFor({ state: "detached" });
    // 一時リポジトリには dg の Skill がなく既定は文章の形なので、Skill の形に切り替えて Skill の札を出す（撮った後に戻す）
    const format = composer.getByRole("button", { name: "Format: Text" });
    await format.click();
    await composer.locator(".ask-meaning .ask-skill").waitFor();
    const height = (await composer.boundingBox())!.height;
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("ask-composer", theme);
      await access(shot.sidebar);
    }
    // ✓ は ASK_DONE_MS で戻るので、撮り終えた後もまだ出ていれば撮った絵にも写っている。戻っていたら撮り直す
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      for (let attempt = 1; ; attempt++) {
        await copy.click();
        await done.waitFor();
        expect((await composer.boundingBox())!.height).toBe(height);
        const shot = await host.screenshot("ask-copied", theme);
        await access(shot.sidebar);
        if (await done.isVisible()) break;
        if (attempt === 5) throw new Error(`コピーの ✓ が写るように撮れなかった（${theme}）`);
      }
    }
    await composer.getByRole("button", { name: "Format: Skill" }).click();
    await composer.getByRole("button", { name: "Format: Text" }).waitFor();
    await composer.getByRole("button", { name: "Close" }).click();
    await composer.waitFor({ state: "detached" });
  });

  it("行の吹き出しの一覧のおすすめの青い点と、小窓の候補の行（おすすめ・選んでいる候補・「ほか N ▾」）と開いた一覧をライトとダークで撮る（t1161）", async () => {
    await sidebar.locator('nav a[href="#/board"]').click();
    const row = sidebar.locator(".ticket-row", { hasText: TITLES[2] });
    await row.hover();
    await sidebar.getByRole("button", { name: "Ask Agent (Row t3)" }).click();
    const menu = sidebar.getByRole("menu");
    await menu.locator(".ask-rec").waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("ask-menu-rec", theme);
      await access(shot.sidebar);
    }
    // おすすめでない候補（2 番目）を選んで開くと、行はおすすめ・その候補・「ほか N ▾」になる
    await menu.getByRole("menuitem").nth(1).click();
    const composer = sidebar.getByRole("region", { name: "Ask Agent" });
    await composer.locator(".ask-heading").getByText(TITLES[2]).waitFor();
    const done = composer.locator("button.ask-copy.ask-done");
    await done.waitFor();
    await done.waitFor({ state: "detached" });
    const suggestions = composer.locator(".ask-suggestions > button");
    expect(await suggestions.count()).toBe(3);
    await composer.locator(".ask-more").click();
    await composer.getByRole("menu").waitFor();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("ask-more", theme);
      await access(shot.sidebar);
    }
    // Esc は一覧だけを閉じ、小窓は残る。テーマの切り替えで窓の大きさが変わると一覧は閉じるので、開き直してから押す
    if (!(await composer.getByRole("menu").isVisible()))
      await composer.locator(".ask-more").click();
    await composer.getByRole("menuitem").first().press("Escape");
    await composer.getByRole("menu").waitFor({ state: "detached" });
    await composer.waitFor();
    await composer.getByRole("button", { name: "Close" }).click();
    await composer.waitFor({ state: "detached" });
  });

  it("設定画面に並列の上限（work.parallel）の数の欄が出て、ライトとダークで撮る", async () => {
    // 画面の中の歯車は文言に頼らず、ハッシュで設定画面に移る
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/config";
    });
    const input = sidebar.locator("#config-work-parallel");
    await input.waitFor({ timeout: 60_000 });
    expect(await input.getAttribute("type")).toBe("number");
    expect(await input.inputValue()).toBe("3");
    await input.scrollIntoViewIfNeeded();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("config", theme);
      await access(shot.sidebar);
    }
    // 振り返りの節：観点の行と指標の子の行（1 つ目の指標の「詳しく」を開く）、下の方の変更ありの観点（問いを書き換えた cost・足した flow）を撮る。
    // 上に貼り付くタブの説明に観点の行の頭が隠れないよう、行の頭を説明の下に出す
    const review = sidebar.locator('[data-perspective="review"]');
    await review.locator('[data-metric="review.first-pass-rate"] .config-more > summary').click();
    await sidebar.locator('[data-perspective="flow"].modified').waitFor();
    for (const [name, id] of [
      ["config-retro", "review"],
      ["config-retro-modified", "cost"],
    ] as const) {
      await sidebar.locator(`[data-perspective="${id}"]`).evaluate((el) => {
        el.scrollIntoView({ block: "start" });
        const note = document.querySelector(".config-scope");
        const covered = note
          ? note.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 8
          : 0;
        let box = el.parentElement;
        while (
          box &&
          !(
            box.scrollHeight > box.clientHeight &&
            /auto|scroll/.test(getComputedStyle(box).overflowY)
          )
        )
          box = box.parentElement;
        if (covered > 0) (box ?? document.scrollingElement)?.scrollBy(0, -covered);
      });
      for (const theme of ["dark", "light"] as const) {
        await host.setTheme(theme);
        const shot = await host.screenshot(name, theme);
        await access(shot.sidebar);
      }
    }
    // Workflow のタブ（読むだけ）：頭（帯・検索・状態の節）と、既定と違う行と独自の段階のある流れの段階の節を撮る。入力欄は検索だけ
    await sidebar.locator("#config-tab-workflow").click();
    const flow = sidebar.locator('section[data-section="flow"]');
    await flow
      .locator('tr[data-key="workflow.flow.deploy-staging"] .config-custom-stage')
      .waitFor();
    await flow.locator('tr[data-key="workflow.flow.release"].modified').waitFor();
    expect(await sidebar.locator("#config-panel input, #config-panel select").count()).toBe(1);
    for (const [name, key, block] of [
      ["config-workflow", "states", "end"],
      ["config-workflow-flow", "flow", "center"],
    ] as const) {
      await sidebar
        .locator(`section[data-section="${key}"]`)
        .evaluate((el, at) => el.scrollIntoView({ block: at }), block);
      for (const theme of ["dark", "light"] as const) {
        await host.setTheme(theme);
        const shot = await host.screenshot(name, theme);
        await access(shot.sidebar);
      }
    }
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/board";
    });
  });

  it("実行計画の依存グラフを開き、待ちの状態と由来の 4 種類の辺と段を飛ぶ辺をライトとダークで撮る", async () => {
    // t4 は done。t5 は depends_on で t4 を（待ち終わり）、t6 は after で t4 を（待ち終わり）、
    // t7 は after で t5 を（待ち中）と t4 を（待ち終わり。段 1 を飛ぶので行の間の溝を通る）、t8 は depends_on で t6 を（待ち中）待つ。
    // Plan の順（t8 が t7 の前）のままだと t5→t7 と t6→t8 が交差するので、段 2 は t7・t8 の順に並べ替わる
    // 実行計画はカンバンに出るので、前のテストがどの画面で終わっても（失敗して設定画面に残っても）自分でカンバンに移る
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/board";
    });
    const ctx = await openContext({ cwd: fixture.cloneA });
    for (const [i, depends_on] of [[], ["t4"], [], [], ["t6"]].entries()) {
      await runCommand(ticketCreate, ctx, {
        title: `実行計画のチケット ${i + 1}`,
        acceptance: ["辺が出る"],
        iteration: "s1",
        depends_on,
      });
    }
    await runCommand(planCreate, ctx, {
      tickets: ["t4", "t5", "t6", "t8", "t7"],
      after: { t6: ["t4"], t7: ["t5", "t4"] },
    });
    await runCommand(planApprove, ctx, { plan: "p1" });
    // 既定の Workflow は done に pr_merged を求めるので、準備は人（openContext の既定の主体）の --override で done にする（製品の既定は緩めない。t1039）
    await runCommand(ticketMove, ctx, { ticket: "t4", status: "done", override: DONE_OVERRIDE });
    const toggle = sidebar.locator(".plan-item button.plan-toggle");
    await toggle.waitFor({ timeout: 60_000 });
    await toggle.click();
    const graph = sidebar.locator(".plan-graph");
    await graph.waitFor();
    // ticketMove（t4 → done）が画面に届く前の描画では 5 本とも待ち中に見えるので、t4 の箱が done になった描画を待ってから、
    // 待ちの線が 2 本になるまで画面を見て数える（t873）
    await sidebar
      .locator(".plan-graph-canvas .plan-node.status-done", { hasText: /^t4$/ })
      .waitFor({ timeout: 60_000 });
    expect(await sidebar.locator(".plan-graph-canvas .plan-graph-edge").count()).toBe(5);
    await expect
      .poll(() => sidebar.locator(".plan-graph-canvas .plan-graph-edge-pending").count())
      .toBe(2);
    await graph.scrollIntoViewIfNeeded();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("plan", theme);
      await access(shot.sidebar);
    }
  });

  it("履歴のチケットの見方を開き、見方の切り替えと結果の絞り込みの間隔をライトとダークで撮る", async () => {
    // 単独実行でも履歴が空にならないよう、このテスト専用の完了チケットを作る（t892）。
    const ctx = await openContext({ cwd: fixture.cloneA });
    const ticket = await runCommand(ticketCreate, ctx, {
      title: "履歴の切り替えを確かめる完了チケット",
      acceptance: ["履歴に行が出る"],
      iteration: "s1",
    });
    await runCommand(ticketMove, ctx, {
      ticket: ticket.data.id,
      status: "done",
      override: DONE_OVERRIDE,
    });
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/history?view=ticket";
    });
    await sidebar.locator(".result-switch").waitFor({ timeout: 60_000 });
    await sidebar
      .locator(".ticket-row", { hasText: ticket.data.title })
      .waitFor({ timeout: 60_000 });
    expect(await sidebar.locator(".view-switch:not(.result-switch) button").count()).toBe(3);
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("history", theme);
      await access(shot.sidebar);
    }
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/board";
    });
  });

  it("カンバンの Done の節を開き、Run の丸の並びと Run の回数を出した Done の行をライトとダークで撮る（UI-2）", async () => {
    // 5 回の Run（新しい 3 件のうち最後は失敗）を閉じてから done にする。Done の行は「+n」と地の色を出さず、最後の丸の横に「5 runs」を出す
    const ctx = await openContext({ cwd: fixture.cloneA });
    const ticket = await runCommand(ticketCreate, ctx, {
      title: "Done row with five runs",
      acceptance: ["丸と回数が出る"],
      iteration: "s1",
    });
    const id = ticket.data.id;
    const steps = [
      ["implement", "success"],
      ["review", "success"],
      ["fix", "success"],
      ["review", "success"],
      ["merge", "failure"],
    ] as const;
    for (const [step, result] of steps) {
      const run = await runCommand(runStart, ctx, { ticket: id, step, agent: "claude-code" });
      await runCommand(runFinish, ctx, { run: run.data.id, result });
    }
    await runCommand(ticketMove, ctx, { ticket: id, status: "done", override: DONE_OVERRIDE });
    const done = sidebar.locator("details.column.status-done");
    await done.waitFor({ timeout: 60_000 });
    // Done の節は既定で畳む。見出しを押すとポインタとフォーカスが残り、頼むボタンが出て行を隠すので、押さずに開く（onToggle が開いたことを覚える）
    const setOpen = (open: boolean) =>
      done.evaluate((el, open) => {
        (el as HTMLDetailsElement).open = open;
      }, open);
    await setOpen(true);
    const row = done.locator(".ticket-row", { hasText: "Done row with five runs" });
    await row.locator(".run-pips-caption", { hasText: "5 runs" }).waitFor({ timeout: 60_000 });
    expect(await row.locator(".run-pip").count()).toBe(3);
    expect(await row.locator(".run-pips-more").count()).toBe(0);
    // done に動いた行の点滅（.changed）が終わってから撮る
    await expect
      .poll(() => row.evaluate((el) => !!el.closest(".changed") || !!el.querySelector(".changed")))
      .toBe(false);
    await row.scrollIntoViewIfNeeded();
    for (const theme of ["dark", "light"] as const) {
      await host.setTheme(theme);
      const shot = await host.screenshot("board-done-runs", theme);
      await access(shot.sidebar);
    }
    // 後のテストの画面を変えないよう、Done の節を畳み直す
    await setOpen(false);
  });

  it("未 push のコミットがある間はタイトル行の同期のボタンが点付きになって件数をツールチップに出し、押して同期すると元のアイコンに戻る（UI-6。ライトとダークで撮る）", async () => {
    const dotted = host.page
      .locator('.part.sidebar a.action-label[aria-label^="Sync ("]')
      .locator("visible=true");
    const plain = host.page
      .locator(".part.sidebar a.action-label.codicon-sync")
      .locator("visible=true");
    // ここまでの書き込みは push 済みなので点はない。個人の設定で書き込みごとにコミットし、push は同期のときだけにして、未 push のコミットを 1 つ作る
    // （テンプレートの commit.mode は batch で、コミットしない）
    await plain.waitFor({ timeout: 60_000 });
    const ctx = await openContext({ cwd: fixture.cloneA });
    const personal = [
      ["commit.mode", "each"],
      ["push.mode", "manual"],
    ] as const;
    // 途中で落ちても、個人の設定を後のテストに残さないよう finally で戻す
    try {
      for (const [key, value] of personal)
        await runCommand(configSet, ctx, { key, value, local: true });
      // 設定は開いたときに読むので、書き換えた設定で開き直して書く。起票はすぐ push するので、題の書き換えで作る
      const manual = await openContext({ cwd: fixture.cloneA });
      await runCommand(ticketUpdate, manual, { ticket: "t2", title: `${TITLES[1]}（未 push）` });
      expect((await syncStatus(manual.repo)).ahead).toBe(1);
      // 左パネルが間を空けて読む同期の状態から差し替わる
      await dotted.waitFor({ timeout: 60_000 });
      expect(await dotted.getAttribute("aria-label")).toBe("Sync (1 unpushed)");
      expect(await plain.count()).toBe(0);
      for (const theme of ["dark", "light"] as const) {
        await host.setTheme(theme);
        const shot = await host.screenshot("sync-title-dot", theme);
        await access(shot.sidebar);
      }
      // 点付きのアイコンも、元と同じく同期する。push して点が消える
      await dotted.click();
      await plain.waitFor({ timeout: 60_000 });
      expect(await dotted.count()).toBe(0);
    } finally {
      for (const [key] of personal) await runCommand(configUnset, ctx, { key, local: true });
    }
  });

  it("導入のチェックリストの「アンインストール」で、消すものを確かめてからこのクローンから外し、外した後の知らせを出す（ライトとダークで撮る）", async () => {
    const shoot = async (name: string): Promise<void> => {
      for (const theme of ["dark", "light"] as const) {
        await host.setTheme(theme);
        const shot = await host.screenshot(name, theme);
        await access(shot.sidebar);
      }
    };
    // 閉じた節：タイトル行のセットアップのアイコンと同じルート
    await sidebar.locator("body").evaluate(() => {
      location.hash = "#/setup";
    });
    const section = sidebar.locator(".setup-uninstall");
    await section.waitFor({ timeout: 60_000 });
    expect(await section.locator(".setup-uninstall-body").count()).toBe(0);
    await section.scrollIntoViewIfNeeded();
    await shoot("setup-uninstall-closed");
    // コマンドパレットの「このリポジトリからアンインストール」と同じルート（実行のたびに変わる印つき）。節を開いて出し、dg uninstall --dry-run の結果を並べる
    await sidebar.locator("body").evaluate((_, hash) => {
      location.hash = hash;
    }, uninstallRouteOf(1));
    await section.locator(".setup-uninstall-list.removes").waitFor({ timeout: 60_000 });
    const remove = section.locator(".setup-uninstall-buttons .setup-danger");
    await remove.scrollIntoViewIfNeeded();
    await shoot("setup-uninstall-open");
    // 1 段階目（外す…）で確認を出し、2 段階目（外す）で deguboard のターミナルが dg uninstall を実行する
    await remove.click();
    const confirm = section.locator(".setup-uninstall-confirm");
    await confirm.waitFor();
    await confirm.scrollIntoViewIfNeeded();
    await shoot("setup-uninstall-confirm");
    await confirm.locator(".setup-danger").click();
    // ボードがなくなり、始めるときのチェックリストに戻って、その上に知らせが出る。待つのはテストの上限（120 秒）より短くし、
    // 外れなかったとき（dg が断った）に、時間切れではなくこの行で落ちるようにする
    const notice = sidebar.locator(".setup-uninstalled");
    await notice.waitFor({ timeout: 60_000 });
    expect(await sidebar.locator(".setup-uninstall").count()).toBe(0);
    // dg uninstall が実際にボードの worktree を消している。知らせは消している途中にも出るので、消え終わるまで見る
    // （知らせが出るのはボードがなくなった時点で、dg はその後にブランチ・マージドライバ・deguboard-local を消す）
    await expect
      .poll(() =>
        access(path.join(fixture.cloneA, ".git", "deguboard")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await notice.scrollIntoViewIfNeeded();
    await shoot("setup-uninstalled");
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
