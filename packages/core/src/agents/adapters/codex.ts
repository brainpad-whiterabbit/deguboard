// Codex の Adapter（AG-5・MT-2、ADR-005）。会話記録（<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl）から使用量を補う。
//   - 記録の行は {"timestamp", "type", "payload"}。使用量は type が event_msg で payload.type が token_count の行の
//     payload.info.total_token_usage（session の累計）、モデル名は type が turn_context の行の payload.model
//   - Run に結び付ける記録：Claude Code の Adapter と同じく、Run の ID を最初に含む会話記録のファイル（ID が最初に出たのが
//     finished_at より後のファイルは除く）
//   - 数える量：Run の ID が出る前の最後の累計と、finished_at までの最後の累計の差。累計が減っていれば（記録の作り直しなど）取れない。
//     Codex は応答のツールを実行し終えてからその応答の token_count を書くので、dg run start を呼んだ応答は Run に入り、
//     dg run finish を呼んだ応答は入らない（Claude Code の Adapter と 1 応答ずれる。ADR-005）。書く順は openai/codex の
//     codex-rs/core/src/session/turn.rs で確かめた（2026-10-31 の main。本物の記録では未確認）
//   - 期間が重なる Run：同じファイルで、後に始まった開いている Run の ID が先に出ていれば（OverlapClaims）、その間の token_count の
//     累計の増え（直前の累計との差）を除く。turn_context のモデル名も数えない。ほかのファイルで ID が同じか先に出た Run には譲らない
//     （探す範囲が sessions/ の下のすべてなので、Claude Code の Adapter が projects/ の下のすべてで比べるのと同じ規則になる）
//   - 写し方：input は input_tokens から cached_input_tokens を引いた値（キャッシュを読まなかった入力。Claude Code と同じ意味）、
//     cache_read は cached_input_tokens、output は output_tokens、cache_write は cache_write_input_tokens。
//     cache_write_input_tokens を書かない版の記録では cache_write を null にして警告する
//   - 探す範囲：環境変数 CODEX_HOME（なければ ~/.codex）の sessions/ の下で、started_at より後に書かれた .jsonl。
//     圧縮した記録（.jsonl.zst）は読まない
//   - ツールの回数は数えない（null）。返すのは数とモデル名だけ。会話の中身・コマンド・パスは返さない（MT-4）

import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentEnv, CollectedUsage, UsageQuery } from "../define.js";
import {
  claimedElsewhere,
  count,
  fresh,
  homeDir,
  list,
  none,
  OverlapClaims,
  parse,
  seenAfterRun,
  TAIL_MS,
  timeOf,
} from "./transcript.js";

type Counts = CollectedUsage["usage"];

/** Codex の設定と会話記録の置き場所。CODEX_HOME があればそこ、なければ ~/.codex */
function codexHome(env: AgentEnv): string {
  return env["CODEX_HOME"] || path.join(homeDir(env), ".codex");
}

/** sessions/YYYY/MM/DD/ の下の .jsonl。日付の階層の外のファイルは Codex が書かないので見ない */
async function sessionFiles(query: UsageQuery): Promise<string[]> {
  const sessions = path.join(codexHome(query.env), "sessions");
  const files: string[] = [];
  for (const year of await list(sessions)) {
    for (const month of await list(path.join(sessions, year))) {
      for (const day of await list(path.join(sessions, year, month))) {
        const dir = path.join(sessions, year, month, day);
        for (const f of await list(dir)) if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
      }
    }
  }
  return fresh(query, files);
}

/** token_count の累計。数でない値のキーは undefined */
type Total = Record<"input" | "cached" | "cacheWrite" | "output", number | undefined>;

