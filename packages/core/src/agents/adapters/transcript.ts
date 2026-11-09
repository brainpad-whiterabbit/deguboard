// Adapter が会話記録を読むときに共通で使う小さな部品（AG-5、ADR-029）。特定の AI 製品の形はここに書かない

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import type { RunTools, ToolKind } from "../../model/run.js";
import type { AgentEnv, CollectedUsage, UsageQuery } from "../define.js";

export function homeDir(env: AgentEnv): string {
  return env["HOME"] || os.homedir();
}

/** ディレクトリの中の名前。読めなければ空 */
export async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** started_at より前に書き終えたファイルに Run は載っていない */
export async function fresh(query: UsageQuery, files: string[]): Promise<string[]> {
  const since = Date.parse(query.run.started_at);
  const out: string[] = [];
  for (const file of files) {
    const s = await stat(file).catch(() => undefined);
    if (s?.isFile() && s.mtimeMs >= since) out.push(file);
  }
  return out;
}

/** 0 以上の整数だけを数として受け取る */
export const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

export const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // 書きかけの行
  }
};

/** 行の最上位の timestamp。なければ NaN */
export const timeOf = (entry: Record<string, unknown>): number =>
  typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;

/**
 * Run の ID が最初に出た時刻が期間の終わり（to）より後のファイルは、その Run の記録でない。
 * 閉じた後に ID を書いた別のセッション（run refresh を呼んだセッションなど）を選ばないために候補から外す。時刻の分からない行（Infinity）は外さない
 */
export const seenAfterRun = (firstSeen: number, to: number): boolean =>
  Number.isFinite(firstSeen) && firstSeen > to;

/** 行の順が少し前後しても読み切るための猶予。期間の終わりからこれだけ過ぎた行で読むのをやめる */
export const TAIL_MS = 60_000;

/** 呼び出しの順に並べたツールの種類から、種類ごとの回数と、最初に書くまでの読む・探すの回数を求める */
export function tallyTools(kinds: Iterable<ToolKind>): RunTools {
  const tools: RunTools = {
    read: 0,
    search: 0,
    write: 0,
    bash: 0,
    other: 0,
    read_before_write: 0,
    search_before_write: 0,
  };
  let written = false;
  for (const kind of kinds) {
    tools[kind] += 1;
    if (kind === "write") written = true;
    else if (!written && kind === "read") tools.read_before_write += 1;
    else if (!written && kind === "search") tools.search_before_write += 1;
  }
  return tools;
}

/** 何も取れなかったときの値 */
export const none = (warning: string): CollectedUsage => ({
  usage: { input: null, output: null, cache_read: null, cache_write: null },
  model: null,
  tools: null,
  warnings: [warning],
});

/** ほかの Run を始めた記録とみなす、ID が最初に出るまでの開始からの猶予 */
export const START_MS = 60_000;

/**
 * 同じ会話記録で期間が重なる Run に、1 つの応答を二重に数えないための判定（MT-2）。
 * 応答は、その応答より前に ID が出ていて、その時刻に開いている Run のうち、いちばん新しく始まったものだけに数える。
 * ID の出た時刻と Run の期間で決まり、閉じる順によらない（run start の開いたままの Run の警告は知らせるだけで、数え方を直せないため）。
 * 比べるのは自分より後に始まって期間が重なる同じ agent の Run だけで、その ID がこのファイルで最初に出たのが開始から START_MS 以内のもの
 * （そのファイルで dg run start を呼んだ Run）。後から一覧などで ID を見ただけの、ほかの記録の Run には譲らない。
 * 開始から START_MS 以内でも、ほかのファイルで ID が同じか先に出た Run（elsewhere。claimedElsewhere で求める）には譲らない
 */
export class OverlapClaims {
  /** まだ ID が出ていない、自分より後に始まって期間が重なる Run の開始と終わり */
  private readonly pending = new Map<string, { from: number; to: number }>();
  /** ID が出た、譲る相手の期間 */
  private readonly newer: Array<{ from: number; to: number }> = [];
  /** pending の Run の ID がこのファイルで最初に出た時刻。時刻の分からない行は Infinity */
  readonly seen = new Map<string, number>();
  /** 譲る相手にした Run の ID */
  readonly claimants = new Set<string>();
  /** ほかのファイルで ID が先に出た Run。譲る相手にしない */
  private readonly elsewhere: ReadonlySet<string>;
  /** 譲る相手になりうる Run の ID（自分より後に始まって期間が重なる同じ agent の Run） */
  readonly rivals: readonly string[];

  constructor(
    query: UsageQuery,
    from: number,
    to: number,
    elsewhere: ReadonlySet<string> = new Set(),
  ) {
    const self = query.run;
    for (const [id, span] of query.others ?? []) {
      // ほかの agent の Run はその agent の会話記録に結び付くので、このファイルの応答を譲らない
      if (id === self.id || (span.agent !== undefined && span.agent !== self.agent)) continue;
      const start = Date.parse(span.started_at);
      // 終わりは秒までなので、その秒の終わりまで含める。実行中なら開いたまま
      const end = span.finished_at === null ? Infinity : Date.parse(span.finished_at) + 999;
      if (Number.isNaN(start) || Number.isNaN(end) || start > to || end < from) continue;
      // 同じ秒なら ID の順で決める（決まればよく、開始の順とは限らない）
      const later =
        start > Date.parse(self.started_at) ||
        (span.started_at === self.started_at && id.localeCompare(self.id) > 0);
      if (later) this.pending.set(id, { from: start, to: end });
    }
    this.elsewhere = elsewhere;
    this.rivals = [...this.pending.keys()];
  }

