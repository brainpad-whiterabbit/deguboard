// deguboard ブランチの git の履歴から、チケット・Epic・Iteration の属性の変化を読む（requirements.md 6.1 の history）。
// `git log -p -U0` を 1 回だけ走らせ（チケット 1 枚のときはそのファイルに絞って）、frontmatter（Iteration は YAML 全体）の行の差分から変化を拾う。データの形は変えない。
// 1 つのコミットで複数のファイルが変わっていても（変更をまとめてコミット）、ファイルごとの差分から読むので取りこぼさない。
// 画面のように何度も読む入口は、HEAD が同じあいだ解析結果を使い回す（createHistoryCache）

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./run.js";

/** 経過として拾う属性 */
const HISTORY_FIELDS = ["status", "iteration", "epic", "assignee", "pr"] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export type HistoryKind = "ticket" | "epic" | "iteration";

export interface HistoryChange {
  field: HistoryField;
  /** 変わる前の値。なかったら null */
  from: string | null;
  /** 変わった後の値。外したら null */
  to: string | null;
}

export interface HistoryEvent {
  kind: HistoryKind;
  id: string;
  /** created：ファイルができた（起票）。changed：属性が変わった。deleted：ファイルが消えた */
  type: "created" | "changed" | "deleted";
  /** コミットの時刻（ISO 8601） */
  at: string;
  commit: string;
  /** コミットの作者（git の user.name） */
  author: string;
  /** コミットの 1 行目（`t12 を claim: eiki/agent`、`照合で t12: …` など。変えた主体と理由が読める） */
  subject: string;
  /** created では最初の値（from は null）。deleted では空 */
  changes: HistoryChange[];
}

export interface HistoryLog {
  /** 古い順 */
  events: HistoryEvent[];
  /** 浅い clone で、履歴の始まりが欠けている */
  shallow: boolean;
  /** 起票のコミットが履歴にない（浅い clone で欠けた）もの */
  incomplete: string[];
}

const DIRS: Record<string, HistoryKind> = {
  tickets: "ticket",
  epics: "epic",
  iterations: "iteration",
};
const COMMIT_MARK = "\x1e";
const FIELD_SEP = "\x1f";

/** ファイルのパス（tickets/t12.md）から種別と ID。対象でなければ undefined */
function subjectOf(file: string): { kind: HistoryKind; id: string; yaml: boolean } | undefined {
  const m = /^(tickets|epics|iterations)\/([^/]+)\.(md|ya?ml)$/.exec(file);
  if (!m) return undefined;
  return { kind: DIRS[m[1]!]!, id: m[2]!, yaml: m[3] !== "md" };
}

/** `key: value` の行から追う属性を読む。値の引用符は外す */
function fieldOf(line: string): { field: HistoryField; value: string | null } | undefined {
  const m = /^([a-z_]+):\s*(.*)$/.exec(line);
  if (!m || !(HISTORY_FIELDS as readonly string[]).includes(m[1]!)) return undefined;
  let value = m[2]!.trim();
  if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
  return { field: m[1] as HistoryField, value: value === "" || value === "null" ? null : value };
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  removed: string[];
  added: string[];
}

interface FileDiff {
  path: string;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

interface CommitDiff {
  commit: string;
  at: string;
  author: string;
  subject: string;
  files: FileDiff[];
}

/** `git log -p -U0` の出力をコミットとファイルの差分に分ける */
export function parseLog(output: string): CommitDiff[] {
  const commits: CommitDiff[] = [];
  for (const chunk of output.split(COMMIT_MARK)) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf("\n");
    const header = newline < 0 ? chunk : chunk.slice(0, newline);
    const [commit = "", at = "", author = "", subject = ""] = header.split(FIELD_SEP);
    const files: FileDiff[] = [];
    let file: FileDiff | undefined;
    let hunk: Hunk | undefined;
    for (const line of newline < 0 ? [] : chunk.slice(newline + 1).split("\n")) {
      if (line.startsWith("diff --git ")) {
        const m = / b\/(.+)$/.exec(line);
        file = { path: m?.[1] ?? "", created: false, deleted: false, hunks: [] };
        hunk = undefined;
        files.push(file);
      } else if (!file) {
        continue;
      } else if (line.startsWith("new file mode")) {
        file.created = true;
      } else if (line.startsWith("deleted file mode")) {
        file.deleted = true;
      } else if (line.startsWith("@@ ")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!m) continue;
        hunk = {
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          removed: [],
          added: [],
        };
        file.hunks.push(hunk);
      } else if (hunk && line.startsWith("-") && !line.startsWith("--- ")) {
        hunk.removed.push(line.slice(1));
      } else if (hunk && line.startsWith("+") && !line.startsWith("+++ ")) {
        hunk.added.push(line.slice(1));
      }
    }
    commits.push({ commit, at, author, subject, files });
  }
  return commits;
}

