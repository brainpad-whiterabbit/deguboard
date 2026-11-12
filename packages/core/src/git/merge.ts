// deguboard ブランチのマージドライバ（SY-4、ADR-034）。チケットと Epic の frontmatter と、Plan・Iteration・Project の YAML をフィールド単位で 3-way マージする。
// git が rebase の中で `<dg> merge-driver %O %A %B %P` として呼ぶ。登録は ensureMergeDriver（init と sync）が行う

import { isDeepStrictEqual } from "node:util";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * ドライバを当てるパス。frontmatter を持つ Markdown（チケット・墓標・Epic）と、素の YAML（Plan・Iteration・Project）。
 * config.yaml と workflows は人が手で書く設定なので外し、行単位のマージのままにする
 */
const ATTRIBUTE_LINES = [
  `tickets/*.md merge=${MERGE_DRIVER_NAME}`,
  `tickets/deleted/*.md merge=${MERGE_DRIVER_NAME}`,
  `epics/*.md merge=${MERGE_DRIVER_NAME}`,
  `plans/*.yaml merge=${MERGE_DRIVER_NAME}`,
  `iterations/*.yaml merge=${MERGE_DRIVER_NAME}`,
  `projects/*.yaml merge=${MERGE_DRIVER_NAME}`,
];

/** ATTRIBUTE_LINES のパターン（`*` は / を含まない）に当たるか。マージドライバと同じ判定を git の外で回すファイルを選ぶ */
const DRIVER_PATHS = ATTRIBUTE_LINES.map((line) => {
  const pattern = line.split(" ")[0]!;
  const re = pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]+");
  return new RegExp(`^${re}$`);
});

export function isMergeDriverPath(file: string): boolean {
  return DRIVER_PATHS.some((re) => re.test(file));
}

const GITATTRIBUTES_HEADER =
  "# dg のマージドライバ（frontmatter と YAML をフィールド単位でマージする）";

/** 両側が違う値に変えても、新しい方を採るフィールド（書き込みのたびに変わる時刻） */
const NEWER_WINS = new Set(["updated_at"]);

/**
 * 同じ status のまま両側で違っていてよい、状態と一緒に書く時刻（閉じた・始めた・承認した時刻）。
 * 両側が同じ状態に着いたのなら、どちらの時刻も同じ遷移の記録なので、早い方（最初に着いた側）を採る。
 * どちらを採っても状態は変わらず、人が選ぶほどの違いがないので競合にしない。status が違う、またはほかのフィールドや本文もぶつかるときは、
 * 状態の判断に関わるので競合のまま返す（earlierTimes）
 */
const SAME_STATUS_TIMES = new Set(["closed_at", "started_at", "approved_at"]);

/**
 * 競合したフィールドで採る側（dg sync --resolve）。git の %A（ours）か %B（theirs）で言う。
 * rebase の中では ours が upstream（リモート）、theirs が積み直すローカルのコミットなので、remote → ours・local → theirs に読み替えるのは呼び手（sync.ts）
 */
export type MergeSide = "ours" | "theirs";

/** ドライバに採る側を渡す環境変数（git がドライバを子プロセスで動かすので、rebase に渡した環境が届く） */
export const MERGE_PREFER_ENV = "DEGUBOARD_MERGE_PREFER";
/** 採る側で解いたフィールドを 1 行 1 件の JSON で書き足すファイル（呼び手が読んで結果に返す） */
export const MERGE_LOG_ENV = "DEGUBOARD_MERGE_LOG";

/**
 * 採る側で解いた 1 件。本文は field が "本文" で、値は両側の本文全体。
 * auto は人が選ばずに解いたもの（同じ status の時刻の早い方。SAME_STATUS_TIMES）
 */
export interface ResolvedField {
  field: string;
  taken: unknown;
  discarded: unknown;
  auto?: true;
}

/**
 * 解けなかった 1 件（dg sync の data.conflict_fields の元）。値は git の側で言う（ours が %A、theirs が %B）。
 * 本文は field が "本文" で、ぶつかった行の塊ごとに 1 件、値はその塊の行（base は分岐点の行）
 */
