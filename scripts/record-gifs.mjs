// 拡張の README に載せる使い方の GIF（packages/vscode/images/open-board.gif・ask-agent.gif）を録り直す。mise run gifs から呼ぶ。
// 一時ディレクトリに bare リモート付きのリポジトリを作って見本のチケットを起票し、dg serve の左パネルの画面（?surface=sidebar）を
// Chromium（playwright-core）で操作して 1 コマずつスクリーンショットを撮り、gifenc で GIF にまとめる。ffmpeg などの外のツールは使わない。
// VS Code 本体は録れないので、Activity Bar とエディタの部分は画面の外枠として自前で描く（FRAME_HTML）。左パネルの中身は実際の画面。
// マウスのカーソルはスクリーンショットに映らないので、外枠の上に矢印を描いて動かす。コマの表示時間は撮った時刻ではなく台本（各 shot の delay）で決めるので、
// 機械の速さによらず同じ長さになる。ask-agent.gif の貼り付け先は、コピーした依頼文が分かるように外枠に描いた入力欄で、VS Code やエージェントの画面ではない。
// 先に mise run build（タスクが依存する）と mise run playwright:install が要る。各 GIF は 6〜10 秒・1MB 以下（t347）に収まるかを最後に出す。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import gifenc from "gifenc";
import { chromium } from "playwright-core";
import { startServer } from "../packages/server/dist/index.js";

const { GIFEncoder, applyPalette, quantize } = gifenc;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "packages", "vscode", "images");
const webDist = path.join(root, "packages", "web", "dist");
const dgBin = path.join(root, "packages", "cli", "bin", "dg.js");
const run = promisify(execFile);

/** 画面の大きさ（GIF の寸法）。左パネルは VS Code の既定に近い 300px */
const WIDTH = 760;
const HEIGHT = 460;
const BAR = 48;
const SIDE = 300;
/** カーソルを動かすときの 1 コマの長さ（ミリ秒） */
const STEP = 50;

// 開発者のグローバル設定（hooksPath・gpgsign など）に影響されないようにする（git-fixture と同じ）
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args) => run("git", args, { cwd, env: gitEnv });
const dg = (cwd, args) =>
  run("node", [dgBin, "-C", cwd, "--json", "--user", "見本", ...args], { env: gitEnv });