  /** 行を読んだ後に呼び、その行に初めて出たほかの Run の ID を記録する */
  see(line: string): void {
    if (this.pending.size === 0) return;
    for (const [id, span] of this.pending) {
      if (!line.includes(id)) continue;
      this.pending.delete(id);
      const entry = parse(line);
      const at = entry ? timeOf(entry) : NaN;
      this.seen.set(id, Number.isNaN(at) ? Infinity : at);
      if (this.elsewhere.has(id)) continue;
      if (Number.isNaN(at) || at <= span.from + START_MS) {
        this.newer.push(span);
        this.claimants.add(id);
      }
    }
  }

  /** 時刻 at の応答を自分に数えるか。後に始まった開いている Run の ID が先に出ていれば、そちらに譲る */
  owns(at: number): boolean {
    return !this.newer.some((s) => s.from <= at && at <= s.to);
  }
}

/** 行の中の timestamp の値。最上位の timestamp のほか、入れ子の中の同じキーも当たる */
export const TIMESTAMPS = /"timestamp":"([^"]+)"/g;

/** 行の timestamp がすべて limit を過ぎているか。timestamp のない行は過ぎていないとみなす */
export function pastAll(line: string, limit: number): boolean {
  const stamps = Array.from(line.matchAll(TIMESTAMPS), (m) => Date.parse(m[1] ?? ""));
  return stamps.length > 0 && stamps.every((t) => t > limit);
}

/**
 * file で ids のそれぞれが最初に出た時刻（時刻の分からない行は Infinity）。使用量は読まない。
 * 行の timestamp がすべて limit を過ぎたら読むのをやめる（それより後に出ても使わない）
 */
export async function sightings(
  file: string,
  ids: readonly string[],
  limit: number,
): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  const input = createReadStream(file);
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (seen.size === ids.length || pastAll(line, limit)) break;
      for (const id of ids) {
        if (seen.has(id) || !line.includes(id)) continue;
        const entry = parse(line);
        const at = entry ? timeOf(entry) : NaN;
        seen.set(id, Number.isNaN(at) ? Infinity : at);
      }
    }
  } finally {
    input.destroy();
  }
  return seen;
}

/** bindFile の結果。file は Run を結び付けるファイル（なければ undefined）、others はそのほかのファイルで rivals が最初に出た時刻 */
export interface Bound {
  file: string | undefined;
  others: Array<{ seen: ReadonlyMap<string, number> }>;
}

/**
 * Run を結び付けるファイルを選ぶ（MT-2）。files（会話記録の置き場所のすべて）のそれぞれで Run の ID と rivals が最初に出た時刻を読み、
 * Run の ID が最も早く出たファイルを返す。ID は dg run start か ticket claim が作るので、最も早く出たファイルがその Run を始めた記録で、
 * run start の警告などで後から ID を見ただけのファイルは選ばない。同じ時刻（ミリ秒）のときは、ファイルのパスの順で決める。
 * 呼ぶ session（CLAUDE_CODE_SESSION_ID など）の環境は選びに使わないので、finish と refresh で同じファイルになる。
 * ID が最初に出たのが to より後のファイルは除く（seenAfterRun）。rivals は to + START_MS までに出なければ譲る相手にならないので、
 * そこから TAIL_MS 過ぎた行で読むのをやめる
 */
export async function bindFile(
  query: UsageQuery,
  files: readonly string[],
  to: number,
  rivals: readonly string[],
): Promise<Bound> {
  const ids = [query.run.id, ...rivals];
  const limit = to + START_MS + TAIL_MS;
  const read: Array<{ file: string; seen: Map<string, number> }> = [];
  let best: { file: string; at: number } | undefined;
  for (const file of new Set(files)) {
    const seen = await sightings(file, ids, limit).catch(() => undefined);
    if (!seen) continue;
    read.push({ file, seen });
    const at = seen.get(query.run.id);
    if (at === undefined || seenAfterRun(at, to)) continue;
    // 同じ時刻のときは、パスの辞書順で小さい方。files の列挙の順によらない
    if (!best || at < best.at || (at === best.at && file < best.file)) best = { file, at };
  }
  return { file: best?.file, others: read.filter((r) => r.file !== best?.file) };
}

/**
 * 選んだファイル（chosen）が譲る相手にしていた Run のうち、読んだほかのファイル（all）で ID が先か同じ時刻に出たものを返す。
 * その Run は Adapter がそちらのファイルに結び付くので、chosen はその Run に譲らず、期間の応答を数える（返した ID は譲る相手から外す）。
 * all は Run を探す範囲と同じ、会話記録の置き場所のすべて（Claude Code は projects/ の下、Codex は sessions/ の下）。
 * all を探す範囲と同じにしておかないと、別の worktree などで始まった Run に譲ってしまう。
 * 同じ時刻のときは、bindFile がパスの順で結び付けるが、ここでは量を落とさない側（譲らない）に倒す。そのため、その時刻の応答は二重に数えられうる
 */
export function claimedElsewhere(
  chosen: OverlapClaims,
  all: Iterable<{ seen: ReadonlyMap<string, number> }>,
): Set<string> {
  const out = new Set<string>();
  for (const id of chosen.claimants) {
    const here = chosen.seen.get(id) ?? Infinity;
    for (const other of all) {
      const there = other.seen.get(id);
      if (other !== chosen && there !== undefined && there <= here) out.add(id);
    }
  }
  return out;
}