/** ファイルごとに覚えておくもの：frontmatter の閉じ（`---`）の行番号と、今の属性の値 */
interface FileState {
  /** frontmatter を閉じる行の番号（1 始まり）。YAML は全体が属性なので Infinity。分からなければ undefined */
  end: number | undefined;
  values: Partial<Record<HistoryField, string | null>>;
}

/** 新しくできたファイルの中身から frontmatter の閉じの行番号を求める */
function frontmatterEnd(lines: readonly string[]): number | undefined {
  if (lines[0] !== "---") return undefined;
  const i = lines.indexOf("---", 1);
  return i < 0 ? undefined : i + 1;
}

/**
 * コミットの差分から経過を組み立てる。commits は古い順。
 * boundary は浅い clone の境界のコミット（親が欠けて根に見える）。そこでの「新しいファイル」は起票ではないので、
 * 値を起点として覚えるだけにし、経過が欠けたものとする
 */
export function buildHistory(
  commits: readonly CommitDiff[],
  boundary: ReadonlySet<string> = new Set(),
): HistoryLog {
  const events: HistoryEvent[] = [];
  const states = new Map<string, FileState>();
  const incomplete = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      const subject = subjectOf(f.path);
      if (!subject) continue;
      const base = {
        kind: subject.kind,
        id: subject.id,
        at: c.at,
        commit: c.commit,
        author: c.author,
        subject: c.subject,
      };
      if (f.deleted) {
        states.delete(f.path);
        events.push({ ...base, type: "deleted", changes: [] });
        continue;
      }
      if (f.created) {
        const lines = f.hunks.flatMap((h) => h.added);
        const end = subject.yaml ? Infinity : frontmatterEnd(lines);
        const values: FileState["values"] = {};
        const changes: HistoryChange[] = [];
        for (const line of lines.slice(0, end === undefined ? 0 : end - 1)) {
          const kv = fieldOf(line);
          if (!kv || kv.value === null) continue;
          values[kv.field] = kv.value;
          changes.push({ field: kv.field, from: null, to: kv.value });
        }
        states.set(f.path, { end, values });
        if (boundary.has(c.commit)) incomplete.add(subject.id);
        else events.push({ ...base, type: "created", changes });
        continue;
      }
      let state = states.get(f.path);
      if (!state) {
        // 起票のコミットが履歴にない（浅い clone）。frontmatter の範囲は分からないので、属性の形の行だけを読む
        incomplete.add(subject.id);
        state = { end: subject.yaml ? Infinity : undefined, values: {} };
        states.set(f.path, state);
      }
      const removed = new Map<HistoryField, string | null>();
      const added = new Map<HistoryField, string | null>();
      let delta = 0;
      for (const h of f.hunks) {
        // -U0 の hunk は連続した変更。始まりが閉じの行より前なら frontmatter の中
        const inFrontmatter = state.end === undefined || h.oldStart < state.end;
        if (!inFrontmatter) continue;
        delta += h.newCount - h.oldCount;
        for (const line of h.removed) {
          const kv = fieldOf(line);
          if (kv) removed.set(kv.field, kv.value);
        }
        for (const line of h.added) {
          const kv = fieldOf(line);
          if (kv) added.set(kv.field, kv.value);
        }
      }
      if (state.end !== undefined && state.end !== Infinity) state.end += delta;
      const changes: HistoryChange[] = [];
      for (const field of HISTORY_FIELDS) {
        if (!removed.has(field) && !added.has(field)) continue;
        const from = removed.has(field) ? removed.get(field)! : (state.values[field] ?? null);
        const to = added.has(field) ? added.get(field)! : null;
        state.values[field] = to;
        if (from !== to) changes.push({ field, from, to });
      }
      if (changes.length > 0) events.push({ ...base, type: "changed", changes });
    }
  }
  return { events, shallow: boundary.size > 0, incomplete: [...incomplete].sort() };
}

export interface ReadHistoryOptions {
  /** このチケットのファイル（tickets/<id>.md・.yaml・.yml）の履歴だけを読む。消えたチケットでも引ける */
  ticket?: string | undefined;
}

