// 文書とコードの参照を検査する（docs/adr/ADR-001-doc-strategy.md）。大きさの予算は持たない。検査するのは、ADR 一覧の整合と更新日の一致・リンクと見出しアンカーの切れ・拡張と Walkthrough が指す README の見出しアンカー・README.md と README.ja.md の節の構成のずれ・コードとテストの要件 ID・要件の 1 項の上限（250 字）・コードとテストが指す置き換え済みの ADR・コードの先頭コメントの参照・`dg guide <topic>` の「節」と英語の "節" section of `dg guide <topic>` の参照（文書と packages の .ts・.tsx の文字列とコメント）・文書の重複。
// 要件 ID は docs/requirements.md の箇条書き「- XX-N」で定義されたものに限る。接頭辞は定義と「要件の ID の接頭辞：」の一覧から取り、定義にない番号を参照していたら指摘する（一覧にない接頭辞は要件 ID と見なさない）。先頭コメントは最初の // の行で、requirements.md の節番号・ADR・docs のパス（#アンカー）・guide-*.md を照らす。
// 要件の 1 項は「- XX-N」の項目とその下の字下げした行の合計を、記号「- 」と字下げを除いて数える（ID とリンクの記法を含む。節の前文は数えない）。置き換え済みかは各 ADR のステータスの「置き換え（ADR-0xx）」から読み、packages・scripts・test のコードの ADR-0xx の参照すべて（コメント・テスト名・文字列）を照らす。
// 文書の重複は、同じ見出しの節の本文が同じ guide どうし（正本を 1 本にする）、または同じ段落が 2 本以上の文書にあるときに指摘する。段落は 40 字以上で、空行・見出し・表・コードで切り、箇条書きの 1 項目も 1 段落にする。比べるのは guide・docs/requirements.md・docs の下のほかの文書（ADR を除く）・CLAUDE.md・README.md・README.ja.md・packages/*/README.md。ADR は判断の記録で、判断と理由を書き換えないので比べない。README.md と README.ja.md は訳どうしなので、この 2 つだけの組は指摘しない。frontmatter と ``` の中は除く。短い選択肢や定型句は同じ語でよいので対象にしない。指摘には段落の場所（ファイルと行）を出す。
// 調べるファイルは git が追跡しているか無視されていないもの（.gitignore のビルドの成果物は読まない）。git のリポジトリの中で動かす。
// 依存なしで動かす（git だけは execFile で呼ぶ）。mise run check:docs から呼ぶ。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 調べるファイルの一覧（root からの相対パス）。ビルドの成果物などの無視されたファイルは含まない
const tracked = await gitFiles();

// dg guide のトピック（guide-*.md）の置き場所。CLI に同梱する手順の本文
const guideDir = "packages/cli/src";
// 要件 ID と先頭コメントを照らす対象の拡張子（packages・scripts・test の下）
const SOURCE_EXTS = [".ts", ".tsx", ".mjs", ".js", ".cjs"];
// 重複と見なす段落・節の本文の長さ（字）。これより短い選択肢や定型句は対象にしない
const DUP_MIN_CHARS = 40;
// 要件の 1 項の字数の上限（ADR-001 の「要件定義書に書くもの」）
const REQUIREMENT_ITEM_MAX_CHARS = 250;

const errors = [];