interface Scan {
  /** Run の ID を最初に含む行の時刻。含まなければ undefined */
  firstSeen: number | undefined;
  /** Run の ID が出る前の最後の累計。なければ session の始まり（すべて 0） */
  before: Total | undefined;
  /** finished_at までの最後の累計 */
  last: Total | undefined;
  /** 後に始まった開いている Run に譲った累計の増え。キーが undefined なら増えを求められない */
  ceded: Total;
  /** Run の ID が出る前の最後のモデル名 */
  modelBefore: string | undefined;
  /** Run の ID が出た後の、モデル名ごとの turn の数 */
  models: Map<string, number>;
  /** 期間が重なるほかの Run の ID が出た時刻と、譲る相手 */
  claims: OverlapClaims;
}

function totalOf(entry: Record<string, unknown>): Total | undefined {
  const payload = entry["payload"] as Record<string, unknown> | undefined;
  const info = payload?.["info"] as Record<string, unknown> | null | undefined;
  const t = info?.["total_token_usage"];
  if (typeof t !== "object" || t === null) return undefined; // info が null の token_count は量が分からない
  const u = t as Record<string, unknown>;
  return {
    input: count(u["input_tokens"]),
    cached: count(u["cached_input_tokens"]),
    cacheWrite: count(u["cache_write_input_tokens"]),
    output: count(u["output_tokens"]),
  };
}

function modelOf(entry: Record<string, unknown>): string | undefined {
  const model = (entry["payload"] as Record<string, unknown> | undefined)?.["model"];
  return typeof model === "string" && model ? model : undefined;
}

/** event_msg の token_count の行か。type と payload.type の両方を確かめる */
function isTokenCount(entry: Record<string, unknown>): boolean {
  const payload = entry["payload"] as Record<string, unknown> | undefined;
  return entry["type"] === "event_msg" && payload?.["type"] === "token_count";
}

/** 生の行を後ろから読み、pick が値を返す最初の行の値。なければ undefined */
function latest<T>(
  raw: string[],
  pick: (entry: Record<string, unknown>) => T | undefined,
): T | undefined {
  for (let i = raw.length - 1; i >= 0; i--) {
    const entry = parse(raw[i] ?? "");
    const value = entry ? pick(entry) : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 譲った増え（cur と prev の差）を足す。片方でも数がなければ、または減っていれば求められない */
function cede(ceded: Total, cur: Total, prev: Total | undefined): void {
  for (const key of Object.keys(ceded) as Array<keyof Total>) {
    const end = cur[key];
    const start = prev === undefined ? 0 : prev[key];
    const acc = ceded[key];
    ceded[key] =
      end === undefined || start === undefined || acc === undefined || end < start
        ? undefined
        : acc + end - start;
  }
}

async function scan(
  file: string,
  query: UsageQuery,
  to: number,
  elsewhere?: ReadonlySet<string>,
): Promise<Scan> {
  const claims = new OverlapClaims(query, Date.parse(query.run.started_at), to, elsewhere);
  const result: Scan = {
    firstSeen: undefined,
    before: undefined,
    last: undefined,
    ceded: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
    modelBefore: undefined,
    models: new Map(),
    claims,
  };
  // Run の ID が出るまでは候補の生の行を持つだけで JSON を読まない。ID が出たら後ろから遡り、最初に使える行だけを読む
  const usageLines: string[] = [];
  const contextLines: string[] = [];
  const input = createReadStream(file);
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      // ほかの Run の ID はその行の後の累計から効く。数える token_count・turn_context の行は Run の ID を含まないので、先に記録してよい
      claims.see(line);
      // Codex は JSON を空白なしで書く。文字列の中の "type":"token_count" は引用符がエスケープされるので当たらない
      const usageLine = line.includes('"type":"token_count"');
      const contextLine = line.includes('"type":"turn_context"');
      if (result.firstSeen === undefined) {
        if (!line.includes(query.run.id)) {
          if (usageLine) usageLines.push(line);
          if (contextLine) contextLines.push(line);
          continue;
        }
        const entry = parse(line);
        const at = entry ? timeOf(entry) : NaN;
        result.firstSeen = Number.isNaN(at) ? Infinity : at;
        result.before = latest(usageLines, (e) => (isTokenCount(e) ? totalOf(e) : undefined));
        result.modelBefore = latest(contextLines, (e) =>
          e["type"] === "turn_context" ? modelOf(e) : undefined,
        );
        usageLines.length = 0;
        contextLines.length = 0;
        continue;
      }
      // 使用量とモデル名の行のほかは JSON を読まない
      if (!usageLine && !contextLine) continue;
      const entry = parse(line);
      if (!entry) continue;
      const at = timeOf(entry);
      if (Number.isNaN(at) || at > to) {
        if (at > to + TAIL_MS) break;
        continue;
      }
      const owned = claims.owns(at);
      if (isTokenCount(entry)) {
        const total = totalOf(entry);
        if (total && !owned) cede(result.ceded, total, result.last ?? result.before);
        result.last = total ?? result.last;
      }
      if (entry["type"] === "turn_context" && owned) {
        const model = modelOf(entry);
        if (model) result.models.set(model, (result.models.get(model) ?? 0) + 1);
      }
    }
  } finally {
    input.destroy();
  }
  return result;
}