export interface ConflictedField {
  field: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export type MergeOutcome =
  | { ok: true; text: string; resolved: ResolvedField[] }
  | { ok: false; conflicts: string[]; details: ConflictedField[] };

interface Parsed {
  text: string;
  /** frontmatter つき Markdown なら本文。素の YAML（Plan・Iteration・Project）なら undefined */
  body: string | undefined;
  doc: YamlDocument;
  data: Record<string, unknown>;
}

/** frontmatter つき Markdown か、全体が 1 つのマッピングの素の YAML を読む。どちらでもなければ undefined */
function parse(text: string): Parsed | undefined {
  const fm = splitFrontmatter(text);
  if (fm === "unterminated") return undefined;
  const { doc, errors } = parseYamlDocument(fm === undefined ? text : fm.yaml);
  if (errors.length > 0) return undefined;
  // 空のファイル（add/add の base）とスカラーは null や文字列になり、ここで外れる
  const data: unknown = doc.toJS();
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return { text, body: fm?.body, doc, data: data as Record<string, unknown> };
}

/** ISO 8601 の時刻の新しい方。どちらかが読めなければ undefined */
function newer(a: unknown, b: unknown): unknown {
  if (typeof a !== "string" || typeof b !== "string") return undefined;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
  return tb > ta ? b : a;
}

/**
 * SAME_STATUS_TIMES の規則で解く。両側の status が同じで、ぶつかったフィールドがすべて時刻（両側とも読める ISO 8601）のときだけ、
 * 早い方を採った 1 件ずつを返す。どれか外れれば undefined（競合のまま）
 */
function earlierTimes(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  clashes: readonly string[],
): ResolvedField[] | undefined {
  if (ours.status === undefined || !isDeepStrictEqual(ours.status, theirs.status)) return undefined;
  const fixes: ResolvedField[] = [];
  for (const key of clashes) {
    if (!SAME_STATUS_TIMES.has(key)) return undefined;
    const a = ours[key];
    const b = theirs[key];
    if (typeof a !== "string" || typeof b !== "string") return undefined;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
    const [taken, discarded] = ta <= tb ? [a, b] : [b, a];
    fixes.push({ field: key, taken, discarded, auto: true });
  }
  return fixes;
}

/** 1 つの値の 3-way。片側だけ変えたらその値、両側が同じ値に変えたらその値。決まらなければ conflict。配列も要素ごとにマージせず 1 つの値として比べる */
function pick(base: unknown, ours: unknown, theirs: unknown): { value: unknown } | "conflict" {
  if (isDeepStrictEqual(ours, theirs)) return { value: ours };
  if (isDeepStrictEqual(base, ours)) return { value: theirs };
  if (isDeepStrictEqual(base, theirs)) return { value: ours };
  return "conflict";
}

/**
 * git merge-file を一時ファイルで呼ぶ。行単位でぶつからなければマージ結果、ぶつかれば undefined。
 * prefer を渡すと、ぶつかった行だけその側を採る（--ours / --theirs）
 */
async function mergeText(
  base: string,
  ours: string,
  theirs: string,
  prefer?: MergeSide,
): Promise<string | undefined> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deguboard-merge-"));
  try {
    const [o, a, b] = ["base", "ours", "theirs"].map((n) => path.join(dir, n)) as [
      string,
      string,
      string,
    ];
    await Promise.all([writeFile(o, base), writeFile(a, ours), writeFile(b, theirs)]);
    const side = prefer ? [`--${prefer}`] : [];
    const r = await runGit(dir, ["merge-file", "-p", "--quiet", ...side, a, o, b], {
      allowFailure: true,
    });
    return r.code === 0 ? r.stdout : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 競合マーカーの印。git merge-file の既定の長さ（7）で、ラベルを付けない */
const MARKER = { ours: "<<<<<<<", base: "|||||||", split: "=======", theirs: ">>>>>>>" };

/**
 * 行単位でぶつかった塊を、diff3 の競合マーカーから取り出す（ぶつからなかった行は返さない）。
 * 本文の行が偶然マーカーと同じ形で始まると読み違えるが、値を人に見せるだけで、解き方（--resolve）には使わない
 */
async function conflictHunks(
  base: string,
  ours: string,
  theirs: string,
): Promise<Array<{ base: string; ours: string; theirs: string }>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deguboard-merge-"));
  try {
    const [o, a, b] = ["base", "ours", "theirs"].map((n) => path.join(dir, n)) as [
      string,
      string,
      string,
    ];
    await Promise.all([writeFile(o, base), writeFile(a, ours), writeFile(b, theirs)]);
    const r = await runGit(dir, ["merge-file", "-p", "--quiet", "--diff3", a, o, b], {
      allowFailure: true,
    });
    const hunks: Array<{ base: string; ours: string; theirs: string }> = [];
    let part: "ours" | "base" | "theirs" | undefined;
    let hunk = { ours: [] as string[], base: [] as string[], theirs: [] as string[] };
    for (const line of r.stdout.split("\n")) {
      if (part === undefined) {
        if (line.startsWith(MARKER.ours)) {
          part = "ours";
          hunk = { ours: [], base: [], theirs: [] };
        }
      } else if (part === "ours" && line.startsWith(MARKER.base)) part = "base";
      else if (part !== "theirs" && line.startsWith(MARKER.split)) part = "theirs";
      else if (part === "theirs" && line.startsWith(MARKER.theirs)) {
        hunks.push({
          base: hunk.base.join("\n"),
          ours: hunk.ours.join("\n"),
          theirs: hunk.theirs.join("\n"),
        });
        part = undefined;
      } else hunk[part].push(line);
    }
    return hunks;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * frontmatter つき Markdown と素の YAML（最上位がマッピング）の 3-way マージ。
 * - フィールド（最上位のキー）ごとに、片側だけ変えた値を採る。両側が違う値に変えたら競合（updated_at だけは新しい方を採る）
 * - 本文は片側だけ変えたらその本文、両側が変えたら行単位でマージし、同じ行がぶつかれば競合
 * - 両側の status が同じで、ぶつかったのが状態と一緒に書く時刻（SAME_STATUS_TIMES）だけなら、早い方を採り auto: true で resolved に返す（競合にしない）
 * - 読めない・base にない（add/add）・3 つの形（frontmatter の有無）が揃わないときは ok: false の代わりに undefined を返し、
 *   呼び手が行単位のマージに任せる（仮番号の add/add を行単位の競合のまま残し、振り直し DT-5 の検出を変えないため）
 * - prefer を渡すと（dg sync --resolve）、競合したフィールドだけその側の値を採り、本文は同じ行がぶつかった箇所だけその側を採る。
 *   採った値と捨てた値を resolved に返す。競合していないフィールドと行は prefer なしと同じに解く。add/add などの undefined は変えない
 */
export async function mergeDocuments(
  base: string,
  ours: string,
  theirs: string,
  prefer?: MergeSide,
): Promise<MergeOutcome | undefined> {
  const o = parse(base);
  const a = parse(ours);
  const b = parse(theirs);
  if (!o || !a || !b) return undefined;
  const plain = a.body === undefined;
  if ((o.body === undefined) !== plain || (b.body === undefined) !== plain) return undefined;

  const resolved: ResolvedField[] = [];
  /** 競合を prefer の側で解く。prefer がなければ undefined */
  const settle = (field: string, ourValue: unknown, theirValue: unknown) => {
    if (!prefer) return undefined;
    const [taken, discarded] = prefer === "ours" ? [ourValue, theirValue] : [theirValue, ourValue];
    resolved.push({ field, taken, discarded });
    return { value: taken };
  };
  const patch: Record<string, unknown> = {};
  /** prefer なしで競合したフィールド（時刻の規則で解けるかを後で見る） */
  const clashes: string[] = [];
  const keys = [
    ...new Set([...Object.keys(a.data), ...Object.keys(b.data), ...Object.keys(o.data)]),
  ];
  for (const key of keys) {
    let picked = pick(o.data[key], a.data[key], b.data[key]);
    if (picked === "conflict" && NEWER_WINS.has(key)) {
      const value = newer(a.data[key], b.data[key]);
      if (value !== undefined) picked = { value };
    }
    if (picked === "conflict") {
      const settled = settle(key, a.data[key], b.data[key]);
      if (!settled) {
        clashes.push(key);
        continue;
      }
      picked = settled;
    }
    // 採った値が undefined（その側が消した）なら、patchYamlDocument がキーを消す
    if (!isDeepStrictEqual(picked.value, a.data[key])) patch[key] = picked.value;
  }

  let body = "";
  let bodyHunks: Array<{ base: string; ours: string; theirs: string }> | undefined;
  if (!plain) {
    const pickedBody = pick(o.body, a.body, b.body);
    let merged =
      pickedBody !== "conflict"
        ? (pickedBody.value as string)
        : await mergeText(o.body ?? "", a.body ?? "", b.body ?? "");
    if (merged === undefined && prefer) {
      merged = await mergeText(o.body ?? "", a.body ?? "", b.body ?? "", prefer);
      if (merged !== undefined) settle("本文", a.body, b.body);
    }
    if (merged === undefined)
      bodyHunks = await conflictHunks(o.body ?? "", a.body ?? "", b.body ?? "");
    else body = merged;
  }

  // 同じ status の分岐で、ずれたのが状態と一緒に書く時刻だけなら早い方を採る（SAME_STATUS_TIMES）。
  // prefer があれば人が選んだ側で解くので使わない。本文やほかのフィールドがぶつかれば、全体を競合のまま返す
  if (!prefer && bodyHunks === undefined && clashes.length > 0) {
    const fixes = earlierTimes(a.data, b.data, clashes);
    if (fixes) {
      for (const f of fixes) {
        resolved.push(f);
        if (!isDeepStrictEqual(f.taken, a.data[f.field])) patch[f.field] = f.taken;
      }
      clashes.length = 0;
    }
  }

  const conflicts = [...clashes, ...(bodyHunks === undefined ? [] : ["本文"])];
  const details: ConflictedField[] = [
    ...clashes.map((key) => ({
      field: key,
      base: o.data[key],
      ours: a.data[key],
      theirs: b.data[key],
    })),
    ...(bodyHunks ?? []).map((h) => ({ field: "本文", ...h })),
  ];
  if (conflicts.length > 0) return { ok: false, conflicts, details };
  if (Object.keys(patch).length === 0) {
    // YAML は ours のまま。書式とコメントを 1 バイトも変えない
    return {
      ok: true,
      text: a.text.slice(0, a.text.length - (a.body?.length ?? 0)) + body,
      resolved,
    };
  }
  const doc = cloneYamlDocument(a.doc);
  patchYamlDocument(doc, patch);
  const yaml = stringifyYaml(doc);
  return { ok: true, text: plain ? yaml : joinFrontmatter(yaml, body), resolved };
}

/**
 * git のマージドライバの本体。引数は %O %A %B [%P]。結果を %A に書き、解けたら 0、競合なら 1 を返す。
 * 競合のときは %A に git merge-file の競合マーカーを残す（人が deguboard worktree で解くときのため）。
 * 環境変数 MERGE_PREFER_ENV（ours / theirs）があれば競合したフィールドをその側で解き、MERGE_LOG_ENV のファイルに 1 件 1 行で書き足す
 */
export async function runMergeDriver(
  args: readonly string[],
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [basePath, oursPath, theirsPath, name] = args;
  if (!basePath || !oursPath || !theirsPath) {
    log("dg merge-driver: arguments are <base> <ours> <theirs> [<path>]");
    return 2;
  }
  const [base, ours, theirs] = await Promise.all([
    readFile(basePath, "utf8"),
    readFile(oursPath, "utf8"),
    readFile(theirsPath, "utf8"),
  ]);
  const preferEnv = env[MERGE_PREFER_ENV];
  const prefer = preferEnv === "ours" || preferEnv === "theirs" ? preferEnv : undefined;
  const outcome = await mergeDocuments(base, ours, theirs, prefer);
  if (outcome?.ok) {
    await writeFile(oursPath, outcome.text);
    const logFile = env[MERGE_LOG_ENV];
    if (logFile && outcome.resolved.length > 0) {
      const file = name ?? oursPath;
      await appendFile(
        logFile,
        outcome.resolved.map((r) => `${JSON.stringify({ file, ...r })}\n`).join(""),
      );
    }
    return 0;
  }
  if (outcome) {
    log(
      `dg merge-driver: ${name ?? oursPath}: both sides changed to different values: ${outcome.conflicts.join(", ")}`,
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
      "deguboard の frontmatter と YAML をフィールド単位でマージする（dg が登録）",
    ]);
  }
  return line;
}

/**
 * シェルの語に分ける（mergeDriverCommandLine が書く形：素の語と '…'、'\'' のつなぎ）。
 * 二重引用符・バックスラッシュ・$ などほかの書き方があれば読めないとして undefined（人が手で書いた行は判定しない）
 */
function splitShellWords(line: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === " " || c === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (/["\\$`]/.test(c)) {
      return undefined;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * 登録されたマージドライバが動かない理由（dg sync が警告に出す。SY-4）。動きそうなら undefined。
 * 登録がない、または登録されたコマンド行の絶対パス（node・dg.js・起動ファイル）が見つからないと、git は行単位のマージに落ち、
 * 同じチケットの近いフィールドを両側で変えただけで同期が止まる。拡張だけで使うと登録されず（t759）、node を上げると
 * 前に登録したパスが消える。exists はテスト用
 */
export async function mergeDriverProblem(
  repo: Pick<GitRepo, "dataDir">,
  exists: (file: string) => Promise<boolean> = pathExists,
): Promise<string | undefined> {
  const key = `merge.${MERGE_DRIVER_NAME}.driver`;
  const current = await runGit(repo.dataDir, ["config", "--get", key], { allowFailure: true });
  const line = current.code === 0 ? current.stdout.trim() : "";
  if (line === "") {
    return `The merge driver is not registered in git config (${key}), so git merges deguboard files line by line, and changing nearby fields of the same ticket on both sides stops the sync. Run dg sync from the dg CLI or the deguboard VS Code extension to register it`;
  }
  const words = splitShellWords(line);
  if (!words) return undefined;
  for (const word of words) {
    if (word.startsWith("%")) break;
    if (!path.isAbsolute(word)) continue;
    if (!(await exists(word))) {
      return `The merge driver registered in git config (${key}) runs ${word}, which does not exist, so git merges deguboard files line by line, and changing nearby fields of the same ticket on both sides stops the sync. Run dg sync from the dg CLI or the deguboard VS Code extension to register it again`;
    }
  }
  return undefined;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
