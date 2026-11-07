// 文書と dg guide の大きさの予算・ADR 一覧の整合と更新日の一致・リンクと見出しアンカーの切れ・拡張と Walkthrough が指す README の見出しアンカー・README.md と README.ja.md の節の構成のずれを検査する（docs/adr/ADR-001-doc-strategy.md）。
// 依存なしで動かす。mise run check:docs から呼ぶ。
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 予算（バイト）。超えたら失敗、WARN_RATIO を超えたら警告する。どちらも細部を正本（ヘルプ・コード・テスト）へ移すか、約束を見直すきっかけ
// 予算を重複と参照の検査に置き換えるまで（t536）のつなぎとして、値を一旦 2 倍にゆるめている
const budgets = [
  ["CLAUDE.md", 12 * 1024],
  ["README.md", 32 * 1024],
  ["README.ja.md", 32 * 1024],
  ["docs/requirements.md", 80 * 1024],
  ["docs/development.md", 40 * 1024],
];
const adrBudget = 24 * 1024;
// エージェントが作業中に読む dg guide のトピック（1 本ずつ）
const guideDir = "packages/cli/src";
const guideBudget = 28 * 1024;
const WARN_RATIO = 0.9;

const errors = [];
const warnings = [];

for (const [file, limit] of budgets) {
  const size = await sizeOf(file);
  if (size === null) {
    errors.push(`${file}: ファイルがない`);
  } else {
    checkBudget(file, size, limit);
  }
}

const adrDir = path.join(root, "docs", "adr");
const adrFiles = (await readdir(adrDir)).filter((f) => /^ADR-\d{3}-.+\.md$/.test(f)).sort();
const numbers = new Map();
for (const file of adrFiles) {
  const rel = `docs/adr/${file}`;
  checkBudget(rel, await sizeOf(rel), adrBudget);
  const number = file.slice(0, 7);
  if (numbers.has(number)) {
    errors.push(`${number} が重複している: ${numbers.get(number)} と ${file}`);
  }
  numbers.set(number, file);
}

const guideFiles = (await readdir(path.join(root, guideDir)))
  .filter((f) => /^guide-.+\.md$/.test(f))
  .sort();
for (const file of guideFiles) {
  const rel = `${guideDir}/${file}`;
  checkBudget(rel, await sizeOf(rel), guideBudget);
}

const index = await readFile(path.join(adrDir, "README.md"), "utf8");
const linked = new Set([...index.matchAll(/\]\((ADR-\d{3}-[^)]+\.md)\)/g)].map((m) => m[1]));
for (const file of adrFiles) {
  if (!linked.has(file)) {
    errors.push(`docs/adr/README.md: ${file} が一覧に載っていない`);
  }
}
for (const file of linked) {
  if (!adrFiles.includes(file)) {
    errors.push(`docs/adr/README.md: 一覧にある ${file} が存在しない`);
  }
}

// 更新日の検査：有効な ADR の「- 更新日：」が「有効な ADR」の表の更新日と一致すること（置き換え済みの ADR は表に更新日がないので見ない）
const indexDates = new Map();
for (const m of index.matchAll(
  /^\|\s*\[ADR-\d{3}\]\((ADR-\d{3}-[^)]+\.md)\).*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*$/gm,
)) {
  indexDates.set(m[1], m[2]);
}
let datedCount = 0;
for (const file of adrFiles) {
  if (!linked.has(file)) continue; // 一覧に載っていないことは上で指摘した
  const text = await readFile(path.join(adrDir, file), "utf8");
  if (/^- ステータス：置き換え/m.test(text)) continue;
  datedCount++;
  const own = /^- 更新日：(\d{4}-\d{2}-\d{2})\s*$/m.exec(text)?.[1];
  const listed = indexDates.get(file);
  if (own === undefined) {
    errors.push(`docs/adr/${file}: 「- 更新日：YYYY-MM-DD」の行がない`);
  } else if (listed === undefined) {
    errors.push(`docs/adr/README.md: ${file} の行に更新日がない`);
  } else if (own !== listed) {
    errors.push(`docs/adr/README.md: ${file} の更新日が ${listed} で、ADR の ${own} と食い違う`);
  }
}

// リンクの検査：README.md・README.ja.md・CLAUDE.md・docs/**/*.md の相対リンクの先があり、#アンカーが対象の見出しに合うこと。外部 URL は見ない
const docFiles = ["README.md", "README.ja.md", "CLAUDE.md", ...(await markdownFilesUnder("docs"))];
const headingsCache = new Map();
let linkCount = 0;
for (const rel of docFiles) {
  const lines = withoutCode(await readFile(path.join(root, rel), "utf8"));
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue; // http:・mailto: など
      linkCount++;
      const [file, anchor] = target.split("#");
      const targetRel = file
        ? path.normalize(path.join(path.dirname(rel), decodeURIComponent(file)))
        : rel;
      const where = `${rel}:${i + 1}`;
      if (file && !existsSync(path.join(root, targetRel))) {
        errors.push(`${where}: リンク先がない: ${target}`);
        continue;
      }
      if (anchor !== undefined && anchor !== "") {
        const slugs = headingsCache.get(targetRel) ?? (await headingSlugs(targetRel));
        headingsCache.set(targetRel, slugs);
        if (!slugs.has(decodeURIComponent(anchor).toLowerCase())) {
          errors.push(`${where}: 見出しがない: ${target}`);
        }
      }
    }
  }
}

