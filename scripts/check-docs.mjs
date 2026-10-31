// 文書の大きさの予算・ADR 一覧の整合・リンクと見出しアンカーの切れを検査する（docs/adr/ADR-001-doc-strategy.md）。
// 依存なしで動かす。mise run check:docs から呼ぶ。
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 予算（バイト）。超えたら、細部を正本（ヘルプ・コード・テスト）へ移すか、約束を見直す
const budgets = [
  ["CLAUDE.md", 6 * 1024],
  ["README.md", 12 * 1024],
  ["docs/requirements.md", 40 * 1024],
  ["docs/development.md", 15 * 1024],
];
const adrBudget = 10 * 1024;

const errors = [];

for (const [file, limit] of budgets) {
  const size = await sizeOf(file);
  if (size === null) {
    errors.push(`${file}: ファイルがない`);
  } else if (size > limit) {
    errors.push(`${file}: ${kb(size)} が予算 ${kb(limit)} を超えている`);
  }
}

const adrDir = path.join(root, "docs", "adr");
const adrFiles = (await readdir(adrDir)).filter((f) => /^ADR-\d{3}-.+\.md$/.test(f)).sort();
const numbers = new Map();
for (const file of adrFiles) {
  const rel = `docs/adr/${file}`;
  const size = await sizeOf(rel);
  if (size > adrBudget) {
    errors.push(`${rel}: ${kb(size)} が予算 ${kb(adrBudget)} を超えている`);
  }
  const number = file.slice(0, 7);
  if (numbers.has(number)) {
    errors.push(`${number} が重複している: ${numbers.get(number)} と ${file}`);
  }
  numbers.set(number, file);
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

// リンクの検査：README.md・CLAUDE.md・docs/**/*.md の相対リンクの先があり、#アンカーが対象の見出しに合うこと。外部 URL は見ない
const docFiles = ["README.md", "CLAUDE.md", ...(await markdownFilesUnder("docs"))];
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

if (errors.length > 0) {
  console.error("check:docs の指摘");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `check:docs: 予算内（文書 ${budgets.length} 件、ADR ${adrFiles.length} 件）、リンク ${linkCount} 件に切れなし`,
);

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
