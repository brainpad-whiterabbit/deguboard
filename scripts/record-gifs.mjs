// README（と、そこから作る拡張の README）に載せる使い方の GIF（packages/vscode/images/ の 5 本）を録り直す。mise run gifs から呼ぶ。引数に名前（import.gif など）を渡せばその分だけ録る。
// 一時ディレクトリに bare リモート付きのリポジトリを作って見本のチケットを起票し、dg serve の左パネルの画面（?surface=sidebar）を
// Chromium（playwright-core）で操作して 1 コマずつスクリーンショットを撮り、gifenc で GIF にまとめる。ffmpeg などの外のツールは使わない。
// VS Code 本体は録れないので、Activity Bar とエディタの部分は画面の外枠として自前で描く（frameHtml）。左パネルの中身は実際の画面。
// マウスのカーソルはスクリーンショットに映らないので、外枠の上に矢印を描いて動かす。コマの表示時間は撮った時刻ではなく台本（各 shot の delay）で決めるので、
// 機械の速さによらず同じ長さになる。ask-agent.gif の貼り付け先は、コピーした依頼文が分かるように外枠に描いた入力欄で、VS Code やエージェントの画面ではない。
// エージェントの流れの 3 本（import・run-all・retro。t348）は、実際の実行の録画ではなく仮の GUI で録る。ターミナルのエージェント（Claude Code の入力と出力）は
// 外枠に描いた模した画面で、エージェントが dg を動かした結果（起票・計画・状態の遷移）は、台本が一時リポジトリで実際に dg のコマンドを流して左パネルに反映させる。
// この 3 本の左パネルとエディタのパネル（チケットの詳細）は、拡張ホストの代わりの小さな仲立ち（vscodeShim）で Webview として動かし、
// 詳細を開く・コピー・読み直しを拡張と同じ通り道で受ける。retro.gif の分析レポートは模したもの（数字は見本）。
// 画面は英語の表示（<html data-language="en"> を入れる）で、CSS の 760x460 を 1.5 倍の解像度で撮る（GIF は 1140x690。README の表示幅 560px の 2 倍で文字がにじまない。t458）。
// 先に mise run build（タスクが依存する）と mise run playwright:install が要る。各 GIF が決めた秒数（open-board・ask-agent は 6〜10 秒、ほかは 20 秒以下）と 1MB 以下に収まらなければ失敗する。
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
 * README の表示幅（560px）の 2 倍（1120px）以上で文字がにじまないように、1.5 倍の解像度で撮る（t458）
 */
const WIDTH = 760;
const HEIGHT = 460;
const SCALE = 1.5;
const BAR = 48;
const SIDE = 300;
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

