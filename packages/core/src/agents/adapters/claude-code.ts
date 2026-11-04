// Claude Code の Adapter（AG-5・MT-2、ADR-005）。会話記録（<設定>/projects/<作業ディレクトリ>/<session>.jsonl）から使用量を補う。
//   - Run に結び付ける記録：Run の ID を最初に含む会話記録のファイル。dg run start の出力を受け取ったエージェントの記録になる。
//     サブエージェントは親と同じ session の subagents/ に別のファイルを持ち、作業ディレクトリと時刻だけでは並行するエージェントと区別できない
//   - 数える行：そのファイルの assistant の行のうち、Run の ID が出た後の started_at〜finished_at のもの。同じ応答が複数行に
//     分かれるので message.id で重ねない。subagents/ の外のファイルの isSidechain の行（古い版が親のファイルに書くサブエージェントの行）は数えない
//   - 探す範囲：環境変数 CLAUDE_CODE_SESSION_ID があればその session のファイル。そこに Run がなければ、作業ツリーと主の作業ツリーと、
//     主の作業ツリーの親までの上位のディレクトリ（HOME とその上は除く）に当たる projects/ の下。どちらも started_at より後に書かれたファイルだけ
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
} from "./transcript.js";

type Counts = CollectedUsage["usage"];

/** 会話記録の置き場所。CLAUDE_CONFIG_DIR があればそこ、なければ ~/.claude */
function configDir(env: AgentEnv): string {
  return env["CLAUDE_CONFIG_DIR"] || path.join(homeDir(env), ".claude");
}

/** 作業ディレクトリから projects/ の下のディレクトリ名を作る（英数字以外を - にする） */
export function projectDirName(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/** session の会話記録と、そのサブエージェントの会話記録 */
async function sessionFiles(projectDir: string, session: string): Promise<string[]> {
  const sub = path.join(projectDir, session, "subagents");
  return [
    path.join(projectDir, `${session}.jsonl`),
    ...(await list(sub)).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(sub, f)),
  ];
}

/** CLAUDE_CODE_SESSION_ID の session のファイル。なければ・形が正しくなければ空 */
async function sessionCandidates(query: UsageQuery, projects: string): Promise<string[]> {
  const session = query.env["CLAUDE_CODE_SESSION_ID"];
  if (!session || !/^[\w-]+$/.test(session)) return [];
  const files: string[] = [];
  for (const dir of await list(projects)) {
    files.push(...(await sessionFiles(path.join(projects, dir), session)));
  }
  return fresh(query, files);
}

/** 作業ツリーから探すファイル。主の作業ツリーでセッションを始め、別の worktree で作業することがある */
async function worktreeCandidates(query: UsageQuery, projects: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of searchRoots(query.topLevel, query.commonDir, homeDir(query.env))) {
    const dir = path.join(projects, projectDirName(root));
    for (const entry of await list(dir)) {
      if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
      else files.push(...(await sessionFiles(dir, entry)).slice(1));
    }
  }
  return fresh(query, files);
}

interface Scan {
  /** Run の ID を最初に含む行の時刻。含まなければ undefined */
  firstSeen: number | undefined;
  /** message.id ごとの使用量とモデル名 */
  messages: Map<string, { usage: Record<string, unknown>; model: unknown }>;
}

/** 行の中の timestamp の値。最上位の timestamp は message の後にあり、入れ子の中にも同じキーがありうるので、すべてを候補にする */
const TIMESTAMPS = /"timestamp":"([^"]+)"/g;

async function scan(file: string, query: UsageQuery, from: number, to: number): Promise<Scan> {
  const result: Scan = { firstSeen: undefined, messages: new Map() };
  // subagents/ の外のファイルでは、サブエージェントの行（isSidechain）は親の使用量でない
  const sidechainFile = file.split(path.sep).includes("subagents");
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
    if (!line.includes('"assistant"')) continue;
    // 期間に入る timestamp の文字列がない行は JSON.parse しない
    const stamps = Array.from(line.matchAll(TIMESTAMPS), (m) => Date.parse(m[1] ?? ""));
    if (!stamps.some((t) => t >= from && t <= to)) {
      if (stamps.length > 0 && stamps.every((t) => t > to + TAIL_MS)) break;
      continue;
    }
    const entry = parse(line);
    if (!entry || entry["type"] !== "assistant") continue;
    const at = timeOf(entry);
    if (Number.isNaN(at) || at < from || at > to) continue;
    if (!sidechainFile && entry["isSidechain"] === true) continue;
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

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  async readTranscriptUsage(query) {
    const projects = path.join(configDir(query.env), "projects");
    // 時刻は秒までなので、終わりはその秒の終わりまで含める
    const from = Date.parse(query.run.started_at);
    const to = Date.parse(query.finishedAt) + 999;
    let best: Scan | undefined;
    // session のファイルに Run がなければ（別のセッションの環境を受け継いだなど）、作業ツリーから探す
    for (const candidates of [sessionCandidates, worktreeCandidates]) {
      for (const file of await candidates(query, projects)) {
        const s = await scan(file, query, from, to).catch(() => undefined);
        if (s?.firstSeen === undefined) continue;
        if (!best || s.firstSeen < (best.firstSeen ?? Infinity)) best = s;
      }
      if (best) break;
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