const adrDir = path.join(root, "docs", "adr");
const adrFiles = (await readdir(adrDir)).filter((f) => /^ADR-\d{3}-.+\.md$/.test(f)).sort();
const numbers = new Map();
for (const file of adrFiles) {
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

// 置き換え済みの ADR：各 ADR のステータスの「置き換え（ADR-0xx）」から番号と置き換えた先を読む（番号をここに並べない）
const adrTexts = new Map();
const supersededBy = new Map(); // 置き換え済みの番号 → 置き換えた先の番号（書いていなければ undefined）
for (const file of adrFiles) {
  const text = await readFile(path.join(adrDir, file), "utf8");
  adrTexts.set(file, text);
  const status = /^- ステータス：置き換え(?:（ADR-(\d{3})）)?/m.exec(text);
  if (status) supersededBy.set(file.slice(4, 7), status[1]);
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
  if (supersededBy.has(file.slice(4, 7))) continue;
  const text = adrTexts.get(file);
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
for (const rel of filesUnder(["packages/vscode/src", "packages/vscode/media"], [".ts", ".md"])) {
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

// 要件 ID：コードとテストが参照する ID は、requirements.md の箇条書き（「- TK-1 …」）で定義されたものに限る。定義にない番号の参照を指摘する。
// 接頭辞は定義と、requirements.md の「要件の ID の接頭辞：」の一覧から取る。一覧は節を消して定義がなくなっても残るので、その接頭辞の参照も指摘できる。一覧にも定義にもない接頭辞は要件 ID と見なさない（ADR・UTF-8・SHA-256・ISO-8601・UTC・ほかのプロジェクトの ID など）
const requirementsText = await readFile(path.join(root, "docs", "requirements.md"), "utf8");
const requirementIds = new Set(
  [...requirementsText.matchAll(/^- ([A-Z]{2,3})-(\d+)(?![0-9])/gm)].map((m) => `${m[1]}-${m[2]}`),
);
const listed = /^要件の ID の接頭辞：(.*)$/m.exec(requirementsText)?.[1];
if (listed === undefined) {
  errors.push("docs/requirements.md: 「要件の ID の接頭辞：」の一覧の行がない");
}
const listedPrefixes = [...(listed ?? "").matchAll(/`([A-Z]{2,3})`/g)].map((m) => m[1]);
if (listed !== undefined && listedPrefixes.length === 0) {
  errors.push(
    "docs/requirements.md: 「要件の ID の接頭辞：」の一覧に接頭辞がない（バッククォートで囲む）",
  );
}
const definedPrefixes = new Set([...requirementIds].map((id) => id.split("-")[0]));
// 定義にある接頭辞は一覧にもなければ、節を消したあと残る参照を拾えないので指摘する
for (const prefix of definedPrefixes) {
  if (!listedPrefixes.includes(prefix)) {
    errors.push(`docs/requirements.md: 接頭辞 ${prefix} が「要件の ID の接頭辞：」の一覧にない`);
  }
}
// 定義がなくても一覧にある接頭辞は、節を消した後の参照を拾うので残す
const requirementPrefixes = new Set([...definedPrefixes, ...listedPrefixes]);
const sources = filesUnder(["packages", "scripts", "test"], SOURCE_EXTS);
let requirementRefCount = 0;
for (const rel of sources) {
  const lines = (await readFile(path.join(root, rel), "utf8")).split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/(?<![A-Za-z0-9])([A-Z]{2,3})-(\d+)(?![0-9A-Za-z])/g)) {
      if (!requirementPrefixes.has(m[1])) continue;
      requirementRefCount++;
      const id = `${m[1]}-${m[2]}`;
      if (!requirementIds.has(id)) {
        errors.push(`${rel}:${i + 1}: 要件 ID ${id} が docs/requirements.md にない`);
      }
    }
  }
}

// 要件の 1 項の上限（ADR-001 の「要件定義書に書くもの」）：「- XX-N」の箇条書きの 1 項目と、その下の字下げした行の合計の字数。
// 数えるのは箇条書きの記号「- 」と字下げを除いた本文（ID とリンクの記法を含む）で、行は空白 1 つでつなぐ。ID のない行（節の前文・ID のない箇条書き）は数えない
let requirementItemCount = 0;
let item = null;
const checkItem = () => {
  if (item === null) return;
  requirementItemCount++;
  const chars = [...item.text].length;
  if (chars > REQUIREMENT_ITEM_MAX_CHARS) {
    errors.push(
      `docs/requirements.md:${item.line}: 要件 ${item.id} の 1 項が ${chars} 字で、上限の ${REQUIREMENT_ITEM_MAX_CHARS} 字を超えている（細部を正本へ移して縮める）`,
    );
  }
  item = null;
};
for (const [i, line] of linesOutsideFences(requirementsText).entries()) {
  const m = /^- ([A-Z]{2,3}-\d+)(?![0-9])/.exec(line);
  if (m) {
    checkItem();
    item = { id: m[1], line: i + 1, text: line.slice(2).trim() };
  } else if (item !== null && /^\s+\S/.test(line)) {
    item.text += ` ${line.trim()}`;
  } else {
    checkItem();
  }
}
checkItem();