/** 見本のリポジトリを作り、カンバン・バックログ・履歴に何かが出るようにチケットを置く */
async function createRepo(dir) {
  const work = await initRepo(dir);
  // 閉じた Iteration（履歴に出る）・進行中・予定の 3 つ
  await dg(work, ["iteration", "create", "Iteration 1", "--goal", "Harden the login flow"]);
  await dg(work, ["iteration", "start", "s1"]);
  const done = ["in_progress", "review", "done"];
  const closed = [
    ["Add input checks to the login form", "s1", "high", done],
    ["Send password reset emails", "s1", "medium", done],
    ["Log failed logins", "s1", "low", done],
  ];
  const open = [
    ["Remember the list order", "s2", "medium", ["in_progress", "review"]],
    ["Speed up the CSV export", "s2", "medium", ["in_progress"]],
    ["Add dark mode to settings", "s2", "high", []],
    ["Unify error messages", "s2", "low", []],
    ["Filter search results by count", "s3", "medium", []],
    ["Localize notification emails", null, "medium", []],
    ["Remove calls to the old API", null, "low", []],
  ];
  let id = 0;
  const create = async ([title, iteration, priority, moves]) => {
    const args = ["ticket", "create", title, "--priority", priority];
    if (iteration) args.push("--iteration", iteration);
    args.push("--acceptance", "Checked on screen");
    await dg(work, args);
    id += 1;
    for (const status of moves) await dg(work, ["ticket", "move", `t${id}`, status]);
  };
  for (const ticket of closed) await create(ticket);
  await dg(work, ["iteration", "close", "s1"]);
  await dg(work, ["iteration", "create", "Iteration 2", "--goal", "Make the list easier to use"]);
  await dg(work, ["iteration", "start", "s2"]);
  await dg(work, ["iteration", "create", "Iteration 3"]);
  for (const ticket of open) await create(ticket);
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

/** run-all.gif の見本：始めたばかりの空の Iteration。起票・計画・遷移は台本が dg で行う */
async function runAllRepo(dir) {
  const work = await initRepo(dir);
  await dg(work, ["iteration", "create", "Iteration 1", "--goal", "Export to CSV"]);
  await dg(work, ["iteration", "start", "s1"]);
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
 * agent を付ければエディタの下にターミナルのエージェント（Claude Code）を模した画面を置き、詳細を開く頼みでエディタにパネルの画面（iframe）を開く
 */
function frameHtml(appUrl, icon, agent = false) {
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
  .agent pre{margin:0;min-height:18px;color:#d4d4d4;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
  .agent pre:empty::before{content:"Paste here";color:#6b6b6b}
  .cursor{position:fixed;left:0;top:0;width:16px;height:22px;z-index:10;pointer-events:none}
  .ring{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #4daafc;z-index:9;pointer-events:none;display:none}
  .tabs b[hidden],.editor [hidden]{display:none}
  .tabs b.off{background:#181818;color:#8b8b8b}
  .editor{flex:1;min-height:0;position:relative;overflow:hidden}
  .editor pre{margin:0;padding:12px 18px;color:#9cdcfe;font:12px/1.7 ui-monospace,Menlo,Consolas,monospace;white-space:pre}
  .editor pre em{font-style:normal;color:#c586c0}
  .editor iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#1f1f1f}
  .term{height:var(--term,46%);flex:none;border-top:1px solid #2b2b2b;background:#181818;display:flex;flex-direction:column;padding:6px 12px 10px;gap:3px;color:#d4d4d4;font:11.5px/1.55 ui-monospace,Menlo,Consolas,monospace;overflow:hidden}
  .term-head{color:#8b8b8b;font:11px system-ui,-apple-system,"Segoe UI",sans-serif;flex:none;margin-bottom:2px}
  .term-head b{font-weight:400;color:#d4d4d4;border-bottom:1px solid #d4d4d4;padding-bottom:1px}
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
  .term-input{flex:none;border:1px solid #4a4a4a;border-radius:6px;padding:4px 8px;display:flex;gap:6px;min-height:26px;overflow:hidden}
  .term-input .text{flex:1;min-width:0;word-break:break-all}
  .term-input.focus{border-color:#8b8b8b}
  .term-input.focus .text::after{content:"";display:inline-block;width:7px;height:13px;background:#d4d4d4;vertical-align:-2px;margin-left:1px}
  .term-input .text div,.term-lines .you div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .report{padding:12px 18px;color:#cccccc;font-size:11.5px;display:flex;flex-direction:column;gap:5px}
  .report h3{margin:0 0 2px;font-size:15px;color:#e8e8e8}
  .report p{margin:0}
  .report .sub{color:#8b8b8b;font-size:10.5px;margin-bottom:4px}
  .rbar{display:grid;grid-template-columns:76px 1fr 96px;gap:8px;align-items:center;font-size:11px}
  .rbar code{font:11px ui-monospace,Menlo,Consolas,monospace}
  .rbar i{display:block;height:9px;border-radius:2px;background:#4daafc;width:0}
  .rbar.hot i{background:#e5534b}
  .rbar span{color:#8b8b8b;font:10.5px ui-monospace,Menlo,Consolas,monospace;text-align:right}
  .report .call{margin-top:6px;border-left:3px solid #e5534b;background:#2a2d2e;padding:5px 8px;line-height:1.55}
  .report .call b{color:#f47067}
  .report ul{margin:2px 0 0;padding-left:1.3em;line-height:1.6}
  .report [hidden]{display:none}
</style></head><body><div class="win">
  <div class="bar">
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg></span>
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/></svg></span>
    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 4-10 2-10 5"/></svg></span>
    <span class="dg">${icon}</span>
  </div>
  <div class="side"><iframe src="${appUrl}" allow="clipboard-read; clipboard-write"></iframe></div>
  ${
    agent
      ? AGENT_MAIN
      : `<div class="main">
    <div class="tabs"><b>README.md</b></div>
    <div class="code">${[62, 48, 0, 70, 55, 40, 0, 66, 30]
      .map((w) => `<i style="width:${w}%;${w ? "" : "background:none"}"></i>`)
      .join("")}</div>
    <div class="agent"><small>Agent input (example)</small><pre></pre></div>
  </div>`
  }
</div>
<div class="ring"></div>
<svg class="cursor" viewBox="0 0 16 22"><path d="M1 1v17l4.5-4.2 3 6.7 2.8-1.3-3-6.5H14z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>
${agent ? `<script>${AGENT_SCRIPT}</script>` : ""}
</body></html>`;
}

/** agent の外枠のエディタとターミナル。エディタの中身（コード・詳細のパネル・レポート）は台本が切り替える */
const AGENT_MAIN = `<div class="main">
    <div class="tabs"><b class="tab-code">README.md</b><b class="tab-doc" hidden></b></div>
    <div class="editor"><pre class="src"></pre><iframe class="detail" hidden></iframe><div class="report" hidden></div></div>
    <div class="term">
      <div class="term-head"><b>Terminal</b>　claude</div>
      <div class="term-lines"></div>
      <div class="term-input"><span>&gt;</span><span class="text"></span></div>
    </div>
  </div>`;

/**
 * agent の外枠が左パネル・詳細のパネルの仲立ち（vscodeShim）から受ける頼み。copy は受けた文を残し（台本が貼る）、
 * open は詳細のルートをエディタのパネル（iframe）に開く。開いていればハッシュだけを変える（VS Code のパネルと同じく 1 枚を使い回す）
 */
const AGENT_SCRIPT = `
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
  for (const label of ["Backlog", "History", "Board"]) {
    await rec.moveTo(app.locator(".topbar nav a", { hasText: label }), 450);
    await rec.click();
    await rec.hold(label === "Board" ? 1200 : 1300);
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
  for (const ch of "also add tests") {
    await page.keyboard.type(ch);
    await rec.shot(90);
  }
  await rec.hold(400);
  await rec.moveTo(composer.locator(".ask-copy"), 400);
  await rec.click();
  await rec.hold(600);
  const copied = await frame.evaluate(() => navigator.clipboard.readText());
  await rec.moveTo(page.locator(".agent"), 600, 0.4);
  await rec.click();
  await page.evaluate(() => document.querySelector(".agent").classList.add("focus"));
  await rec.shot(250);
  await page.evaluate((text) => (document.querySelector(".agent pre").textContent = text), copied);
  await rec.hold(1400);
}

/** agent の外枠を整える：左パネルを開き、エディタにファイル名とコード、ターミナルの高さを入れる（コードが空ならターミナルだけ） */
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
    [SIDE, file, code, term],
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

/** 出力の欄に 1 行足して ms ミリ秒止める。kind は色（dot はエージェントの発言の ⏺、tool は道具の呼び出し） */
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

/** 出力の欄の最後の行を書き換える（「進めています」を「マージしました」に替えるなど） */
async function termReplace(rec, html, ms = 400) {
  await rec.page.evaluate(
    (html) => (document.querySelector(".term-lines").lastElementChild.innerHTML = html),
    html,
  );
  await rec.hold(ms);
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

const IMPORT_CODE = [
  "<em>export async function</em> login(id, password) {",
  "  <em>const</em> user = <em>await</em> fetchUser(id);",
  "  <em>const</em> perms = <em>await</em> fetchPerms(id);",
  '  <em>if</em> (!user) <em>throw new</em> Error("Login failed");',
  "  <em>return</em> { user, perms };",
  "}",
].join("\n");

/** 雑な一言に /dgimport を付けて頼み、起票の案を承認し、バックログに並んだチケットの詳細を開く */
async function importFlow(rec, app, _frame, { work, tmp }) {
  await setupAgent(rec, { file: "login.ts", code: IMPORT_CODE, term: "52%" });
  await rec.hold(500);
  await rec.moveTo(rec.page.locator(".term-input"), 500, 0.3);
  await rec.click();
  await termType(rec, "/dgimport Login is slow and the errors are hard to follow. Fix it somehow");
  await rec.hold(300);
  await termEnter(rec);
  await termSay(rec, "dot", "⏺ Looking at src/auth/ and the login screen…", 900);
  await termSay(rec, "dot", "⏺ Draft tickets (3)", 300);
  await termSay(rec, "dim", "  1. Make login call the API once · high", 300);
  await termSay(rec, "dim", "  2. Split error messages by cause", 300);
  await termSay(rec, "dim", "  3. Add a test that measures login time · after 1", 300);
  await termSay(rec, "ask", "? Create these tickets?", 200);
  await termSay(rec, "sel", "  ❯ 1. Create tickets", 100);
  await termSay(rec, "dim", "    2. Revise", 700);
  // 選択肢を 1 で選んで Enter で送る
  await termType(rec, "1");
  await rec.hold(400);
  await termEnter(rec);
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

/** /dgall --auto を付けて頼み、起票・計画のあと、計画の帯から依存のグラフを開き、チケットが Todo から In Progress を経てすべて Done になる */
async function runAllFlow(rec, app, _frame, { work, tmp }) {
  await setupAgent(rec, { file: "claude", code: "", term: "auto" });
  await rec.hold(500);
  await rec.moveTo(rec.page.locator(".term-input"), 500, 0.3);
  await rec.click();
  await termType(rec, "/dgall --auto add CSV export");
  await rec.hold(200);
  await termEnter(rec);
  await termSay(rec, "dot", "⏺ Looking at the list screen and the export code…", 600);
  const drafts = [
    { key: "format", title: "Decide the export columns and format" },
    { key: "csv", title: "Build the CSV from the list", depends_on: ["format"] },
    { key: "button", title: "Add an export button to the screen", depends_on: ["format"] },
    { key: "docs", title: "Update the usage docs", depends_on: ["csv", "button"] },
  ].map((d) => ({ ...d, iteration: "s1", acceptance: ["Checked on screen"] }));
  const file = path.join(tmp, "import.json");
  await writeFile(file, JSON.stringify(drafts));
  await dgSteps(rec, work, [["ticket", "import", file]]);
  await termSay(rec, "dot", "⏺ Created 4 tickets: t1 t2 t3 t4", 700);
  await dgSteps(rec, work, [
    ["plan", "create", "t1", "t2", "t3", "t4"],
    ["plan", "approve", "p1"],
  ]);
  await termSay(rec, "dot", "⏺ Plan p1: t1 → t2 ∥ t3 → t4", 300);
  await termSay(rec, "dim", "  --auto, so it picked the suggested option (approve)", 500);
  // 番号は Plan 詳細へのリンクなので、状態の文字を押してグラフを開閉する
  await rec.moveTo(app.locator(".plan-line .plan-state").first(), 600, 0.5);
  await rec.click();
  await app.locator(".plan-graph").waitFor();
  await rec.hold(1500);
  // 左パネルの高さではグラフとカンバンの節が並ばないので、閉じて進む様子を見せ、終わったらまた開く
  await rec.click();
  await rec.hold(300);
  await rec.moveTo(rec.page.locator(".term-lines"), 500, 0.5, 0.6);
  const step = async (moves) =>
    dgSteps(
      rec,
      work,
      moves.map(([id, to]) => ["ticket", "move", id, to]),
    );
  await step([["t1", "in_progress"]]);
  await termSay(rec, "dot", "⏺ Working on t1…", 1100);
  await step([
    ["t1", "review"],
    ["t1", "done"],
  ]);
  await termReplace(rec, "⏺ t1 done (merged PR #1)", 700);
  await step([
    ["t2", "in_progress"],
    ["t3", "in_progress"],
  ]);
  await termSay(rec, "dot", "⏺ Working on t2 and t3 in parallel…", 1100);
  await step([
    ["t3", "review"],
    ["t3", "done"],
  ]);
  await rec.hold(500);
  await step([
    ["t2", "review"],
    ["t2", "done"],
  ]);
  await termReplace(rec, "⏺ t2 and t3 done (merged PR #2 #3)", 700);
  await step([["t4", "in_progress"]]);
  await termSay(rec, "dot", "⏺ Working on t4…", 1000);
  await step([
    ["t4", "review"],
    ["t4", "done"],
  ]);
  await termReplace(rec, "⏺ t4 done (merged PR #4)", 500);
  await termSay(rec, "ok", "✓ Plan p1 finished (4/4 done)", 700);
  await rec.moveTo(app.locator(".plan-line .plan-state").first(), 500, 0.5);
  await rec.click();
  await app.locator(".plan-graph").waitFor();
  await rec.hold(1800);
}

/** retro.gif の分析レポート（模したもの。工程ごとの所要時間とトークン、ボトルネック、次に直すこと） */
const RETRO_REPORT = `<h3>Retrospect on s2 (Show priority clearly)</h3>
<p class="sub">5 tickets · 19 runs · 2 h 11 min total · 2.4M tokens</p>
${[
  ["plan", 6, "6 min · 80k"],
  ["implement", 52, "52 min · 1.1M"],
  ["review", 38, "38 min · 610k"],
  ["fix", 31, "31 min · 540k"],
  ["merge", 4, "4 min · 20k"],
]
  .map(
    ([step, min, text]) =>
      `<div class="rbar${step === "review" || step === "fix" ? " hot" : ""}"><code>${step}</code><i data-w="${(min / 52) * 100}"></i><span>${text}</span></div>`,
  )
  .join("")}
<p class="call" hidden><b>Bottleneck</b>: review → fix looped 9 times, about half of the time. Concentrated on t5 and t7 (vague acceptance criteria)</p>
<ul hidden><li>Write concrete acceptance criteria when creating tickets</li><li>Use the heavy tier for tickets that change the screen</li></ul>`;

const RETRO_CODE = [
  '<em>import</em> { listTickets } <em>from</em> "./core";',
  "",
  "<em>export function</em> render(board) {",
  "  <em>return</em> board.columns.map((col) =&gt; row(col));",
  "}",
].join("\n");

/** 履歴で終わった Iteration の「振り返る」に指示を足して頼み、Run の集計から書いた分析レポートが開く */
async function retroFlow(rec, app) {
  const page = rec.page;
  await setupAgent(rec, { file: "app.ts", code: RETRO_CODE, term: "40%" });
  await rec.hold(500);
  const row = app.locator("summary.history-row", { hasText: "Show priority clearly" });
  await rec.moveTo(row, 600, 0.4);
  await rec.hold(300);
  await rec.moveTo(row.locator(".ask-bubble").first(), 300);
  await rec.click();
  await app.locator(".ask-menu").waitFor();
  await rec.hold(700);
  await rec.moveTo(app.locator(".ask-menu [role=menuitem]", { hasText: "Retrospect" }), 350);
  await rec.click();
  const composer = app.locator(".ask-composer");
  await composer.waitFor();
  await rec.hold(500);
  await rec.moveTo(composer.locator("textarea"), 350);
  await rec.click();
  const note = "find the bottleneck and write a report";
  for (let i = 0; i < note.length; i += 2) {
    await page.keyboard.type(note.slice(i, i + 2));
    await rec.shot(90);
  }
  await rec.hold(300);
  await rec.moveTo(composer.locator(".ask-copy"), 400);
  await rec.click();
  await rec.hold(600);
  const copied = await page.evaluate(() => window.copied);
  await rec.moveTo(page.locator(".term-input"), 600, 0.3);
  await rec.click();
  await termType(rec, copied, true);
  await rec.hold(900);
  await termEnter(rec);
  await termSay(rec, "tool", "⏺ Bash(<i>dg metrics show --iteration s2 --by step</i>)", 500);
  await termSay(rec, "tool", "⏺ Bash(<i>dg metrics show --iteration s2 --by ticket</i>)", 500);
  await termSay(rec, "dot", "⏺ Looking at tickets with many review and fix loops…", 800);
  await termSay(rec, "ok", "✓ Wrote the report: reports/s2-retro.md", 500);
  await page.evaluate((html) => {
    const report = document.querySelector(".report");
    report.innerHTML = html;
    report.hidden = false;
    window.showDoc("s2-retro.md");
    document.querySelector(".term").style.setProperty("--term", "24%");
  }, RETRO_REPORT);
  await rec.shot(200);
  for (const t of [0.35, 0.7, 1]) {
    await page.evaluate((t) => {
      for (const i of document.querySelectorAll(".rbar i")) i.style.width = `${i.dataset.w * t}%`;
    }, t);
    await rec.shot(90);
  }
  await rec.hold(900);
  await page.evaluate(() => (document.querySelector(".report .call").hidden = false));
  await rec.hold(1300);
  await page.evaluate(() => (document.querySelector(".report ul").hidden = false));
  await rec.hold(2400);
}

/**
 * 1 本を録る。job.agent なら左パネルを拡張ホストの代わりの仲立ちで Webview として動かし、外枠にターミナルを置く。
 * 台本は (rec, app, frame, ctx) で、app は左パネルの FrameLocator、frame はその Frame、ctx は一時リポジトリ（work・tmp）
 */
async function record(browser, server, icon, job, ctx) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(server.url).origin,
  });
  await context.addInitScript(englishScreen);
  if (job.agent) await context.addInitScript(vscodeShim);
  const page = await context.newPage();
  // 外枠も dg serve と同じオリジンから出す（iframe の画面のクリップボードを読むため）
  const frameUrl = `${server.url}__gif-frame.html`;
  const appUrl = `${server.url}?${job.agent ? "gif-host" : "surface"}=sidebar${job.hash}`;
  await page.route(frameUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: frameHtml(appUrl, icon, job.agent) }),
  );
  await page.goto(frameUrl, { waitUntil: "networkidle" });
  const frame = page.frames().find((f) => f.url().startsWith(appUrl));
  const app = page.frameLocator(".side iframe");
  await app.locator(".topbar").waitFor();
  const rec = new Recorder(page);
  await job.script(rec, app, frame, ctx);
  await context.close();
  return rec.frames;
}

async function main() {
  const only = process.argv.slice(2);
  const jobs = [
    { name: "open-board.gif", hash: "#/board", script: openBoard, seconds: [6, 10] },
    { name: "ask-agent.gif", hash: "#/board", script: askAgent, seconds: [6, 10] },
    { name: "import.gif", hash: "#/backlog", script: importFlow, repo: importRepo, agent: true },
    { name: "run-all.gif", hash: "#/board", script: runAllFlow, repo: runAllRepo, agent: true },
    { name: "retro.gif", hash: "#/history", script: retroFlow, repo: retroRepo, agent: true },
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
    // 見本のリポジトリは、台本がデータを書き換える 3 本はそれぞれに作り、見るだけの 2 本は 1 つを使い回す
    const shared = new Map();
    for (const job of jobs) {
      const build = job.repo ?? createRepo;
      let ctx = shared.get(build);
      if (!ctx) {
        const dir = path.join(tmp, job.name.replace(/\.gif$/, ""));
        await mkdir(dir);
        const work = await build(dir);
        const server = await startServer({
          cwd: work,
          port: 0,
          user: "Sample",
          staticDir: webDist,
        });
        servers.push(server);
        ctx = { work, tmp: dir, server };
        if (!job.repo) shared.set(build, ctx);
      }
      const frames = await record(browser, ctx.server, icon, job, ctx);
      const bytes = encodeGif(frames);
      await writeFile(path.join(outDir, job.name), bytes);
      const seconds = frames.reduce((sum, f) => sum + f.delay, 0) / 1000;
      const kb = Math.round(bytes.length / 1024);
      const [min, max] = job.seconds ?? [0, 20];
      const ok = checkGif({ seconds, bytes: bytes.length, range: [min, max] });
      console.log(
        `${job.name}: ${WIDTH * SCALE}x${HEIGHT * SCALE}、${seconds.toFixed(1)} 秒、${kb} KB、${frames.length} コマ${ok ? "" : `（${min ? `${min}〜` : ""}${max} 秒${min ? "" : "以下"}・1MB 以下に収まらない）`}`,
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
