// Copilot CLI の Adapter（AG-5・MT-2、ADR-005）。session の記録（<COPILOT_HOME>/session-state/<session>/events.jsonl）から使用量を補う。
//   - 記録の行は {"type", "data", "id", "timestamp", "parentId"}。使用量は type が session.usage_record の行の data.usage
//     （応答 1 回ごとの値で、累計ではない）、モデル名は同じ data.usage.model
//   - Run に結び付ける記録：Claude Code・Codex の Adapter と同じく、Run の ID を最初に含む session の記録。dg run start の
//     出力は tool.execution_complete の結果に入り、その応答の session.usage_record は応答の終わりに書かれるので Run に入る
//   - 数える行：Run の ID が出た後の、started_at〜finished_at の session.usage_record。サブエージェント（task ツール）は別の
//     session-state のディレクトリに自分の記録を持ち、自分で run start した分だけその記録から数える（親の Run には混ぜない。ADR-005）
//   - 写し方：Copilot の inputTokens はキャッシュの読み書きを含む総量なので、input は inputTokens から cacheReadTokens と
//     cacheWriteTokens を引いた新規の入力にする（Copilot 自身の課金内訳 copilotUsage.tokenDetails の input と一致する）。
//     cache_read は cacheReadTokens、cache_write は cacheWriteTokens、output は outputTokens
//   - 探す範囲：環境変数 COPILOT_AGENT_SESSION_ID があればその session の記録。そこに Run がなければ、session.start の gitRoot/cwd が
//     作業ツリーと主の作業ツリーとその上位（HOME より下）に入る session の記録。どちらも started_at より後に書かれたファイルだけ
//   - 返すのは数とモデル名だけ。会話の中身・コマンド・パスは返さない（MT-4）

import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentEnv, CollectedUsage, UsageQuery } from "../define.js";
import {
  count,
  fresh,
  homeDir,
  list,
  none,
  parse,
  searchRoots,
  TAIL_MS,
  timeOf,
  within,
} from "./transcript.js";

type Counts = CollectedUsage["usage"];

/** session の記録の置き場所。COPILOT_HOME があればそこ、なければ ~/.copilot */
function sessionStateDir(env: AgentEnv): string {
  return path.join(env["COPILOT_HOME"] || path.join(homeDir(env), ".copilot"), "session-state");
}

/** session のディレクトリの中の記録ファイル */
function eventsFile(stateDir: string, session: string): string {
  return path.join(stateDir, session, "events.jsonl");
}

/** COPILOT_AGENT_SESSION_ID の session の記録。なければ・形が正しくなければ空 */
async function sessionCandidates(query: UsageQuery, stateDir: string): Promise<string[]> {
  const session = query.env["COPILOT_AGENT_SESSION_ID"];
  if (!session || !/^[\w-]+$/.test(session)) return [];
  return fresh(query, [eventsFile(stateDir, session)]);
}

/** 記録の session.start の gitRoot か cwd。最初の行を読む。見つからなければ undefined */
async function sessionRoot(file: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const entry = parse(line);
      if (entry?.["type"] !== "session.start") return undefined;
      const context = (entry["data"] as Record<string, unknown> | undefined)?.["context"] as
        | Record<string, unknown>
        | undefined;
      const root = context?.["gitRoot"] ?? context?.["cwd"];
      return typeof root === "string" && root ? root : undefined;
    }
  } finally {
    lines.close();
  }
  return undefined;
}

/** 作業ツリーに結び付く session の記録。session の gitRoot/cwd が探す範囲に入るものだけ */
async function worktreeCandidates(query: UsageQuery, stateDir: string): Promise<string[]> {
  const roots = searchRoots(query.topLevel, query.commonDir, homeDir(query.env));
  const files: string[] = [];
  for (const dir of await list(stateDir)) {
    files.push(eventsFile(stateDir, dir));
  }
  const matched: string[] = [];
  for (const file of await fresh(query, files)) {
    const root = await sessionRoot(file).catch(() => undefined);
    if (root && roots.some((r) => within(path.resolve(root), r))) matched.push(file);
  }
  return matched;
}

