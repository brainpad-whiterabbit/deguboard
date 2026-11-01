// Claude Code の Adapter（AG-5・MT-2、ADR-005）。会話記録（<設定>/projects/<作業ディレクトリ>/<session>.jsonl）から使用量を補う。
//   - Run に結び付ける記録：Run の ID を最初に含む会話記録のファイル。dg run start の出力を受け取ったエージェントの記録になる。
//     サブエージェントは親と同じ session の subagents/ に別のファイルを持ち、作業ディレクトリと時刻だけでは並行するエージェントと区別できない
//   - 数える行：そのファイルの assistant の行のうち、started_at〜finished_at のもの。同じ応答が複数行に分かれるので message.id で重ねない
//   - 探す範囲：環境変数 CLAUDE_CODE_SESSION_ID があればその session のファイル、なければ作業ツリーと主の作業ツリーとその上位の
//     ディレクトリに当たる projects/ の下。どちらも started_at より後に書かれたファイルだけ
//   - 返すのは数とモデル名だけ。会話の中身・コマンド・パスは返さない（MT-4）

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentEnv, CollectedUsage, UsageQuery } from "../define.js";

type Counts = CollectedUsage["usage"];

/** 会話記録の置き場所。CLAUDE_CONFIG_DIR があればそこ、なければ ~/.claude */
function configDir(env: AgentEnv): string {
  return env["CLAUDE_CONFIG_DIR"] || path.join(env["HOME"] || os.homedir(), ".claude");
}

/** 作業ディレクトリから projects/ の下のディレクトリ名を作る（英数字以外を - にする） */
export function projectDirName(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(d);
    if (path.dirname(d) === d) return out;
  }
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** session の会話記録と、そのサブエージェントの会話記録 */
async function sessionFiles(projectDir: string, session: string): Promise<string[]> {
  const sub = path.join(projectDir, session, "subagents");
  return [
    path.join(projectDir, `${session}.jsonl`),
    ...(await list(sub)).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(sub, f)),
  ];
}

async function candidateFiles(query: UsageQuery, projects: string): Promise<string[]> {
  const session = query.env["CLAUDE_CODE_SESSION_ID"];
  const files: string[] = [];
  if (session && /^[\w-]+$/.test(session)) {
    for (const dir of await list(projects)) {
      files.push(...(await sessionFiles(path.join(projects, dir), session)));
    }
  } else {
    // 主の作業ツリー（common dir の親）でセッションを始め、別の worktree で作業することがある
    const roots = [query.topLevel, path.dirname(query.commonDir)];
    const names = new Set(roots.flatMap(ancestors).map(projectDirName));
    for (const name of names) {
      const dir = path.join(projects, name);
      for (const entry of await list(dir)) {
        if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
        else files.push(...(await sessionFiles(dir, entry)).slice(1));
      }
    }
  }
  // started_at より前に書き終えたファイルに Run は載っていない
  const since = Date.parse(query.run.started_at);
  const fresh: string[] = [];
  for (const file of files) {
    const s = await stat(file).catch(() => undefined);
    if (s?.isFile() && s.mtimeMs >= since) fresh.push(file);
  }
  return fresh;
}

interface Scan {
  /** Run の ID を最初に含む行の時刻。含まなければ undefined */
  firstSeen: number | undefined;
  /** message.id ごとの使用量とモデル名 */
  messages: Map<string, { usage: Record<string, unknown>; model: unknown }>;
}

const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

async function scan(file: string, query: UsageQuery, from: number, to: number): Promise<Scan> {
  const result: Scan = { firstSeen: undefined, messages: new Map() };
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const mentions = line.includes(query.run.id);
    if (!mentions && !line.includes('"assistant"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 書きかけの行
    }
    const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;
    if (mentions && result.firstSeen === undefined)
      result.firstSeen = Number.isNaN(at) ? Infinity : at;
    if (entry["type"] !== "assistant" || Number.isNaN(at) || at < from || at > to) continue;
    const message = entry["message"] as Record<string, unknown> | undefined;
    const usage = message?.["usage"];
    if (!message || typeof usage !== "object" || usage === null) continue;
    const key = String(message["id"] ?? entry["requestId"] ?? entry["uuid"] ?? line);
    // 同じ応答の行は後の行が最終の値を持つ
    result.messages.set(key, { usage: usage as Record<string, unknown>, model: message["model"] });
  }
  return result;
}

const FIELDS = {
  input: "input_tokens",
  output: "output_tokens",
  cache_read: "cache_read_input_tokens",
  cache_write: "cache_creation_input_tokens",
} as const satisfies Record<keyof Counts, string>;

function sum(messages: Scan["messages"]): Counts {
  const totals: Counts = { input: null, output: null, cache_read: null, cache_write: null };
  for (const { usage } of messages.values()) {
    for (const [key, field] of Object.entries(FIELDS) as Array<[keyof Counts, string]>) {
      const n = count(usage[field]);
      if (n !== undefined) totals[key] = (totals[key] ?? 0) + n;
    }
  }
  return totals;
}

/** いちばん多くの応答を返したモデル。<synthetic>（API を呼ばない応答）は数えない */
function mainModel(messages: Scan["messages"]): string | null {
  const counts = new Map<string, number>();
  for (const { model } of messages.values()) {
    if (typeof model === "string" && model && !model.startsWith("<")) {
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const none = (warning: string): CollectedUsage => ({
  usage: { input: null, output: null, cache_read: null, cache_write: null },
  model: null,
  warnings: [warning],
});

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  async readTranscriptUsage(query) {
    const projects = path.join(configDir(query.env), "projects");
    // 時刻は秒までなので、終わりはその秒の終わりまで含める
    const from = Date.parse(query.run.started_at);
    const to = Date.parse(query.finishedAt) + 999;
    let best: Scan | undefined;
    for (const file of await candidateFiles(query, projects)) {
      const s = await scan(file, query, from, to).catch(() => undefined);
      if (s?.firstSeen === undefined) continue;
      if (!best || s.firstSeen < (best.firstSeen ?? Infinity)) best = s;
    }
    if (!best) {
      return none(
        `Claude Code の会話記録に Run ${query.run.id} が見つからない。使用量は null で残す`,
      );
    }
    if (best.messages.size === 0) {
      return none(
        `Claude Code の会話記録に Run ${query.run.id} の期間の応答がない。使用量は null で残す`,
      );
    }
    return { usage: sum(best.messages), model: mainModel(best.messages), warnings: [] };
  },
};