/** 累計の差から譲った増えを除いた値。片方でも数がなければ、減っていれば、譲った増えを求められなければ null */
function diff(s: Scan, last: Total, key: keyof Total): number | null {
  const end = last[key];
  const start = s.before === undefined ? 0 : s.before[key];
  const ceded = s.ceded[key];
  if (end === undefined || start === undefined || ceded === undefined || end - start < ceded)
    return null;
  return end - start - ceded;
}

/** last は finished_at までの最後の累計 */
function usageOf(s: Scan, last: Total): Counts {
  const input = diff(s, last, "input");
  const cached = diff(s, last, "cached");
  return {
    // input_tokens はキャッシュから読んだ分を含む
    input: input !== null && cached !== null && input >= cached ? input - cached : null,
    output: diff(s, last, "output"),
    cache_read: cached,
    cache_write: diff(s, last, "cacheWrite"),
  };
}

/** いちばん多くの turn を受けたモデル。Run の ID の後に turn がなければ、その前の最後のモデル */
function mainModel(s: Scan): string | null {
  return [...s.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.modelBefore ?? null;
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  async readTranscriptUsage(query) {
    // 時刻は秒までなので、終わりはその秒の終わりまで含める
    const to = Date.parse(query.finishedAt) + 999;
    let best: Scan | undefined;
    let bestFile = "";
    const read: OverlapClaims[] = [];
    for (const file of await sessionFiles(query)) {
      const s = await scan(file, query, to).catch(() => undefined);
      if (s) read.push(s.claims);
      if (s?.firstSeen === undefined || seenAfterRun(s.firstSeen, to)) continue;
      if (!best || s.firstSeen < (best.firstSeen ?? Infinity)) [best, bestFile] = [s, file];
    }
    // ほかのファイルで ID が先に出た Run には譲らずに読み直す
    const elsewhere = best ? claimedElsewhere(best.claims, read) : new Set<string>();
    if (elsewhere.size > 0)
      best = await scan(bestFile, query, to, elsewhere).catch(() => undefined);
    if (!best) {
      return none(`Codex の会話記録に Run ${query.run.id} が見つからない。使用量は null で残す`);
    }
    if (!best.last) {
      return none(
        `Codex の会話記録に Run ${query.run.id} の期間の使用量（token_count）がない。使用量は null で残す`,
      );
    }
    const usage = usageOf(best, best.last);
    const missing = (Object.keys(usage) as Array<keyof Counts>).filter((k) => usage[k] === null);
    const warnings =
      missing.length > 0
        ? [`Codex の会話記録から ${missing.join("・")} を取れない。null で残す`]
        : [];
    return { usage, model: mainModel(best), tools: null, warnings };
  },
};