// 拡張と Walkthrough が指す README の見出し：dg.ts と media/walkthrough は README の見出しを「このリポジトリの GitHub の URL の #アンカー」で指す（手順を二重に書かないため）。
// 上のリンクの検査は外部 URL を見ないので、ここで見る。見出しを変えると黙って切れるので、README.md の見出しのアンカーに照らす
const readmeUrl =
  /https:\/\/github\.com\/brainpad-whiterabbit\/deguboard(?:\/blob\/[^/\s"'`)]+\/README\.md)?#([^\s"'`)]+)/g;
let readmeAnchorCount = 0;
let readmeSlugs = null;
for (const rel of await filesUnder(
  ["packages/vscode/src", "packages/vscode/media"],
  [".ts", ".md"],
)) {
  const lines = (await readFile(path.join(root, rel), "utf8")).split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(readmeUrl)) {
      readmeAnchorCount++;
      readmeSlugs ??= await headingSlugs("README.md");
      const anchor = decodeURIComponent(m[1]).toLowerCase();
      if (!readmeSlugs.has(anchor)) {
        errors.push(`${rel}:${i + 1}: README.md に見出しがない: #${m[1]}`);
      }
    }
  }
}

// 節の構成の検査：README.ja.md は README.md と同じ節の構成で置く（CLAUDE.md）。# から ### の見出しの数と階層の並びを比べる。見出しの文言は訳すので比べない
const readmeHeadings = await outlineOf("README.md");
const readmeJaHeadings = await outlineOf("README.ja.md");
for (let i = 0; i < Math.max(readmeHeadings.length, readmeJaHeadings.length); i++) {
  const en = readmeHeadings[i];
  const ja = readmeJaHeadings[i];
  if (en?.level === ja?.level) continue;
  const show = (h) => (h ? `${"#".repeat(h.level)} ${h.text}（${h.line} 行目）` : "（なし）");
  errors.push(
    `README.ja.md: ${i + 1} 番目の見出しの階層が README.md とずれている: README.md は ${show(en)}、README.ja.md は ${show(ja)}（見出しは README.md が ${readmeHeadings.length} 個、README.ja.md が ${readmeJaHeadings.length} 個）`,
  );
  break; // 1 つずれると後ろはすべてずれるので、最初の 1 か所だけ出す
}

if (warnings.length > 0) {
  console.warn(`check:docs の警告（予算の ${WARN_RATIO * 100}% を超えた。失敗にはしない）`);
  for (const w of warnings) console.warn(`  - ${w}`);
}
if (errors.length > 0) {
  console.error("check:docs の指摘");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `check:docs: 予算内（文書 ${budgets.length} 件、ADR ${adrFiles.length} 件（更新日の一致 ${datedCount} 件）、guide ${guideFiles.length} 件）、リンク ${linkCount} 件に切れなし、README.ja.md の見出し ${readmeJaHeadings.length} 個が README.md と同じ構成、拡張と Walkthrough の README の見出しアンカー ${readmeAnchorCount} 件に切れなし`,
);

function checkBudget(rel, size, limit) {
  const usage = `${kb(size)} / 予算 ${kb(limit)}（${Math.round((size / limit) * 100)}%）`;
  if (size > limit) {
    errors.push(`${rel}: ${usage}。予算を超えている`);
  } else if (size > limit * WARN_RATIO) {
    warnings.push(`${rel}: ${usage}`);
  }
}

async function sizeOf(rel) {
  try {
    return (await stat(path.join(root, rel))).size;
  } catch {
    return null;
  }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

async function markdownFilesUnder(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .sort();
}

/** 指定したフォルダの下のファイルのうち、拡張子が exts のものを返す */
async function filesUnder(dirs, exts) {
  const files = [];
  for (const dir of dirs) {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
        files.push(path.relative(root, path.join(e.parentPath, e.name)));
      }
    }
  }
  return files.sort();
}

/** 行ごとの配列にし、```のコードブロックの中とインラインコードは空にする（行番号は保つ） */
function withoutCode(text) {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line.replace(/`[^`]*`/g, "");
  });
}

/** # から ### の見出しを、階層・文言・行番号の配列で返す。```のコードブロックの中の # は見出しにしない */
async function outlineOf(rel) {
  const text = await readFile(path.join(root, rel), "utf8");
  let inFence = false;
  const headings = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const m = inFence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  return headings;
}

/** 見出しを GitHub 流のアンカーにする：小文字化、記号を除く（文字・数字・空白・ハイフンだけ残す）、空白を - に。同名は -1、-2 を付ける */
async function headingSlugs(rel) {
  const lines = withoutCode(await readFile(path.join(root, rel), "utf8"));
  const seen = new Map();
  const slugs = new Set();
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}