/**
 * deguboard の worktree（dataDir）の HEAD の履歴を読む。ticket があれば、そのチケットのファイルを含むコミットだけを読む
 * （全体の log -p は履歴が長いと秒単位になるので）。線形の履歴では、全体を読んでから絞った経過と同じになる
 */
export async function readHistory(
  dataDir: string,
  opts: ReadHistoryOptions = {},
): Promise<HistoryLog> {
  return readLog(dataDir, opts, await shallowCommits(dataDir));
}

/** 経過の読み手。readHistory か、createHistoryCache の使い回す読み手 */
export type HistoryReader = (dataDir: string, opts?: ReadHistoryOptions) => Promise<HistoryLog>;

/** 同じ HEAD のあいだに覚えておく、チケット 1 枚の読みの数の上限（全体の読みは別に 1 つ） */
const CACHED_TICKETS = 64;

/**
 * HEAD が同じあいだは解析結果を使い回す readHistory（プロセス内の CommandClient が持つ。commands/local.ts）。
 * 鍵は HEAD のコミット・浅い clone の境界・読み方（全体かチケット 1 枚か）。全体の読み（既定の簡約）と
 * チケット 1 枚の読み（--full-history）は結果が違いうるので混ぜない。HEAD か境界が変われば覚えたものを捨てて読み直す。
 * 経過は git のコミットだけから読むので、コミットされていない書き込みでは変わらない。返す HistoryLog は共有なので、呼び手は書き換えない
 */
export function createHistoryCache(): HistoryReader {
  let key: string | undefined;
  const logs = new Map<string, HistoryLog>();
  return async (dataDir, opts = {}) => {
    // HEAD と浅い clone の境界のファイルの場所を 1 回の rev-parse で引く
    const out = (
      await runGit(dataDir, ["rev-parse", "HEAD", "--git-path", "shallow"])
    ).stdout.split("\n");
    const boundary = await shallowCommits(dataDir, out[1]!.trim());
    const current = [dataDir, out[0]!.trim(), ...[...boundary].sort()].join("\n");
    if (current !== key) {
      key = current;
      logs.clear();
    }
    const mode = opts.ticket ? `ticket:${opts.ticket}` : "all";
    const hit = logs.get(mode);
    if (hit) return hit;
    const log = await readLog(dataDir, opts, boundary);
    if (opts.ticket && logs.size > CACHED_TICKETS) {
      // 古く覚えたチケットから捨てる（全体の読みは残す）
      const oldest = [...logs.keys()].find((k) => k !== "all");
      if (oldest) logs.delete(oldest);
    }
    logs.set(mode, log);
    return log;
  };
}

async function readLog(
  dataDir: string,
  opts: ReadHistoryOptions,
  boundary: ReadonlySet<string>,
): Promise<HistoryLog> {
  const paths = opts.ticket
    ? ticketPaths(opts.ticket).map((p) => `:(literal)${p}`)
    : ["tickets", "epics", "iterations"];
  // --full-history は、チケット 1 枚の読みだけに付ける。merge の片側だけに入った変化を既定の簡約で落とさず、そのチケットの経過に残す。
  // 全体の読み（--epic・--iteration の経過を含む）は従来の簡約のままにして、その結果を変えない
  const fullHistory = opts.ticket ? ["--full-history"] : [];
  const log = await runGit(dataDir, [
    "-c",
    "core.quotepath=off",
    "log",
    "--reverse",
    "--no-renames",
    ...fullHistory,
    "--no-color",
    "--no-ext-diff",
    "-p",
    "-U0",
    `--format=${COMMIT_MARK}%H${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%s`,
    "--",
    ...paths,
  ]);
  return buildHistory(parseLog(log.stdout), boundary);
}

/** チケットのファイルの候補（md・yaml・yml の 3 つ。subjectOf と同じ）。存在しない拡張子は log に何も出さない */
function ticketPaths(id: string): string[] {
  return [`tickets/${id}.md`, `tickets/${id}.yaml`, `tickets/${id}.yml`];
}

/** 浅い clone の境界のコミット（$GIT_DIR/shallow）。浅くなければ空 */
async function shallowCommits(dataDir: string, gitPath?: string): Promise<Set<string>> {
  const file =
    gitPath ?? (await runGit(dataDir, ["rev-parse", "--git-path", "shallow"])).stdout.trim();
  try {
    const text = await readFile(path.resolve(dataDir, file), "utf8");
    return new Set(text.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}
