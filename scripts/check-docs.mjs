// 文書の大きさの予算と ADR 一覧の整合を検査する（docs/adr/ADR-001-doc-strategy.md）。
// 依存なしで動かす。mise run check:docs から呼ぶ。
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

if (errors.length > 0) {
  console.error("check:docs の指摘");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check:docs: 予算内（文書 ${budgets.length} 件、ADR ${adrFiles.length} 件）`);

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