// 置き換え済みの ADR への参照：コードとテスト（コメント・テスト名・文字列）が置き換え済みの ADR を指していたら指摘する。置き換え済みの本文は削ってよく、指した先に判断が残らないため。
// 文書（docs・ADR の本文の置き換えの履歴）は見ない
let adrRefCount = 0;
for (const rel of sources) {
  const lines = (await readFile(path.join(root, rel), "utf8")).split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/\bADR-(\d{3})\b/g)) {
      adrRefCount++;
      if (!supersededBy.has(m[1])) continue;
      const to = supersededBy.get(m[1]);
      errors.push(
        `${rel}:${i + 1}: 置き換え済みの ADR-${m[1]} を指している（${to ? `今の判断は ADR-${to}` : "今の判断の ADR を指す"}）`,
      );
    }
  }
}

// 先頭コメント：最初の // の行が指す requirements.md の節・ADR・docs のパス（#アンカー）・guide のトピックが存在すること
const requirementSections = new Set(
  [...requirementsText.matchAll(/^#{2,3} (\d+(?:\.\d+)*)(?=[.\s])/gm)].map((m) => m[1]),
);
const adrNumbers = new Set(adrFiles.map((f) => f.slice(4, 7)));
let topRefCount = 0;
for (const rel of sources) {
  for (const { line, text } of topComment(await readFile(path.join(root, rel), "utf8"))) {
    const where = `${rel}:${line}`;
    for (const m of text.matchAll(/requirements\.md\s*(\d+(?:\.\d+)*)/g)) {
      topRefCount++;
      if (!requirementSections.has(m[1])) {
        errors.push(`${where}: 先頭コメントが指す docs/requirements.md の節 ${m[1]} がない`);
      }
    }
    for (const m of text.matchAll(/\bADR-(\d{3})\b/g)) {
      topRefCount++;
      if (!adrNumbers.has(m[1])) errors.push(`${where}: 先頭コメントが指す ADR-${m[1]} がない`);
    }
    for (const m of text.matchAll(/docs\/[\w./-]+\.md(?:#[^\s)）、。`]+)?/g)) {
      topRefCount++;
      const [file, anchor] = m[0].split("#");
      if (!existsSync(path.join(root, file))) {
        errors.push(`${where}: 先頭コメントが指す ${file} がない`);
      } else if (
        anchor !== undefined &&
        !(await headingSlugs(file)).has(decodeURIComponent(anchor).toLowerCase())
      ) {
        errors.push(`${where}: 先頭コメントが指す見出しがない: ${m[0]}`);
      }
    }
    for (const m of text.matchAll(/\bguide-([a-z]+)\b/g)) {
      topRefCount++;
      if (!existsSync(path.join(root, guideDir, `guide-${m[1]}.md`))) {
        errors.push(`${where}: 先頭コメントが指す guide-${m[1]}.md がない`);
      }
    }
  }
}

// 文書の重複：節の本文は guide どうしだけ、段落は下の対象すべてを比べる
const guideFiles = (await readdir(path.join(root, guideDir)))
  .filter((f) => /^guide-.+\.md$/.test(f))
  .sort()
  .map((f) => path.join(guideDir, f));
const paragraphDocs = [
  ...guideFiles,
  "docs/requirements.md",
  ...tracked.filter(
    (f) =>
      (f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/adr/")) ||
      f === "CLAUDE.md" ||
      f === "README.md" ||
      f === "README.ja.md" ||
      /^packages\/[^/]+\/README\.md$/.test(f),
  ),
];
const sameSections = new Map();
const sameParagraphs = new Map(); // 段落 → (ファイル → 行)
for (const rel of new Set(paragraphDocs)) {
  const { sections, paragraphs } = guideBlocks(await readFile(path.join(root, rel), "utf8"));
  if (guideFiles.includes(rel)) {
    for (const s of sections) {
      if (s.body.length < DUP_MIN_CHARS) continue;
      const key = `${s.heading}\n${s.body}`;
      const entry = sameSections.get(key) ?? { heading: s.heading, files: new Set() };
      entry.files.add(rel);
      sameSections.set(key, entry);
    }
  }
  for (const { text, line } of paragraphs) {
    if (text.length < DUP_MIN_CHARS) continue;
    const places = sameParagraphs.get(text) ?? new Map();
    if (!places.has(rel)) places.set(rel, line);
    sameParagraphs.set(text, places);
  }
}
for (const { heading, files } of sameSections.values()) {
  if (files.size > 1) {
    errors.push(
      `${[...files].join(", ")}: 見出し「${heading}」の節の本文が同じ（正本を 1 本にする）`,
    );
  }
}
for (const [text, places] of sameParagraphs) {
  // README.md と README.ja.md だけの組は訳どうしなので除く
  const translations = places.size === 2 && places.has("README.md") && places.has("README.ja.md");
  if (places.size < 2 || translations) continue;
  const where = [...places].map(([rel, line]) => `${rel}:${line}`).join(", ");
  errors.push(`${where}: 同じ段落がある（「${text.slice(0, 30)}…」）`);
}

// dg guide の節の参照：日本語の「`dg guide <topic>` の「<節>」」と、英語の「the "<節>" section of `dg guide <topic>`」（"<節>" の後ろの「(…)」の補足を許す）を、文書（.md）と packages の .ts・.tsx の文字列とコメントから集め、guide-<topic>.md の見出し（「（…）」の補足を除いた名前を含む）と、節の中の太字の項目・一覧の先頭のコードと照らす。日本語は「と「…」」で続く節も見る。バッククォートの有無によらない。
// 見る名前は「」と "" の中だけ（後ろの「の `implement` のモデル」などは見ない）。.md のコードブロックの中は除く。.ts の中の \`（テンプレート文字列のエスケープ）も読む
const guideNameSets = new Map();
for (const rel of guideFiles) {
  const topic = path.basename(rel).slice("guide-".length, -".md".length);
  guideNameSets.set(topic, guideSectionNames(await readFile(path.join(root, rel), "utf8")));
}
/** 1 行にある dg guide の節の参照を、トピックと節の名前の配列で返す */
function guideRefsIn(line) {
  const refs = [];
  for (const m of line.matchAll(
    /(?:\\?`)?dg guide ([a-z][a-z-]*)(?:\\?`)?\s*の(「[^」]+」(?:と「[^」]+」)*)/g,
  )) {
    refs.push({ topic: m[1], names: [...m[2].matchAll(/「([^」]+)」/g)].map((n) => n[1]) });
  }
  for (const m of line.matchAll(
    /"([^"]+)"(?: \([^)]*\))? section of (?:\\?`)?dg guide ([a-z][a-z-]*)(?:\\?`)?/g,
  )) {
    refs.push({ topic: m[2], names: [m[1]] });
  }
  return refs;
}
let guideRefCount = 0;
const guideRefFiles = [
  ...tracked.filter((f) => f.endsWith(".md")),
  ...filesUnder(["packages"], [".ts", ".tsx"]),
];
for (const rel of guideRefFiles) {
  const text = await readFile(path.join(root, rel), "utf8");
  const lines = rel.endsWith(".md") ? linesOutsideFences(text) : text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const { topic, names: refNames } of guideRefsIn(line)) {
      const names = guideNameSets.get(topic);
      for (const name of refNames) {
        guideRefCount++;
        if (names === undefined) {
          errors.push(
            `${rel}:${i + 1}: dg guide ${topic} の guide-${topic}.md がない（「${name}」を指す）`,
          );
        } else if (!names.has(name)) {
          errors.push(`${rel}:${i + 1}: dg guide ${topic} に節「${name}」がない`);
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
  `check:docs: ADR ${adrFiles.length} 件（更新日の一致 ${datedCount} 件）、文書 ${new Set(paragraphDocs).size} 件（guide ${guideFiles.length} 件を含む）に重複なし、リンク ${linkCount} 件に切れなし、README.ja.md の見出し ${readmeJaHeadings.length} 個が README.md と同じ構成、拡張と Walkthrough の README の見出しアンカー ${readmeAnchorCount} 件に切れなし、要件 ID ${requirementRefCount} 件が定義どおり、要件 ${requirementItemCount} 項が ${REQUIREMENT_ITEM_MAX_CHARS} 字以内、コードとテストの ADR の参照 ${adrRefCount} 件に置き換え済みなし、先頭コメントの参照 ${topRefCount} 件に切れなし、dg guide の節の参照 ${guideRefCount} 件に切れなし`,
);

/** ファイルの先頭の // の行（shebang を除く）。最初の // 以外の行で止める */
function topComment(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (i === 0 && line.startsWith("#!")) continue;
    if (!line.startsWith("//")) break;
    out.push({ line: i + 1, text: line });
  }
  return out;
}

/** 文書の本文を節と段落に分ける。frontmatter と ``` の中は除く。段落は空行・見出し・表・コードで切り、箇条書きの 1 項目ごとに切る。段落は最初の行の行番号をつける */
function guideBlocks(text) {
  const lines = text.split("\n");
  const start = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  const sections = [];
  const paragraphs = [];
  let section = null;
  let para = [];
  let paraLine = 0;
  let inFence = false;
  const endPara = () => {
    if (para.length > 0) paragraphs.push({ text: normalize(para.join(" ")), line: paraLine });
    para = [];
  };
  for (const [i, line] of lines.entries()) {
    if (i < start) continue;
    if (/^\s*(```|~~~)/.test(line)) {
      endPara();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      endPara();
      if (section) sections.push(section);
      section = h[1].length >= 2 ? { heading: h[2], lines: [] } : null;
      continue;
    }
    if (section) section.lines.push(line);
    if (line.trim() === "" || /^\s*\|/.test(line)) {
      endPara();
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) endPara();
    if (para.length === 0) paraLine = i + 1;
    para.push(line.trim());
  }
  endPara();
  if (section) sections.push(section);
  return {
    sections: sections.map((s) => ({ heading: s.heading, body: normalize(s.lines.join(" ")) })),
    paragraphs,
  };
}

/** 空白をつめて比べる形にする */
function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function markdownFilesUnder(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .sort();
}

/** git が追跡しているか無視されていないファイルのうち、いま存在するものを root からの相対パスで返す */
async function gitFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter((f) => f !== "" && existsSync(path.join(root, f)))
    .sort();
}

/** tracked のうち、dirs の下にあって拡張子が exts のものを返す */
function filesUnder(dirs, exts) {
  return tracked.filter(
    (f) => dirs.some((d) => f.startsWith(`${d}/`)) && exts.some((x) => f.endsWith(x)),
  );
}

/** 行ごとの配列にし、```のコードブロックの中とインラインコードは空にする（行番号は保つ） */
function withoutCode(text) {
  return linesOutsideFences(text).map((line) => line.replace(/`[^`]*`/g, ""));
}

/** 行ごとの配列にし、```・~~~ のコードブロックの中は空にする（行番号は保つ。インラインコードは残す） */
function linesOutsideFences(text) {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

/** guide の節の名前の集合：見出しの文言と、その「（…）」の補足を除いた名前、節の中の太字の項目（- **見る**）と一覧の先頭のコード（- `ready`） */
function guideSectionNames(text) {
  const names = new Set();
  for (const line of linesOutsideFences(text)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      names.add(heading);
      names.add(heading.replace(/（[^（）]*）$/, ""));
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(?:\*\*([^*]+)\*\*|`([^`]+)`)/.exec(line);
    if (item) names.add(item[1] ?? item[2]);
  }
  return names;
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
