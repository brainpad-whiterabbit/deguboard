// README（と、そこから作る拡張の README）に載せる使い方の GIF（packages/vscode/images/ の 5 本）を録り直す。mise run gifs から呼ぶ。引数に名前（import.gif など）を渡せばその分だけ録る。
// 5 本は README の流れ（起票 → 割り当て → 計画 → 並列の実装 → 振り返り）の順で、import・assign・plan・work・retro（t844）。README の冒頭は GIF ではなく開発の流れの図（同じ場所の flow.png。元は flow.svg）。
// 一時ディレクトリに bare リモート付きのリポジトリを作って見本のチケットを起票し、dg serve の左パネルの画面を
// Chromium（playwright-core）で操作して 1 コマずつスクリーンショットを撮り、gifenc で GIF にまとめる。ffmpeg などの外のツールは使わない。
// VS Code 本体は録れないので、Activity Bar・エディタ・ターミナルの部分は画面の外枠として自前で描く（frameHtml）。左パネルの中身は実際の画面。
// マウスのカーソルはスクリーンショットに映らないので、外枠の上に矢印を描いて動かす。コマの表示時間は撮った時刻ではなく台本（各 shot の delay）で決めるので、
// 機械の速さによらず同じ長さになる。
// どれもエージェントの流れで、実際の実行の録画ではなく仮の GUI で録る（t348）。ターミナルのエージェント（Claude Code の入力と出力）は
// 外枠に描いた模した画面で、エージェントが dg を動かした結果（起票・割り当て・計画・状態の遷移）は、台本が一時リポジトリで実際に dg のコマンドを流して左パネルに反映させる。
// 左パネルとエディタのパネル（チケットの詳細）は、拡張ホストの代わりの小さな仲立ち（vscodeShim）で Webview として動かし、
// 詳細を開く・コピー・読み直しを拡張と同じ通り道で受ける。ターミナルに出す数字（retro.gif の要約と Keep / Problem / Try など）は見本で、
// 流れは dg guide retro に合わせる（振り返りはチャットで答え、報告書のファイルは書かない）。
// 画面は英語の表示（<html data-language="en"> を入れる）で、CSS の 760x460 を 1.5 倍の解像度で撮る（GIF は 1140x690。README の表示幅 560px の 2 倍で文字がにじまない。t458）。
// plan.gif と work.gif だけは 3 段の依存グラフが収まるように左パネルを広げ、830x460（GIF は 1245x690、README の表示幅は 612px）で撮る（PLAN_SIDE）。
// 先に mise run build（タスクが依存する）と mise run playwright:install が要る。各 GIF が 20 秒以下・1MB 以下に収まらなければ失敗する。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { startServer } from "../packages/server/dist/index.js";
import { checkGif, encodeGif } from "./lib/gif.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "packages", "vscode", "images");
const webDist = path.join(root, "packages", "web", "dist");
const dgBin = path.join(root, "packages", "cli", "bin", "dg.js");
const run = promisify(execFile);

/**
 * 画面の大きさ（CSS の px）。左パネルは VS Code の既定に近い 300px。GIF の寸法は SCALE 倍になる。
 * README の表示幅（560px）の 2 倍（1120px）以上で文字がにじまないように、1.5 倍の解像度で撮る（t458）。
 * plan.gif と work.gif は 3 段の依存グラフ（324px 幅）が横に送られずに収まるように、左パネルを PLAN_SIDE に広げ、
 * 画面の幅も同じだけ広げる（830px、GIF は 1245px。README の表示幅は 612px にして、ほかの GIF と文字の大きさを揃える）。
 * パネルの中の余白で、グラフに使えるのは左パネルの幅より約 40px 狭い（360px では 3px 足りない。waitGraphFits が検査する）
 */
const WIDTH = 760;
const HEIGHT = 460;
const SCALE = 1.5;
const BAR = 48;
const SIDE = 300;
const PLAN_SIDE = 370;
/** カーソルを動かすときの 1 コマの長さ（ミリ秒） */
const STEP = 50;

// 一時リポジトリの組み立て（initRepo など）は packages/core/test/helpers/git-fixture.ts と共有しない。理由：
// git-fixture は TypeScript で core の src（Store・ensureDeguboardWorktree）を import し、vitest の中で動く前提で
// process.env を書き換える。この録画スクリプトは素の node で動き、ビルド済みの dg（dist）だけを呼ぶ。
// また作るものも違い、こちらは clone 1 つに dg init と Skill の取り込みまで済ませた見本、あちらは clone 2 つの競合の検証用。
// bare リモートの作成・clone・ユーザーの設定という数行は重なるが、共有のための層（ビルド・型・環境変数の扱い）の方が重いので別に持つ。
// 開発者のグローバル設定（hooksPath・gpgsign など）に影響されないようにする（git-fixture と同じ）。
// git-fixture が足す裏の maintenance・gc の停止（GIT_CONFIG_COUNT）は、ここでは要らないので足さない（一時ディレクトリの後片付けは rm の再試行で足りる）
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args) => run("git", args, { cwd, env: gitEnv });
const dg = (cwd, args) =>
  run("node", [dgBin, "-C", cwd, "--json", "--user", "Sample", ...args], { env: gitEnv });