/** 応答 1 回ごとの使用量の合計。まだ 1 件も取れていないキーは null（RN-2） */
interface Totals {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

interface Scan {
  /** Run の ID を最初に含む行の時刻。含まなければ undefined */
  firstSeen: number | undefined;
  totals: Totals;
  /** Run の ID が出た後の、モデル名ごとの応答の数 */
  models: Map<string, number>;
  /** 期間の session.usage_record を 1 件でも数えたか */
  seen: boolean;
}

const RAW = {
  input: "inputTokens",
  output: "outputTokens",
  cache_read: "cacheReadTokens",
  cache_write: "cacheWriteTokens",
} as const satisfies Record<keyof Totals, string>;

/** usage の 1 件を合計に積む */
function add(totals: Totals, usage: Record<string, unknown>): void {
  for (const [key, field] of Object.entries(RAW) as Array<[keyof Totals, string]>) {
    const n = count(usage[field]);
    if (n !== undefined) totals[key] = (totals[key] ?? 0) + n;
  }
}

async function scan(file: string, query: UsageQuery, from: number, to: number): Promise<Scan> {
  const result: Scan = {
    firstSeen: undefined,
    totals: { input: null, output: null, cache_read: null, cache_write: null },
    models: new Map(),
    seen: false,
  };
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (result.firstSeen === undefined) {
      // Run の ID が出るまでは JSON を読まず、集計も積まない
      if (!line.includes(query.run.id)) continue;
      const entry = parse(line);
      const at = entry ? timeOf(entry) : NaN;
      result.firstSeen = Number.isNaN(at) ? Infinity : at;
      continue;
    }
    // 使用量の行のほかは JSON を読まない
    if (!line.includes("session.usage_record")) continue;
    const entry = parse(line);
    if (!entry || entry["type"] !== "session.usage_record") continue;
    const at = timeOf(entry);
    if (Number.isNaN(at) || at < from || at > to) {
      if (!Number.isNaN(at) && at > to + TAIL_MS) break;
      continue;
    }
    const usage = (entry["data"] as Record<string, unknown> | undefined)?.["usage"];
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as Record<string, unknown>;
    add(result.totals, u);
    result.seen = true;
    const model = u["model"];
    if (typeof model === "string" && model) {
      result.models.set(model, (result.models.get(model) ?? 0) + 1);
    }
  }
  return result;
}

/** inputTokens はキャッシュの読み書きを含む総量なので、新規の入力はそれらを引いた分 */
function usageOf(totals: Totals): Counts {
  const input =
    totals.input === null
      ? null
      : Math.max(0, totals.input - (totals.cache_read ?? 0) - (totals.cache_write ?? 0));
  return {
    input,
    output: totals.output,
    cache_read: totals.cache_read,
    cache_write: totals.cache_write,
  };
}

/** いちばん多くの応答を返したモデル */
function mainModel(models: Scan["models"]): string | null {
  return [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export const copilotAdapter: AgentAdapter = {
  name: "copilot",
  async readTranscriptUsage(query) {
    const stateDir = sessionStateDir(query.env);
    // 時刻は秒までなので、終わりはその秒の終わりまで含める
    const from = Date.parse(query.run.started_at);
    const to = Date.parse(query.finishedAt) + 999;
    let best: Scan | undefined;
    // session のファイルに Run がなければ（別のセッションの環境を受け継いだなど）、作業ツリーから探す
    for (const candidates of [sessionCandidates, worktreeCandidates]) {
      for (const file of await candidates(query, stateDir)) {
        const s = await scan(file, query, from, to).catch(() => undefined);
        if (s?.firstSeen === undefined) continue;
        if (!best || s.firstSeen < (best.firstSeen ?? Infinity)) best = s;
      }
      if (best) break;
    }
    if (!best) {
      return none(
        `Copilot の session 記録に Run ${query.run.id} が見つからない。使用量は null で残す`,
      );
    }
    if (!best.seen) {
      return none(
        `Copilot の session 記録に Run ${query.run.id} の期間の使用量（session.usage_record）がない。使用量は null で残す`,
      );
    }
    const usage = usageOf(best.totals);
    const missing = (Object.keys(usage) as Array<keyof Counts>).filter((k) => usage[k] === null);
    const warnings =
      missing.length > 0
        ? [`Copilot の session 記録から ${missing.join("・")} を取れない。null で残す`]
        : [];
    return { usage, model: mainModel(best.models), warnings };
  },
};
