// deguboard ブランチのマージドライバ（SY-4、ADR-002）。チケットと Epic の frontmatter をフィールド単位で 3-way マージする。
// git が rebase の中で `<dg> merge-driver %O %A %B %P` として呼ぶ。登録は ensureMergeDriver（init と sync）が行う

import { isDeepStrictEqual } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { joinFrontmatter, splitFrontmatter } from "../storage/frontmatter.js";
import {
  cloneYamlDocument,
  parseYamlDocument,
  patchYamlDocument,
  stringifyYaml,
  type YamlDocument,
} from "../storage/yaml.js";
import type { GitRepo } from "./repo.js";
import { runGit } from "./run.js";

/** git config の merge.<名前> と .gitattributes の merge=<名前> */
const MERGE_DRIVER_NAME = "deguboard";

/** ドライバを当てるパス。frontmatter を持つ Markdown（チケット・墓標・Epic）だけ */
const ATTRIBUTE_LINES = [
  `tickets/*.md merge=${MERGE_DRIVER_NAME}`,
  `tickets/deleted/*.md merge=${MERGE_DRIVER_NAME}`,
  `epics/*.md merge=${MERGE_DRIVER_NAME}`,
];

const GITATTRIBUTES_HEADER = "# dg のマージドライバ（frontmatter をフィールド単位でマージする）";

/** 両側が違う値に変えても、新しい方を採るフィールド（書き込みのたびに変わる時刻） */
const NEWER_WINS = new Set(["updated_at"]);

export type MergeOutcome = { ok: true; text: string } | { ok: false; conflicts: string[] };

interface Parsed {
  text: string;
  yaml: string;
  body: string;
  doc: YamlDocument;
  data: Record<string, unknown>;
}

function parse(text: string): Parsed | undefined {
  const fm = splitFrontmatter(text);
  if (fm === undefined || fm === "unterminated") return undefined;
  const { doc, errors } = parseYamlDocument(fm.yaml);
  if (errors.length > 0) return undefined;
  const data: unknown = doc.toJS();
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return { text, yaml: fm.yaml, body: fm.body, doc, data: data as Record<string, unknown> };
}

/** ISO 8601 の時刻の新しい方。どちらかが読めなければ undefined */
function newer(a: unknown, b: unknown): unknown {
  if (typeof a !== "string" || typeof b !== "string") return undefined;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
  return tb > ta ? b : a;
}

/** 1 つの値の 3-way。片側だけ変えたらその値、両側が同じ値に変えたらその値。決まらなければ conflict。配列も要素ごとにマージせず 1 つの値として比べる */
function pick(base: unknown, ours: unknown, theirs: unknown): { value: unknown } | "conflict" {
  if (isDeepStrictEqual(ours, theirs)) return { value: ours };
  if (isDeepStrictEqual(base, ours)) return { value: theirs };
  if (isDeepStrictEqual(base, theirs)) return { value: ours };
  return "conflict";
}