/** bare リモート付きのリポジトリを作り、dg の初期化と Skill の取り込みまで済ませる。作業ディレクトリを返す */
async function initRepo(dir) {
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  await git(dir, ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git(dir, ["clone", "--quiet", remote, work]);
  await git(work, ["config", "user.name", "Sample"]);
  await git(work, ["config", "user.email", "sample@example.com"]);
  await git(work, ["commit", "--quiet", "--allow-empty", "-m", "Initial commit"]);
  await git(work, ["push", "--quiet", "origin", "main"]);
  await dg(work, ["init", "--template", "software-development"]);
  // リポジトリに dg の Skill があると、依頼文の形式の既定が Skill になる（開発者の ~/.claude/skills に左右されない）
  await dg(work, ["skill", "install"]);
  return work;
}

/** チケットを作り、Status を順に進める。作った ID を返す */
async function createTicket(work, title, { iteration, priority = "medium", moves = [] } = {}) {
  const args = [
    "ticket",
    "create",
    title,
    "--priority",
    priority,
    "--acceptance",
    "Checked on screen",
  ];
  if (iteration) args.push("--iteration", iteration);
  const { stdout } = await dg(work, args);
  const { id } = JSON.parse(stdout).data;
  for (const status of moves) await dg(work, ["ticket", "move", id, status]);
  return id;
}

/** /dgimport で起票した体のチケットを ticket import で入れる（依存は depends_on）。iteration を渡せばその Iteration に入れる */
async function importDrafts(work, dir, drafts, iteration) {
  const file = path.join(dir, "drafts.json");
  const rows = drafts.map((d) => ({
    acceptance: ["Checked on screen"],
    ...d,
    ...(iteration ? { iteration } : {}),
  }));
  await writeFile(file, JSON.stringify(rows));
  await dg(work, ["ticket", "import", file]);
}

/** import.gif の見本：バックログに 3 件だけある。起票は台本が dg ticket import で行う */
async function importRepo(dir) {
  const work = await initRepo(dir);
  await dg(work, ["iteration", "create", "Iteration 1", "--goal", "Add export"]);
  await dg(work, ["iteration", "start", "s1"]);
  await createTicket(work, "Export to CSV", { iteration: "s1" });
  await createTicket(work, "Review the dark theme colors", { priority: "low" });
  await createTicket(work, "Let labels have their own colors");
  return work;
}

/** assign.gif の見本のチケット（import.gif で起票した 3 件と同じ題） */
const LOGIN_DRAFTS = [
  { key: "api", title: "Make login call the API once", priority: "high" },
  { key: "message", title: "Split error messages by cause" },
  { key: "perf", title: "Add a test that measures login time", depends_on: ["api"] },
];

/**
 * assign.gif の見本：始めたばかりの空の Iteration（s1）と、どこにも入っていないバックログの 5 件（t3〜t5 が起票したばかりのログインの 3 件）。
 * Epic の作成と割り当ては台本が dg で行う
 */
async function assignRepo(dir) {
  const work = await initRepo(dir);
  await dg(work, ["iteration", "create", "Iteration 1", "--goal", "Faster, clearer login"]);
  await dg(work, ["iteration", "start", "s1"]);
  await createTicket(work, "Review the dark theme colors", { priority: "low" });
  await createTicket(work, "Let labels have their own colors");
  await importDrafts(work, dir, LOGIN_DRAFTS);
  return work;
}

/**
 * plan.gif と work.gif の見本のチケット（この順で起票して t1〜t7 になる）。段は 3 つ：t1 t2 t3 は待ちがなく、
 * t4 は t1 を、t5 は t2 と t3 を、t6 は t3 と t4 を、t7 は t5 を待つ（work.gif で 3 件が並列に In Progress になり、
 * 複数を待つチケットも見せるため）。3 段の依存グラフは 3×76+2×48 = 324px 幅なので、この 2 本だけ左パネルを PLAN_SIDE に広げる
 */
const EXPORT_DRAFTS = [
  { key: "columns", title: "Decide the export columns", priority: "high" },
  { key: "button", title: "Add an export button" },
  { key: "endpoint", title: "Add a download endpoint" },
  { key: "csv", title: "Build the CSV from the list", depends_on: ["columns"] },
  { key: "wire", title: "Wire the button to the endpoint", depends_on: ["button", "endpoint"] },
  { key: "stream", title: "Stream large lists", depends_on: ["endpoint", "csv"] },
  { key: "notice", title: "Tell when the export finishes", depends_on: ["wire"], priority: "low" },
];
const EXPORT_IDS = EXPORT_DRAFTS.map((_, i) => `t${i + 1}`);

/** plan.gif の見本：割り当て済みの 7 件が入った、始めたばかりの Iteration（s1）。計画は台本が dg で立てる */
async function planRepo(dir) {
  const work = await initRepo(dir);
  await dg(work, ["iteration", "create", "Iteration 1", "--goal", "Export to CSV"]);
  await dg(work, ["iteration", "start", "s1"]);
  await importDrafts(work, dir, EXPORT_DRAFTS, "s1");
  return work;
}

/** work.gif の見本：plan.gif のあと（承認済みの Plan p1）。遷移は台本が dg で行う */
async function workRepo(dir) {
  const work = await planRepo(dir);
  await dg(work, ["plan", "create", ...EXPORT_IDS]);
  await dg(work, ["plan", "approve", "p1"]);
  return work;
}

/** retro.gif の見本：閉じた Iteration が 2 つ（新しい s2 を振り返る）と、進行中が 1 つ */
async function retroRepo(dir) {
  const work = await initRepo(dir);
  const done = ["in_progress", "review", "done"];
  const sprints = [
    [
      "Ask an agent",
      ["Pick a request from the speech bubble", "Copy the request", "Allow adding instructions"],
    ],
    [
      "Show priority clearly",
      [
        "Show priority with arrows and words",
        "Show high and low on the first line of rows",
        "Show the criteria in the tooltip",
        "Let the detail view set priority",
        "Let settings change the priority criteria",
      ],
    ],
  ];
  for (const [n, [goal, titles]] of sprints.entries()) {
    const id = `s${n + 1}`;
    await dg(work, ["iteration", "create", `Iteration ${n + 1}`, "--goal", goal]);
    await dg(work, ["iteration", "start", id]);
    for (const title of titles) await createTicket(work, title, { iteration: id, moves: done });
    await dg(work, ["iteration", "close", id]);
  }
  await dg(work, ["iteration", "create", "Iteration 3", "--goal", "Make history easier to read"]);
  await dg(work, ["iteration", "start", "s3"]);
  await createTicket(work, "Show the period on history rows", {
    iteration: "s3",
    moves: ["in_progress"],
  });
  await createTicket(work, "Keep search terms", { iteration: "s3" });
  return work;
}

/**
 * 画面の言語を英語にする。main.tsx は <html data-language> を読んで起動するので、その前に付ける（拡張ホストが vscode.env.language で渡すのと同じ印）。
 * dg serve は既定で日本語のままなので、録るときだけ英語にする（t458）
 */
function englishScreen() {
  const mark = () => {
    if (!document.documentElement) return false;
    document.documentElement.dataset.language = "en";
    return true;
  };
  if (!mark())
    new MutationObserver((_, observer) => {
      if (mark()) observer.disconnect();
    }).observe(document, { childList: true });
}

/**
 * 拡張ホストの代わりの仲立ち。Chromium の各フレームで画面のスクリプトより先に走り（addInitScript）、
 * ?gif-host=sidebar|panel の付いた画面にだけ acquireVsCodeApi を置いて Webview として動かす（surface は data 属性で渡す）。
 * コマンドは dg serve の HTTP に写し、詳細を開く・コピーは外枠（親のフレーム）に postMessage で渡し、一覧を出す（show）はハッシュを変える。
 * 見た目の状態はフレームの中だけに持つ
 */
function vscodeShim() {
  const surface = new URLSearchParams(location.search).get("gif-host");
  if (surface !== "sidebar" && surface !== "panel") return;
  // 初めての案内は閉じ、カンバンの Done の節は開いておく（チケットが Done に並ぶのを見せる）
  let state = { "ask.hintDismissed": true, "board.section.done": true };
  const reply = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
  const answer = async (msg) => {
    try {
      if (msg.kind === "action") {
        if (msg.name === "show") location.hash = msg.route;
        else window.parent.postMessage({ gif: msg.name, route: msg.route, text: msg.text }, "*");
        // 開いているターミナルの一覧は仲立ちにない（外枠のターミナルは模したもの）ので、空の一覧を返す。null だと送り先の選びが落ちる
        const data = msg.name === "terminals" ? [] : null;
        return reply({ id: msg.id, ok: true, data, warnings: [], write: null });
      }
      const res =
        msg.kind === "run"
          ? await fetch(`/api/commands/${encodeURIComponent(msg.name)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ input: msg.input }),
            })
          : await fetch("/api/status");
      const body = await res.json();
      reply(
        body.ok
          ? {
              id: msg.id,
              ok: true,
              data: body.data,
              warnings: body.warnings ?? [],
              write: body.write ?? null,
            }
          : { id: msg.id, ok: false, error: body.error },
      );
    } catch (error) {
      reply({ id: msg.id, ok: false, error: { code: "UNREACHABLE", message: String(error) } });
    }
  };
  window.acquireVsCodeApi = () => {
    document.documentElement.dataset.surface = surface;
    return {
      postMessage: (msg) => void answer(msg),
      getState: () => state,
      setState: (value) => (state = value),
    };
  };
}

/**
 * VS Code の窓に見立てた外枠。左パネルの中身は iframe の実際の画面。
 * エディタの下にターミナルのエージェント（Claude Code）を模した画面を置き、詳細を開く頼みでエディタにパネルの画面（iframe）を開く
 */
function frameHtml(appUrl, icon, side) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#1f1f1f;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  .win{display:flex;height:100%}
  .bar{width:${BAR}px;background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;padding-top:10px;gap:18px;flex:none}
  .bar span{width:24px;height:24px;color:#868686;position:relative;display:block}
  .bar span.on{color:#d7d7d7}
  .bar span.on::before{content:"";position:absolute;left:-12px;top:-4px;width:2px;height:32px;background:#0078d4}
  .bar svg{width:24px;height:24px;display:block}
  .side{width:0;overflow:hidden;flex:none;border-right:1px solid #2b2b2b;background:#181818}
  .side iframe{width:${side}px;height:100%;border:0;display:block}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .tabs{height:35px;background:#181818;border-bottom:1px solid #2b2b2b;display:flex}
  .tabs b{font-weight:400;font-size:13px;color:#ccc;background:#1f1f1f;padding:9px 16px;border-right:1px solid #2b2b2b}
  .cursor{position:fixed;left:0;top:0;width:16px;height:22px;z-index:10;pointer-events:none}
  .ring{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #4daafc;z-index:9;pointer-events:none;display:none}
  .tabs b[hidden],.editor [hidden]{display:none}
  .tabs b.off{background:#181818;color:#8b8b8b}
  .editor{flex:1;min-height:0;position:relative;overflow:hidden}
  .editor pre{margin:0;padding:12px 18px;color:#9cdcfe;font:12px/1.7 ui-monospace,Menlo,Consolas,monospace;white-space:pre}
  .editor pre em{font-style:normal;color:#c586c0}
  .editor iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#1f1f1f}
  .term{height:var(--term,46%);flex:none;border-top:1px solid #2b2b2b;background:#181818;display:flex;flex-direction:column;padding:6px 12px 10px;gap:3px;color:#d4d4d4;font:11.5px/1.55 ui-monospace,Menlo,Consolas,monospace;overflow:hidden}
  .term-head{color:#8b8b8b;font:11px system-ui,-apple-system,"Segoe UI",sans-serif;flex:none;margin-bottom:2px;display:flex;gap:12px}
  .term-head b{font-weight:400;color:#d4d4d4;border-bottom:1px solid #d4d4d4;padding-bottom:1px}
  .term-head .ff{margin-left:auto;color:#1f1f1f;background:#e2c08d;border-radius:3px;padding:0 6px;font-weight:600}
  .term-lines{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
  .term-lines div{white-space:pre-wrap;word-break:break-all;flex:none}
  .term-lines .you{color:#d4d4d4;margin-bottom:3px;padding-left:1.3em;position:relative}
  .term-lines .you::before{content:">";color:#8b8b8b;position:absolute;left:0}
  .term-lines .dot::first-letter{color:#d4d4d4}
  .term-lines .dim{color:#8b8b8b}
  .term-lines .ok{color:#73c991}
  .term-lines .ask{color:#e2c08d}
  .term-lines .sel{color:#4daafc}
  .term-lines .tool{color:#d4d4d4}
  .term-lines .tool i{font-style:normal;color:#73c991}
  .term-lines .keep{color:#73c991}
  .term-lines .prob{color:#f47067}
  .term-lines .try{color:#4daafc}
  .term-input{flex:none;border:1px solid #4a4a4a;border-radius:6px;padding:4px 8px;display:flex;gap:6px;min-height:26px;overflow:hidden}
  .term-input .text{flex:1;min-width:0;word-break:break-all}
  .term-input.focus{border-color:#8b8b8b}
  .term-input.focus .text::after{content:"";display:inline-block;width:7px;height:13px;background:#d4d4d4;vertical-align:-2px;margin-left:1px}
  .term-input .text div,.term-lines .you div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body><div class="win">
  <div class="bar">
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg></span>
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/></svg></span>
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 4-10 2-10 5"/></svg></span>
    <span class="dg">${icon}</span>
  </div>
  <div class="side"><iframe src="${appUrl}" allow="clipboard-read; clipboard-write"></iframe></div>
  <div class="main">
    <div class="tabs"><b class="tab-code">README.md</b><b class="tab-doc" hidden></b></div>
    <div class="editor"><pre class="src"></pre><iframe class="detail" hidden></iframe></div>
    <div class="term">
      <div class="term-head"><b>Terminal</b><span>claude</span><span class="ff" hidden>▶▶ Fast forward</span></div>
      <div class="term-lines"></div>
      <div class="term-input"><span>&gt;</span><span class="text"></span></div>
    </div>
  </div>
</div>
<div class="ring"></div>
<svg class="cursor" viewBox="0 0 16 22"><path d="M1 1v17l4.5-4.2 3 6.7 2.8-1.3-3-6.5H14z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>
<script>${FRAME_SCRIPT}</script>
</body></html>`;
}

/**
 * 外枠が左パネル・詳細のパネルの仲立ち（vscodeShim）から受ける頼み。copy は受けた文を残し（台本が貼る）、
 * open は詳細のルートをエディタのパネル（iframe）に開く。開いていればハッシュだけを変える（VS Code のパネルと同じく 1 枚を使い回す）
 */
const FRAME_SCRIPT = `
window.copied = "";
addEventListener("message", (e) => {
  const m = e.data;
  if (!m || !m.gif) return;
  if (m.gif === "copy") window.copied = m.text;
  if (m.gif !== "open") return;
  const f = document.querySelector(".detail");
  if (f.hidden) {
    f.src = location.origin + "/?gif-host=panel" + m.route;
    f.hidden = false;
  } else f.contentWindow.location.hash = m.route;
  showDoc(m.route.split("/").pop());
});
// 入力欄の文。複数行（貼った依頼文）は行ごとに 1 行に縮めて見せる
function setInput(text) {
  const el = document.querySelector(".term-input .text");
  el.dataset.text = text;
  el.replaceChildren();
  const lines = text.split("\\n");
  if (lines.length === 1) el.textContent = text;
  else for (const line of lines) el.append(Object.assign(document.createElement("div"), { textContent: line }));
}
// 入力欄の文を送る：出力の欄に「> 文」として移し、入力欄を空にする
function sendInput() {
  const el = document.querySelector(".term-input .text");
  const line = document.createElement("div");
  line.className = "you";
  line.append(...el.childNodes);
  document.querySelector(".term-lines").append(line);
  el.replaceChildren();
}
function showDoc(name) {
  const tab = document.querySelector(".tab-doc");
  tab.textContent = name;
  tab.hidden = false;
  document.querySelector(".tab-code").classList.add("off");
  document.querySelector(".src").hidden = true;
}
`;

/** 台本どおりに操作し、1 コマずつ撮る。shot の delay がそのコマの表示時間 */
class Recorder {
  frames = [];
  y = HEIGHT * 0.7;
  /** width は画面の幅、side は左パネルの幅（CSS の px） */
  constructor(page, width, side) {
    this.page = page;
    this.side = side;
    this.x = width * 0.6;
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

/** 外枠を整える：左パネルを開き、エディタにファイル名とコード、ターミナルの高さを入れる（コードが空ならターミナルだけ） */
async function setupAgent(rec, { file, code, term }) {
  await rec.page.evaluate(
    ([side, file, code, term]) => {
      document.querySelector(".bar .dg").classList.add("on");
      document.querySelector(".side").style.width = `${side}px`;
      document.querySelector(".tab-code").textContent = file;
      document.querySelector(".src").innerHTML = code;
      document.querySelector(".term").style.setProperty("--term", term);
      // コードがなければエディタを隠し、ターミナルをタブの下の高さいっぱいにする
      if (!code) {
        document.querySelector(".editor").style.display = "none";
        document.querySelector(".term").style.flex = "1 1 0";
      }
    },
    [rec.side, file, code, term],
  );
  await rec.setCursor();
}

/** ターミナルの入力欄に text を打つ（2 文字ずつ 1 コマ）。paste なら一度に入れる（貼り付け） */
async function termType(rec, text, paste = false) {
  await rec.page.evaluate(() => document.querySelector(".term-input").classList.add("focus"));
  for (let i = paste ? text.length : 2; i < text.length + 2; i += 2) {
    await rec.page.evaluate((t) => window.setInput(t), text.slice(0, i));
    await rec.shot(70);
  }
}

/** 入力欄の文を送る（Enter） */
async function termEnter(rec) {
  await rec.page.evaluate(() => window.sendInput());
  await rec.shot(200);
}

/** 出力の欄に 1 行足して ms ミリ秒止める。kind は色（dot はエージェントの発言の ●、tool は道具の呼び出し） */
async function termSay(rec, kind, html, ms = 600) {
  await rec.page.evaluate(
    ([kind, html]) => {
      const line = document.createElement("div");
      line.className = kind;
      line.innerHTML = html;
      document.querySelector(".term-lines").append(line);
    },
    [kind, html],
  );
  await rec.hold(ms);
}

/** 選択肢を番号で選んで送る（Claude Code の問いに答える） */
async function termChoose(rec, answer) {
  await termType(rec, answer);
  await rec.hold(300);
  await termEnter(rec);
}

/**
 * 一時リポジトリで dg のコマンドを順に流し、左パネル（と開いていれば詳細のパネル）に読み直しを知らせる。
 * 拡張ホストがファイルの変化で送る reload と同じ通知。読み直しが描き終わるまで少し待つ
 */
async function dgSteps(rec, work, steps) {
  for (const args of steps) await dg(work, args);
  await rec.page.evaluate(() => {
    for (const f of document.querySelectorAll(".side iframe, .detail:not([hidden])"))
      f.contentWindow.postMessage({ kind: "event", name: "reload" }, "*");
  });
  await rec.page.waitForTimeout(700);
}

/**
 * opener（吹き出しか選択の帯の「頼む」）から頼むこと item を選び、依頼文をコピーしてターミナルに貼って送る。
 * README の「Ask Agent から選び、コピーした依頼文をエージェントに貼る」の流れ
 */
async function askAndPaste(rec, app, opener, item) {
  await rec.moveTo(opener, 350);
  await rec.click();
  await app.locator(".ask-menu").waitFor();
  await rec.hold(600);
  const choice = app.locator(".ask-menu [role=menuitem]", { hasText: item }).first();
  if (!(await choice.count())) {
    const items = await app.locator(".ask-menu [role=menuitem]").allInnerTexts();
    throw new Error(`頼むことの一覧に ${item} がない（${items.join("・")}）`);
  }
  await rec.moveTo(choice, 350);
  await rec.click();
  const composer = app.locator(".ask-composer");
  await composer.waitFor();
  await rec.hold(500);
  await rec.moveTo(composer.locator(".ask-copy"), 400);
  await rec.click();
  await rec.hold(300);
  const copied = await rec.page.evaluate(() => window.copied);
  if (!copied) throw new Error(`${item} の依頼文をコピーできなかった`);
  // 入力欄が左パネルの下を覆うので、閉じてから貼りに行く（左パネルの変わる様子を見せるため）
  await rec.moveTo(app.locator(".ask-close"), 300);
  await rec.click();
  await rec.moveTo(rec.page.locator(".term-input"), 500, 0.3);
  await rec.click();
  await termType(rec, copied, true);
  await rec.hold(500);
  await termEnter(rec);
}

const IMPORT_CODE = [
  "<em>export async function</em> login(id, password) {",
  "  <em>const</em> user = <em>await</em> fetchUser(id);",
  "  <em>const</em> perms = <em>await</em> fetchPerms(id);",
  '  <em>if</em> (!user) <em>throw new</em> Error("Login failed");',
  "  <em>return</em> { user, perms };",
  "}",
].join("\n");

/** 雑な一言に /dgimport を付けて頼み、起票の案を承認し、バックログに並んだチケットの詳細を開く */
async function importFlow(rec, app, { work, tmp }) {
  await setupAgent(rec, { file: "login.ts", code: IMPORT_CODE, term: "52%" });
  await rec.hold(500);
  await rec.moveTo(rec.page.locator(".term-input"), 500, 0.3);
  await rec.click();
  await termType(rec, "/dgimport Login is slow and the errors are hard to follow. Fix it somehow");
  await rec.hold(300);
  await termEnter(rec);
  await termSay(rec, "dot", "● Looking at src/auth/ and the login screen…", 900);
  await termSay(rec, "dot", "● Draft tickets (3)", 300);
  await termSay(rec, "dim", "  1. Make login call the API once · high", 300);
  await termSay(rec, "dim", "  2. Split error messages by cause", 300);
  await termSay(rec, "dim", "  3. Add a test that measures login time · after 1", 300);
  await termSay(rec, "ask", "? Create these tickets?", 200);
  await termSay(rec, "sel", "  ❯ 1. Create tickets", 100);
  await termSay(rec, "dim", "    2. Revise", 700);
  await termChoose(rec, "1");
  const drafts = [
    {
      key: "api",
      title: "Make login call the API once",
      priority: "high",
      summary:
        "Login fetches the user and permissions separately, which takes two round trips. Return both in one call.",
      acceptance: ["Login calls the API once", "The screen and permission checks stay the same"],
    },
    {
      key: "message",
      title: "Split error messages by cause",
      summary: "A wrong password, a lock, and a network failure all show 'Login failed'.",
      acceptance: [
        "Each cause shows a message that says what to do next",
        "The existing tests still pass",
      ],
    },
    {
      key: "perf",
      title: "Add a test that measures login time",
      depends_on: ["api"],
      summary: "Check the effect of the single call with numbers, and catch slowdowns.",
      acceptance: ["A test measures login time", "The test fails when login takes over 1 second"],
    },
  ];
  const file = path.join(tmp, "import.json");
  await writeFile(file, JSON.stringify(drafts));
  await dgSteps(rec, work, [["ticket", "import", file]]);
  await termSay(rec, "ok", "✓ Created t4 t5 t6 in the backlog", 1000);
  const row = app.locator("a.ticket-row", { hasText: "measures login" }).first();
  await rec.moveTo(row, 700, 0.4);
  await rec.click();
  await rec.page.frameLocator(".detail").locator("main.page h1").waitFor();
  // 詳細を読めるように、ターミナルを下に縮める
  await rec.page.evaluate(() => document.querySelector(".term").style.setProperty("--term", "26%"));
  await rec.hold(3600);
}

/** バックログでログインの 3 件を行の左端の帯で選び、選択の帯の「頼む」から Assign を頼み、Epic を作って Iteration に入れる案を承認する */
async function assignFlow(rec, app, { work }) {
  await setupAgent(rec, { file: "claude", code: "", term: "auto" });
  await rec.hold(600);
  // 行の左端の帯（12px）を押すと 1 行ずつ選びに足す（selection.tsx）
  for (const title of LOGIN_DRAFTS.map((d) => d.title)) {
    const row = app.locator("a.ticket-row", { hasText: title }).first();
    await rec.moveTo(row, 400, 0.02);
    await rec.click();
    await rec.hold(200);
  }
  await rec.hold(500);
  await askAndPaste(rec, app, app.locator(".selection-bar .selection-ask"), "Assign");
  await termSay(rec, "dot", "● Reading t3 t4 t5 and the open Iterations…", 900);
  await termSay(rec, "dot", "● Proposal", 200);
  await termSay(rec, "dim", '  New Epic e1 "Faster login": t3 t4 t5', 250);
  await termSay(rec, "dim", '  Iteration s1 "Faster, clearer login": t3 t4 t5', 250);
  await termSay(rec, "ask", "? Apply this assignment?", 200);
  await termSay(rec, "sel", "  ❯ 1. Apply", 100);
  await termSay(rec, "dim", "    2. Revise", 600);
  await termChoose(rec, "1");
  await dgSteps(rec, work, [
    ["epic", "create", "Faster login"],
    ["epic", "add", "e1", "t3", "t4", "t5"],
    ["iteration", "add", "s1", "t3", "t4", "t5"],
  ]);
  await termSay(rec, "ok", "✓ Created e1 and added t3 t4 t5 to e1 and s1", 1600);
  // カンバンに移り、Iteration の Todo に並んだのを見せる
  await rec.moveTo(app.locator(".topbar nav a", { hasText: "Board" }), 500);
  await rec.click();
  await rec.hold(2600);
}

/** 依存グラフが開くのを待ち、左パネルの中で横に送られる（はみ出す）なら失敗する（PLAN_SIDE が足りない） */
async function waitGraphFits(app) {
  const graph = app.locator(".plan-graph").first();
  await graph.waitFor();
  const [scroll, client] = await graph.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  if (scroll > client)
    throw new Error(`依存グラフが左パネルに収まらない（${scroll}px > ${client}px）`);
}

/** カンバンの Iteration の見出しから Plan を頼み、承認待ちの Plan の依存グラフを開いて、承認する */
async function planFlow(rec, app, { work }) {
  await setupAgent(rec, { file: "claude", code: "", term: "auto" });
  await rec.hold(600);
  await askAndPaste(rec, app, app.locator("header.board-head .ask-bubble").first(), "Plan");
  await termSay(rec, "dot", "● Reading s1: 7 tickets and their dependencies…", 900);
  await dgSteps(rec, work, [["plan", "create", ...EXPORT_IDS]]);
  await termSay(rec, "dot", "● Plan p1 (awaiting approval)", 200);
  await termSay(rec, "dim", "  t1 ∥ t2 ∥ t3 can start at once", 200);
  await termSay(rec, "dim", "  then t4 ∥ t5, last t6 ∥ t7", 500);
  // 番号は Plan 詳細へのリンクなので、状態の文字を押してグラフを開く
  await rec.moveTo(app.locator(".plan-line .plan-state").first(), 600);
  await rec.click();
  await waitGraphFits(app);
  await rec.hold(1600);
  await termSay(rec, "ask", "? Approve plan p1?", 200);
  await termSay(rec, "sel", "  ❯ 1. Approve", 100);
  await termSay(rec, "dim", "    2. Revise", 600);
  await rec.moveTo(rec.page.locator(".term-input"), 500, 0.3);
  await termChoose(rec, "1");
  await dgSteps(rec, work, [["plan", "approve", "p1"]]);
  await termSay(rec, "ok", "✓ Approved p1. Start it with /dgwork", 2600);
}

/**
 * カンバンの上の帯の Plan から Run Plan（/dgwork p1）を頼み、依存グラフを開いたまま、待ちのないチケットが並列に In Progress になって
 * すべて Done になるまでを早送りで見せる（グラフのノードの色と、下のカンバンの列が一緒に変わる）
 */
async function workFlow(rec, app, { work }) {
  await setupAgent(rec, { file: "claude", code: "", term: "auto" });
  await rec.hold(500);
  await rec.moveTo(app.locator(".plan-line .plan-state").first(), 500);
  await rec.click();
  await waitGraphFits(app);
  await rec.hold(700);
  await askAndPaste(rec, app, app.locator(".plan-row .ask-bubble").first(), "Run Plan");
  await rec.moveTo(rec.page.locator(".term-lines"), 400, 0.5, 0.6);
  await termSay(rec, "dot", "● Plan p1 is approved. t1, t2 and t3 can start", 500);
  await rec.page.evaluate(() => (document.querySelector(".ff").hidden = false));
  // 着手は In Progress に、マージは Review・Done と PR の番号をまとめて流す（読み直しを 1 回にする）
  const start = (...ids) =>
    dgSteps(
      rec,
      work,
      ids.map((id) => ["ticket", "move", id, "in_progress"]),
    );
  const merge = async (id, pr) => {
    await dgSteps(rec, work, [
      ["ticket", "move", id, "review"],
      ["ticket", "move", id, "done"],
      ["ticket", "update", id, "--pr", String(pr)],
    ]);
    await termSay(rec, "ok", `✓ ${id} merged (PR #${pr}, gate passed)`, 400);
  };
  // 3 人のエージェントで進める。待ちが済んだチケットから着手する（t4 は t1、t5 は t2 と t3、t6 は t3 と t4、t7 は t5 のあと）
  await start("t1", "t2", "t3");
  await termSay(rec, "dot", "● Working on t1, t2 and t3 in parallel (worktrees)…", 1000);
  await merge("t1", 1);
  await start("t4");
  await termSay(rec, "dot", "● t4 is unblocked. Working on t2, t3 and t4…", 900);
  await merge("t2", 2);
  await merge("t3", 3);
  await start("t5");
  await termSay(rec, "dot", "● t5 is unblocked. Working on t4 and t5…", 700);
  await merge("t4", 4);
  await start("t6");
  await termSay(rec, "dot", "● t6 is unblocked. Working on t5 and t6…", 700);
  await merge("t5", 5);
  await start("t7");
  await termSay(rec, "dot", "● t7 is unblocked. Working on t6 and t7…", 700);
  await merge("t6", 6);
  await merge("t7", 7);
  await rec.page.evaluate(() => (document.querySelector(".ff").hidden = true));
  await termSay(rec, "ok", "✓ Plan p1 finished: 7/7 done", 2400);
}

/**
 * 履歴で閉じた Iteration の Retrospect を頼み、dg guide retro の流れで答える：数字の要約（工程ごとの所要時間とトークンの割合・1 行あたりのトークン）→
 * 観点を選ぶ → トークンを根拠に含む Keep / Problem / Try → 承認した Try を起票。振り返りはチャットで答え、ファイルは書かない
 */
async function retroFlow(rec, app, { work }) {
  await setupAgent(rec, { file: "claude", code: "", term: "auto" });
  await rec.hold(500);
  const row = app.locator("summary.history-row", { hasText: "Show priority clearly" });
  await askAndPaste(rec, app, row.locator(".ask-bubble").first(), "Retrospect");
  await termSay(rec, "tool", "● Bash(<i>dg metrics show --iteration s2 --by step</i>)", 500);
  await termSay(rec, "dot", "● s2: 5/5 done · 19 runs · 2 h 11 min · 2.4M tokens", 150);
  await termSay(rec, "dim", "  step       time  tokens", 100);
  await termSay(rec, "dim", "  implement   40%     46%", 100);
  await termSay(rec, "prob", "  review      29%     25%", 100);
  await termSay(rec, "prob", "  fix         24%     23%", 100);
  await termSay(rec, "dim", "  Per changed line: 310 output tokens", 100);
  await termSay(rec, "dim", "  9 retries · 2 heavy findings · 1 failure", 800);
  await termSay(rec, "ask", "? Which viewpoints? (multi-select)", 100);
  await termSay(rec, "sel", "  ◉ 1. Rework: 9 retries, 2 heavy findings", 100);
  await termSay(rec, "sel", "  ◉ 2. Efficiency: 310 output tokens per line", 100);
  await termSay(rec, "dim", "  ○ 3. Flow  ○ 4. Outcome  ○ 5. Comparison", 500);
  await termChoose(rec, "1 2");
  await termSay(rec, "tool", "● Bash(<i>dg metrics show --iteration s2 --by ticket</i>)", 600);
  await termSay(rec, "keep", "  Keep    t4 t6 t8 passed review first time", 150);
  await termSay(rec, "prob", "  Problem review→fix looped 7 times on t5 t7:", 50);
  await termSay(rec, "prob", "          1.1M tokens (48% of s2)", 150);
  await termSay(rec, "try", "  Try #3  Write checkable acceptance criteria", 50);
  await termSay(rec, "try", "          when filing → File", 800);
  await termSay(rec, "ask", "? Reflect which Try rows?", 100);
  await termSay(rec, "sel", "  ❯ 1. #3 File", 100);
  await termSay(rec, "dim", "    2. Do not reflect", 500);
  await termChoose(rec, "1");
  await dgSteps(rec, work, [
    [
      "ticket",
      "create",
      "Write checkable acceptance criteria when filing",
      "--label",
      "retro-s2",
      "--acceptance",
      "Retries per ticket go down in the next Iteration",
    ],
  ]);
  await termSay(rec, "ok", "✓ Filed t11 (retro-s2)", 400);
  // 起票したチケットがバックログに並んだのを見せる
  await rec.moveTo(app.locator(".topbar nav a", { hasText: "Backlog" }), 500);
  await rec.click();
  await rec.hold(2200);
}

/**
 * 1 本を録る。左パネルは拡張ホストの代わりの仲立ちで Webview として動かし、外枠にターミナルを置く。
 * 台本は (rec, app, ctx) で、app は左パネルの FrameLocator、ctx は一時リポジトリ（work・tmp）
 */
async function record(browser, server, icon, job, ctx) {
  const side = job.side ?? SIDE;
  const width = gifWidth(job);
  const context = await browser.newContext({
    viewport: { width, height: HEIGHT },
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(server.url).origin,
  });
  await context.addInitScript(englishScreen);
  await context.addInitScript(vscodeShim);
  const page = await context.newPage();
  // 外枠も dg serve と同じオリジンから出す（iframe の画面と postMessage でやり取りするため）
  const frameUrl = `${server.url}__gif-frame.html`;
  const appUrl = `${server.url}?gif-host=sidebar${job.hash}`;
  await page.route(frameUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: frameHtml(appUrl, icon, side) }),
  );
  await page.goto(frameUrl, { waitUntil: "networkidle" });
  const app = page.frameLocator(".side iframe");
  await app.locator(".topbar").waitFor();
  const rec = new Recorder(page, width, side);
  await job.script(rec, app, ctx);
  await context.close();
  return rec.frames;
}

/** 画面の幅（CSS の px）。左パネルを広げた分だけ広げ、エディタとターミナルの幅は変えない */
const gifWidth = (job) => WIDTH + (job.side ?? SIDE) - SIDE;

async function main() {
  const only = process.argv.slice(2);
  const jobs = [
    { name: "import.gif", hash: "#/backlog", script: importFlow, repo: importRepo },
    { name: "assign.gif", hash: "#/backlog", script: assignFlow, repo: assignRepo },
    { name: "plan.gif", hash: "#/board", script: planFlow, repo: planRepo, side: PLAN_SIDE },
    { name: "work.gif", hash: "#/board", script: workFlow, repo: workRepo, side: PLAN_SIDE },
    { name: "retro.gif", hash: "#/history", script: retroFlow, repo: retroRepo },
  ];
  const unknown = only.filter((name) => !jobs.some((job) => job.name === name));
  if (unknown.length)
    throw new Error(
      `知らない GIF の名前: ${unknown.join("、")}（${jobs.map((j) => j.name).join("・")} から選ぶ）`,
    );
  if (only.length) jobs.splice(0, jobs.length, ...jobs.filter((job) => only.includes(job.name)));
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-gifs-")));
  const servers = [];
  let browser;
  try {
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
    // 台本がデータを書き換えるので、見本のリポジトリは 1 本ごとに作る
    for (const job of jobs) {
      const dir = path.join(tmp, job.name.replace(/\.gif$/, ""));
      await mkdir(dir);
      const work = await job.repo(dir);
      const server = await startServer({ cwd: work, port: 0, user: "Sample", staticDir: webDist });
      servers.push(server);
      const frames = await record(browser, server, icon, job, { work, tmp: dir });
      const bytes = encodeGif(frames);
      await writeFile(path.join(outDir, job.name), bytes);
      const seconds = frames.reduce((sum, f) => sum + f.delay, 0) / 1000;
      const kb = Math.round(bytes.length / 1024);
      const ok = checkGif({ seconds, bytes: bytes.length, range: [0, 20] });
      console.log(
        `${job.name}: ${gifWidth(job) * SCALE}x${HEIGHT * SCALE}、${seconds.toFixed(1)} 秒、${kb} KB、${frames.length} コマ${ok ? "" : "（20 秒以下・1MB 以下に収まらない）"}`,
      );
      if (!ok) process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    for (const server of servers) await server.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

await main();