/** 見本のリポジトリを作り、カンバン・バックログ・履歴に何かが出るようにチケットを置く */
async function createRepo(dir) {
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  await git(dir, ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git(dir, ["clone", "--quiet", remote, work]);
  await git(work, ["config", "user.name", "見本"]);
  await git(work, ["config", "user.email", "sample@example.com"]);
  await git(work, ["commit", "--quiet", "--allow-empty", "-m", "最初のコミット"]);
  await git(work, ["push", "--quiet", "origin", "main"]);
  await dg(work, ["init", "--template", "software-development"]);
  // リポジトリに dg の Skill があると、依頼文の形式の既定が Skill になる（開発者の ~/.claude/skills に左右されない）
  await dg(work, ["skill", "install"]);
  // 閉じた Iteration（履歴に出る）・進行中・予定の 3 つ
  await dg(work, ["iteration", "create", "スプリント 1", "--goal", "ログインまわりを固める"]);
  await dg(work, ["iteration", "start", "s1"]);
  const done = ["in_progress", "review", "done"];
  const tickets = [
    ["ログイン画面の入力チェックを足す", "s1", "high", done],
    ["パスワードの再設定のメールを送る", "s1", "medium", done],
    ["ログインの失敗を記録する", "s1", "low", done],
    ["一覧の並び順を保存する", "s2", "medium", ["in_progress", "review"]],
    ["CSV の書き出しを速くする", "s2", "medium", ["in_progress"]],
    ["設定画面にダークモードを足す", "s2", "high", []],
    ["エラーの文言をそろえる", "s2", "low", []],
    ["検索の結果を件数で絞る", "s3", "medium", []],
    ["通知のメールを日本語にする", null, "medium", []],
    ["古い API の呼び出しを消す", null, "low", []],
  ];
  for (const [i, [title, iteration, priority, moves]] of tickets.entries()) {
    if (iteration === "s2" && i === 3) {
      await dg(work, ["iteration", "close", "s1"]);
      await dg(work, ["iteration", "create", "スプリント 2", "--goal", "一覧を使いやすくする"]);
      await dg(work, ["iteration", "start", "s2"]);
      await dg(work, ["iteration", "create", "スプリント 3"]);
    }
    const args = ["ticket", "create", title, "--priority", priority];
    if (iteration) args.push("--iteration", iteration);
    args.push("--acceptance", "画面で確かめられる");
    await dg(work, args);
    for (const status of moves) await dg(work, ["ticket", "move", `t${i + 1}`, status]);
  }
  return work;
}

/** VS Code の窓に見立てた外枠。左パネルの中身は iframe の実際の画面 */
function frameHtml(appUrl, icon) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#1f1f1f;font-family:"IPAPGothic",sans-serif;overflow:hidden}
  .win{display:flex;height:100%}
  .bar{width:${BAR}px;background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;padding-top:10px;gap:18px;flex:none}
  .bar span{width:24px;height:24px;color:#868686;position:relative;display:block}
  .bar span.on{color:#d7d7d7}
  .bar span.on::before{content:"";position:absolute;left:-12px;top:-4px;width:2px;height:32px;background:#0078d4}
  .bar svg{width:24px;height:24px;display:block}
  .side{width:0;overflow:hidden;flex:none;border-right:1px solid #2b2b2b;background:#181818}
  .side iframe{width:${SIDE}px;height:100%;border:0;display:block}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .tabs{height:35px;background:#181818;border-bottom:1px solid #2b2b2b;display:flex}
  .tabs b{font-weight:400;font-size:13px;color:#ccc;background:#1f1f1f;padding:9px 16px;border-right:1px solid #2b2b2b}
  .code{padding:14px 20px;display:flex;flex-direction:column;gap:9px}
  .code i{display:block;height:8px;border-radius:4px;background:#2d2d2d}
  .agent{margin:auto 16px 16px;border:1px solid #3c3c3c;border-radius:8px;background:#252526;padding:10px 12px;display:none;flex-direction:column;gap:6px}
  .agent.on{display:flex}
  .agent.focus{border-color:#0078d4}
  .agent small{color:#8b8b8b;font-size:11px}
  .agent pre{margin:0;min-height:18px;color:#d4d4d4;font:12px/1.5 "IPAGothic",monospace;white-space:pre-wrap;word-break:break-all}
  .agent pre:empty::before{content:"ここに貼る";color:#6b6b6b}
  .cursor{position:fixed;left:0;top:0;width:16px;height:22px;z-index:10;pointer-events:none}
  .ring{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #4daafc;z-index:9;pointer-events:none;display:none}
</style></head><body><div class="win">
  <div class="bar">
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg></span>
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/></svg></span>
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 4-10 2-10 5"/></svg></span>
    <span class="dg">${icon}</span>
  </div>
  <div class="side"><iframe src="${appUrl}" allow="clipboard-read; clipboard-write"></iframe></div>
  <div class="main">
    <div class="tabs"><b>README.md</b></div>
    <div class="code">${[62, 48, 0, 70, 55, 40, 0, 66, 30]
      .map((w) => `<i style="width:${w}%;${w ? "" : "background:none"}"></i>`)
      .join("")}</div>
    <div class="agent"><small>エージェントの入力欄（例）</small><pre></pre></div>
  </div>
</div>
<div class="ring"></div>
<svg class="cursor" viewBox="0 0 16 22"><path d="M1 1v17l4.5-4.2 3 6.7 2.8-1.3-3-6.5H14z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>
</body></html>`;
}

/** 台本どおりに操作し、1 コマずつ撮る。shot の delay がそのコマの表示時間 */
class Recorder {
  frames = [];
  x = WIDTH * 0.6;
  y = HEIGHT * 0.7;
  constructor(page) {
    this.page = page;
  }
  async shot(delay) {
    this.frames.push({ png: await this.page.screenshot({ type: "png" }), delay });
  }
  async setCursor() {
    await this.page.evaluate(
      ([x, y]) => {
        document.querySelector(".cursor").style.transform = `translate(${x}px,${y}px)`;
      },
      [this.x, this.y],
    );
    await this.page.mouse.move(this.x, this.y);
  }
  /** 要素の中の (fx, fy) の割合の位置へ、ms ミリ秒かけてカーソルを動かす */
  async moveTo(locator, ms = 500, fx = 0.5, fy = 0.5) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`位置が分からない: ${locator}`);
    const [x0, y0] = [this.x, this.y];
    const [x1, y1] = [box.x + box.width * fx, box.y + box.height * fy];
    const n = Math.max(1, Math.round(ms / STEP));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.x = x0 + (x1 - x0) * e;
      this.y = y0 + (y1 - y0) * e;
      await this.setCursor();
      await this.shot(STEP);
    }
  }
  /** カーソルの位置を押し、押した印を 1 コマ出す */
  async click() {
    await this.page.evaluate(
      ([x, y]) => {
        const ring = document.querySelector(".ring");
        Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, display: "block" });
      },
      [this.x, this.y],
    );
    await this.page.mouse.click(this.x, this.y);
    await this.page.waitForTimeout(150);
    await this.shot(150);
    await this.page.evaluate(() => (document.querySelector(".ring").style.display = "none"));
  }
  /** 画面が落ち着くのを待って、ms ミリ秒止める */
  async hold(ms) {
    await this.page.waitForTimeout(250);
    await this.shot(ms);
  }
}

/** Playwright の PNG（8 bit の RGB か RGBA、インターレースなし）を RGBA の画素に戻す */
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0)
        throw new Error("8 bit・インターレースなしの PNG だけ読める");
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error(`読めない PNG の色の型: ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = cur[x * channels];
      rgba[o + 1] = cur[x * channels + 1];
      rgba[o + 2] = cur[x * channels + 2];
      rgba[o + 3] = 255;
    }
    cur.copy(prev);
  }
  return { width, height, rgba };
}

/**
 * コマを GIF にまとめる。色は全コマから間引いて集めた 255 色の共通のパレットにし、
 * 2 コマ目からは前のコマと同じ画素を透明（256 色目）にして、変わったところだけを書く（大きさを抑える）
 */
function encodeGif(frames) {
  const images = frames.map((f) => decodePng(f.png));
  const { width, height } = images[0];
  const sampleStep = Math.max(1, Math.floor(images.length / 12));
  const samples = images.filter((_, i) => i % sampleStep === 0 || i === images.length - 1);
  const pool = new Uint8Array(samples.length * width * height * 4);
  samples.forEach((img, i) => pool.set(img.rgba, i * width * height * 4));
  const palette = quantize(pool, 255);
  while (palette.length < 255) palette.push([0, 0, 0]);
  palette.push([0, 0, 0]);
  const TRANSPARENT = 255;
  const gif = GIFEncoder();
  let previous = null;
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const first = previous === null;
    gif.writeFrame(pending.out, width, height, {
      palette: first ? palette : undefined,
      delay: pending.delay,
      transparent: !first,
      transparentIndex: TRANSPARENT,
      dispose: 1,
    });
    previous = pending.index;
  };
  for (const [i, img] of images.entries()) {
    const index = applyPalette(img.rgba, palette);
    const base = pending ? pending.index : previous;
    if (base && index.every((v, k) => v === base[k])) {
      // 前のコマと同じなら、前のコマを長く出す
      pending.delay += frames[i].delay;
      continue;
    }
    flush();
    const out = base ? index.map((v, k) => (v === previous[k] ? TRANSPARENT : v)) : index;
    pending = { index, out, delay: frames[i].delay };
  }
  flush();
  gif.finish();
  return gif.bytes();
}

/** Activity Bar のアイコンで左パネルを開き、カンバン・バックログ・履歴のタブを切り替える */
async function openBoard(rec, app) {
  const page = rec.page;
  await rec.setCursor();
  await rec.hold(600);
  await rec.moveTo(page.locator(".bar .dg"), 600);
  await rec.click();
  await page.evaluate(() => document.querySelector(".bar .dg").classList.add("on"));
  for (const w of [0.25, 0.5, 0.75, 1]) {
    await page.evaluate(
      (px) => (document.querySelector(".side").style.width = `${px}px`),
      SIDE * w,
    );
    await rec.shot(STEP);
  }
  await rec.hold(1200);
  await rec.moveTo(app.locator('.column[data-status="in_progress"] .row-item').first(), 500, 0.4);
  await rec.hold(700);
  for (const label of ["バックログ", "履歴", "カンバン"]) {
    await rec.moveTo(app.locator(".topbar nav a", { hasText: label }), 450);
    await rec.click();
    await rec.hold(label === "カンバン" ? 1200 : 1300);
  }
}

/** 行の吹き出しから頼むことを選び、指示を足してコピーし、入力欄に貼る */
async function askAgent(rec, app, frame) {
  const page = rec.page;
  await page.evaluate((side) => {
    document.querySelector(".bar .dg").classList.add("on");
    document.querySelector(".side").style.width = `${side}px`;
    document.querySelector(".agent").classList.add("on");
  }, SIDE);
  await rec.setCursor();
  await rec.hold(500);
  const row = app.locator('.column[data-status="todo"] .row-item').first();
  await rec.moveTo(row, 500, 0.4);
  await rec.hold(400);
  await rec.moveTo(row.locator(".ask-bubble").first(), 300);
  await rec.click();
  await app.locator(".ask-menu").waitFor();
  await rec.hold(800);
  await rec.moveTo(app.locator(".ask-menu [role=menuitem]").first(), 350);
  await rec.click();
  const composer = app.locator(".ask-composer");
  await composer.waitFor();
  await rec.hold(700);
  await rec.moveTo(composer.locator("textarea"), 350);
  await rec.click();
  for (const ch of "テストも足して") {
    await page.keyboard.type(ch);
    await rec.shot(110);
  }
  await rec.hold(400);
  await rec.moveTo(composer.locator(".ask-copy"), 400);
  await rec.click();
  await rec.hold(800);
  const copied = await frame.evaluate(() => navigator.clipboard.readText());
  await rec.moveTo(page.locator(".agent"), 600, 0.4);
  await rec.click();
  await page.evaluate(() => document.querySelector(".agent").classList.add("focus"));
  await rec.shot(250);
  await page.evaluate((text) => (document.querySelector(".agent pre").textContent = text), copied);
  await rec.hold(1800);
}

async function record(browser, server, icon, hash, script) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: "dark",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(server.url).origin,
  });
  const page = await context.newPage();
  // 外枠も dg serve と同じオリジンから出す（iframe の画面のクリップボードを読むため）
  const frameUrl = `${server.url}__gif-frame.html`;
  const appUrl = `${server.url}?surface=sidebar${hash}`;
  await page.route(frameUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: frameHtml(appUrl, icon) }),
  );
  await page.goto(frameUrl, { waitUntil: "networkidle" });
  const frame = page.frames().find((f) => f.url().startsWith(appUrl));
  const app = page.frameLocator(".side iframe");
  await app.locator(".topbar").waitFor();
  const rec = new Recorder(page);
  await script(rec, app, frame);
  await context.close();
  return rec.frames;
}

async function main() {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-gifs-")));
  let server;
  let browser;
  try {
    const work = await createRepo(tmp);
    server = await startServer({ cwd: work, port: 0, user: "見本", staticDir: webDist });
    browser = await chromium.launch().catch((error) => {
      throw new Error(
        `Chromium を起動できない。mise run playwright:install を実行する（${error}）`,
      );
    });
    const icon = await readFile(
      path.join(root, "packages", "vscode", "media", "deguboard.svg"),
      "utf8",
    );
    await mkdir(outDir, { recursive: true });
    const jobs = [
      ["open-board.gif", "#/board", openBoard],
      ["ask-agent.gif", "#/board", askAgent],
    ];
    for (const [name, hash, script] of jobs) {
      const frames = await record(browser, server, icon, hash, script);
      const bytes = encodeGif(frames);
      await writeFile(path.join(outDir, name), bytes);
      const seconds = frames.reduce((sum, f) => sum + f.delay, 0) / 1000;
      const kb = Math.round(bytes.length / 1024);
      const ok = seconds >= 6 && seconds <= 10 && bytes.length <= 1024 * 1024;
      console.log(
        `${name}: ${WIDTH}x${HEIGHT}、${seconds.toFixed(1)} 秒、${kb} KB、${frames.length} コマ${ok ? "" : "（6〜10 秒・1MB 以下に収まらない）"}`,
      );
      if (!ok) process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

await main();
