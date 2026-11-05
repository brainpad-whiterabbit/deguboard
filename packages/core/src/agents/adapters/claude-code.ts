// Claude Code の Adapter（AG-5・MT-2、ADR-005）。会話記録（<設定>/projects/<作業ディレクトリ>/<session>.jsonl）から使用量とツールの回数を補う。
//   - Run に結び付ける記録：Run の ID を最初に含む会話記録のファイル。dg run start の出力を受け取ったエージェントの記録になる。
//     ID が最初に出たのが finished_at より後のファイル（閉じた後に run refresh を呼んだセッションなど）は Run の記録とみなさない。
//     サブエージェントは親と同じ session の subagents/ に別のファイルを持ち、作業ディレクトリと時刻だけでは並行するエージェントと区別できない
//   - 数える行：そのファイルの assistant の行のうち、Run の ID が出た後の started_at〜finished_at のもの。同じ応答が複数行に
//     分かれるので message.id で重ねない。subagents/ の外のファイルの isSidechain の行（古い版が親のファイルに書くサブエージェントの行）は数えない。
//     同じファイルで期間が重なるほかの Run があれば、応答は ID が先に出ていて開いている Run のうち最も新しく始まったものにだけ数える（OverlapClaims）。
//     ほかのファイルで ID が同じか先に出た Run には譲らない（その Run の記録はそちらのファイル）。譲る相手がいれば、探す範囲の外も含む
//     projects/ の下のすべてで相手の ID を探して比べる（別の worktree で始めた Run に譲らない）。すべて譲ったら量は 0
//   - 探す範囲：環境変数 CLAUDE_CODE_SESSION_ID があればその session のファイル。そこに Run がなければ、作業ツリーと主の作業ツリーと、
//     主の作業ツリーの親までの上位のディレクトリ（HOME とその上は除く）に当たる projects/ の下。どちらも started_at より後に書かれたファイルだけ
//   - ツールの回数：数える行の message.content の tool_use を、tool_use の id で重ねずに名前で種類に分けて数える（TOOL_KINDS）。
//     最初に書く（write）までの読む・探すも数える。Bash はコマンドで分けない
//   - 返すのは数とモデル名だけ。会話の中身・コマンド・パスは返さない（MT-4）。ツールは名前を種類に変えて数だけを返す

import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ToolKind } from "../../model/run.js";
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
  searchRoots,
  seenAfterRun,
  sightings,
  tallyTools,
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

/** projects/ の下の 1 つのディレクトリの会話記録と、そのサブエージェントの会話記録 */
async function projectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await list(dir)) {
    if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
    else files.push(...(await sessionFiles(dir, entry)).slice(1));
  }
  return files;
}

/** 作業ツリーから探すファイル。主の作業ツリーでセッションを始め、別の worktree で作業することがある */
async function worktreeCandidates(query: UsageQuery, projects: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of searchRoots(query.topLevel, query.commonDir, homeDir(query.env))) {
    files.push(...(await projectFiles(path.join(projects, projectDirName(root)))));
  }
  return fresh(query, files);
}

/** projects/ の下のすべての会話記録。譲る相手の Run がどこで始まったかを比べるのに使う */
async function allCandidates(query: UsageQuery, projects: string): Promise<string[]> {
  const files: string[] = [];
  for (const dir of await list(projects))
    files.push(...(await projectFiles(path.join(projects, dir))));
  return fresh(query, files);
}

interface Scan {
  /** Run の ID を最初に含む行の時刻。含まなければ undefined */
  firstSeen: number | undefined;
  /** message.id ごとの使用量とモデル名 */
  messages: Map<string, { usage: Record<string, unknown>; model: unknown }>;
  /** tool_use の id ごとの種類。Map の順が呼び出しの順 */
  tools: Map<string, ToolKind>;
  /** 後に始まった開いている Run に譲った応答があるか */
  ceded: boolean;
  /** 期間が重なるほかの Run の ID が出た時刻と、譲る相手 */
  claims: OverlapClaims;
}

/** Claude Code のツールの名前と種類。載っていない名前（Agent・TodoWrite・Web・MCP など）は other */
const TOOL_KIND_OF: Readonly<Record<string, ToolKind>> = {
  Read: "read",
  NotebookRead: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  Edit: "write",
  MultiEdit: "write",
  Write: "write",
  NotebookEdit: "write",
  Bash: "bash",
};

/** 応答の中の tool_use を、id をキーにして種類で積む。名前は種類に変えるだけで残さない */
function addTools(tools: Scan["tools"], message: Record<string, unknown>, key: string): void {
  const content = message["content"];
  if (!Array.isArray(content)) return;
  content.forEach((block: unknown, n) => {
    if (typeof block !== "object" || block === null) return;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "tool_use") return;
    const id = typeof b["id"] === "string" ? b["id"] : `${key}#${n}`;
    if (tools.has(id)) return;
    const name = typeof b["name"] === "string" ? b["name"] : "";
    tools.set(id, Object.hasOwn(TOOL_KIND_OF, name) ? TOOL_KIND_OF[name]! : "other");
  });
}

/** 行の中の timestamp の値。最上位の timestamp は message の後にあり、入れ子の中にも同じキーがありうるので、すべてを候補にする */
const TIMESTAMPS = /"timestamp":"([^"]+)"/g;