/** git merge-file を一時ファイルで呼ぶ。行単位でぶつからなければマージ結果、ぶつかれば undefined */
async function mergeText(base: string, ours: string, theirs: string): Promise<string | undefined> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deguboard-merge-"));
  try {
    const [o, a, b] = ["base", "ours", "theirs"].map((n) => path.join(dir, n)) as [
      string,
      string,
      string,
    ];
    await Promise.all([writeFile(o, base), writeFile(a, ours), writeFile(b, theirs)]);
    const r = await runGit(dir, ["merge-file", "-p", "--quiet", a, o, b], { allowFailure: true });
    return r.code === 0 ? r.stdout : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * frontmatter つき Markdown の 3-way マージ。
 * - フィールドごとに、片側だけ変えた値を採る。両側が違う値に変えたら競合（updated_at だけは新しい方を採る）
 * - 本文は片側だけ変えたらその本文、両側が変えたら行単位でマージし、同じ行がぶつかれば競合
 * - frontmatter が読めない・base にない（add/add）ときは ok: false の代わりに undefined を返し、呼び手が行単位のマージに任せる
 *   （仮番号の add/add を行単位の競合のまま残し、振り直し DT-5 の検出を変えないため）
 */
export async function mergeDocuments(
  base: string,
  ours: string,
  theirs: string,
): Promise<MergeOutcome | undefined> {
  const o = parse(base);
  const a = parse(ours);
  const b = parse(theirs);
  if (!o || !a || !b) return undefined;

  const conflicts: string[] = [];
  const patch: Record<string, unknown> = {};
  const keys = [
    ...new Set([...Object.keys(a.data), ...Object.keys(b.data), ...Object.keys(o.data)]),
  ];
  for (const key of keys) {
    const picked = pick(o.data[key], a.data[key], b.data[key]);
    let value: unknown;
    if (picked !== "conflict") value = picked.value;
    else if (NEWER_WINS.has(key)) {
      value = newer(a.data[key], b.data[key]);
      if (value === undefined) {
        conflicts.push(key);
        continue;
      }
    } else {
      conflicts.push(key);
      continue;
    }
    if (!isDeepStrictEqual(value, a.data[key])) patch[key] = value;
  }

  let body: string | undefined;
  const pickedBody = pick(o.body, a.body, b.body);
  if (pickedBody !== "conflict") body = pickedBody.value as string;
  else body = await mergeText(o.body, a.body, b.body);
  if (body === undefined) conflicts.push("本文");

  if (conflicts.length > 0 || body === undefined) return { ok: false, conflicts };
  if (Object.keys(patch).length === 0) {
    // frontmatter は ours のまま。書式とコメントを 1 バイトも変えない
    return { ok: true, text: a.text.slice(0, a.text.length - a.body.length) + body };
  }
  const doc = cloneYamlDocument(a.doc);
  patchYamlDocument(doc, patch);
  return { ok: true, text: joinFrontmatter(stringifyYaml(doc), body) };
}

/**
 * git のマージドライバの本体。引数は %O %A %B [%P]。結果を %A に書き、解けたら 0、競合なら 1 を返す。
 * 競合のときは %A に git merge-file の競合マーカーを残す（人が deguboard worktree で解くときのため）
 */
export async function runMergeDriver(
  args: readonly string[],
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const [basePath, oursPath, theirsPath, name] = args;
  if (!basePath || !oursPath || !theirsPath) {
    log("dg merge-driver: 引数は <base> <ours> <theirs> [<path>]");
    return 2;
  }
  const [base, ours, theirs] = await Promise.all([
    readFile(basePath, "utf8"),
    readFile(oursPath, "utf8"),
    readFile(theirsPath, "utf8"),
  ]);
  const outcome = await mergeDocuments(base, ours, theirs);
  if (outcome?.ok) {
    await writeFile(oursPath, outcome.text);
    return 0;
  }
  if (outcome) {
    log(
      `dg merge-driver: ${name ?? oursPath}: 両側で違う値に変えた: ${outcome.conflicts.join(", ")}`,
    );
  }
  // frontmatter として読めないものと競合は、git の行単位のマージに任せて競合マーカーを残す
  const r = await runGit(
    process.cwd(),
    ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath],
    { allowFailure: true },
  );
  return outcome === undefined && r.code === 0 ? 0 : 1;
}

/** sh -c で渡す引数のクォート（git はドライバをシェルで動かす） */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** git config に登録するドライバのコマンド行 */
export function mergeDriverCommandLine(command: readonly string[]): string {
  return [...command.map(shellQuote), "%O", "%A", "%B", "%P"].join(" ");
}

/** rebase に -c core.attributesFile で渡す属性ファイル（.gitattributes がまだリモートにないときの補い） */
export function attributesFile(repo: Pick<GitRepo, "localDir">): string {
  return path.join(repo.localDir, "attributes");
}

function attributesText(): string {
  return [GITATTRIBUTES_HEADER, ...ATTRIBUTE_LINES, ""].join("\n");
}

async function readOr(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** deguboard worktree の .gitattributes に足りない行を足す。書き換えたら true（コミットは呼び手） */
export async function ensureGitattributes(dataDir: string): Promise<boolean> {
  const file = path.join(dataDir, ".gitattributes");
  const current = await readOr(file);
  if (current === undefined) {
    await writeFile(file, attributesText());
    return true;
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = ATTRIBUTE_LINES.filter((l) => !lines.includes(l));
  if (missing.length === 0) return false;
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${current}${sep}${missing.join("\n")}\n`);
  return true;
}

/**
 * ドライバを git config（リポジトリの共通の config）に登録し、deguboard-local/ に属性ファイルを置く。
 * command は dg を呼ぶ argv の前置（例：[node のパス, bin/dg.js, "merge-driver"]）。入口が渡さなければ config は触らない。
 * 登録したコマンド行を返す（変える必要がなかったときも返す）
 */
export async function ensureMergeDriver(
  repo: Pick<GitRepo, "dataDir" | "localDir">,
  command: readonly string[] | undefined,
): Promise<string | undefined> {
  const file = attributesFile(repo);
  if ((await readOr(file)) !== attributesText()) await writeFile(file, attributesText());
  if (!command || command.length === 0) return undefined;
  const line = mergeDriverCommandLine(command);
  const key = `merge.${MERGE_DRIVER_NAME}.driver`;
  const current = await runGit(repo.dataDir, ["config", "--local", "--get", key], {
    allowFailure: true,
  });
  if (current.code !== 0 || current.stdout.trim() !== line) {
    await runGit(repo.dataDir, ["config", "--local", key, line]);
    await runGit(repo.dataDir, [
      "config",
      "--local",
      `merge.${MERGE_DRIVER_NAME}.name`,
      "deguboard の frontmatter をフィールド単位でマージする（dg が登録）",
    ]);
  }
  return line;
}