async function scan(
  file: string,
  query: UsageQuery,
  from: number,
  to: number,
  elsewhere?: ReadonlySet<string>,
): Promise<Scan> {
  const claims = new OverlapClaims(query, from, to, elsewhere);
  const result: Scan = {
    firstSeen: undefined,
    messages: new Map(),
    tools: new Map(),
    ceded: false,
    claims,
  };
  // subagents/ の外のファイルでは、サブエージェントの行（isSidechain）は親の使用量でない
  const sidechainFile = file.split(path.sep).includes("subagents");
  /** 1 行を積む。読むのをやめるときだけ false */
  const take = (line: string): boolean => {
    if (result.firstSeen === undefined) {
      // Run の ID が出るまでは JSON を読まず、集計も積まない
      if (!line.includes(query.run.id)) return true;
      const entry = parse(line);
      const at = entry ? timeOf(entry) : NaN;
      result.firstSeen = Number.isNaN(at) ? Infinity : at;
      return true;
    }
    if (!line.includes('"assistant"')) return true;
    // 期間に入る timestamp の文字列がない行は JSON.parse しない
    const stamps = Array.from(line.matchAll(TIMESTAMPS), (m) => Date.parse(m[1] ?? ""));
    if (!stamps.some((t) => t >= from && t <= to)) {
      return !(stamps.length > 0 && stamps.every((t) => t > to + TAIL_MS));
    }
    const entry = parse(line);
    if (!entry || entry["type"] !== "assistant") return true;
    const at = timeOf(entry);
    if (Number.isNaN(at) || at < from || at > to) return true;
    if (!sidechainFile && entry["isSidechain"] === true) return true;
    // 後に始まった開いている Run の ID が先に出ていれば、その応答はそちらに数える
    if (!claims.owns(at)) {
      result.ceded = true;
      return true;
    }
    const message = entry["message"] as Record<string, unknown> | undefined;
    if (!message) return true;
    const key = String(message["id"] ?? entry["requestId"] ?? entry["uuid"] ?? line);
    // 同じ応答の tool_use は別の行に分かれて書かれるので、使用量より先に行ごとに積む
    addTools(result.tools, message, key);
    const usage = message["usage"];
    if (typeof usage !== "object" || usage === null) return true;
    // 同じ応答の行は後の行が最終の値を持つ
    result.messages.set(key, { usage: usage as Record<string, unknown>, model: message["model"] });
    return true;
  };
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const more = take(line);
    // ほかの Run の ID はその行の後の応答から効く
    claims.see(line);
    if (!more) break;
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
  skillDirs: {
    project: (topLevel) => path.join(topLevel, ".claude", "skills"),
    personal: (env) => path.join(homeDir(env), ".claude", "skills"),
  },
  async readTranscriptUsage(query) {
    const projects = path.join(configDir(query.env), "projects");
    // 時刻は秒までなので、終わりはその秒の終わりまで含める
    const from = Date.parse(query.run.started_at);
    const to = Date.parse(query.finishedAt) + 999;
    let best: Scan | undefined;
    let bestFile = "";
    const read: OverlapClaims[] = [];
    const scanned = new Set<string>();
    // session のファイルに Run がなければ（別のセッションの環境を受け継いだなど）、作業ツリーから探す
    for (const candidates of [sessionCandidates, worktreeCandidates]) {
      if (best) break;
      for (const file of await candidates(query, projects)) {
        if (scanned.has(file)) continue;
        scanned.add(file);
        const s = await scan(file, query, from, to).catch(() => undefined);
        if (s) read.push(s.claims);
        if (s?.firstSeen === undefined || seenAfterRun(s.firstSeen, to)) continue;
        if (!best || s.firstSeen < (best.firstSeen ?? Infinity)) [best, bestFile] = [s, file];
      }
    }
    // 譲る相手がいれば、探す範囲の外（別の worktree など）も含む projects/ の下のすべてで、その ID が先に出たファイルを探す。
    // ID は dg run start が作るので、最も早く出たファイルがその Run を始めた記録で、その Run の Adapter もそこに結び付ける
    if (best && best.claims.claimants.size > 0) {
      for (const file of await allCandidates(query, projects)) {
        if (scanned.has(file)) continue;
        const c = await sightings(file, query, from, to).catch(() => undefined);
        if (c) read.push(c);
      }
    }
    // ほかのファイルで ID が先に出た Run には譲らずに読み直す
    const elsewhere = best ? claimedElsewhere(best.claims, read) : new Set<string>();
    if (elsewhere.size > 0) {
      best = await scan(bestFile, query, from, to, elsewhere).catch(() => undefined);
    }
    if (!best) {
      return none(
        `Claude Code の会話記録に Run ${query.run.id} が見つからない。使用量は null で残す`,
      );
    }
    if (best.messages.size === 0 && !best.ceded) {
      return none(
        `Claude Code の会話記録に Run ${query.run.id} の期間の応答がない。使用量は null で残す`,
      );
    }
    return {
      // 期間の応答をすべて後に始めた Run に譲ったなら、この Run の量は 0
      usage:
        best.messages.size === 0
          ? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
          : sum(best.messages),
      model: mainModel(best.messages),
      tools: tallyTools(best.tools.values()),
      warnings: [],
    };
  },
};
