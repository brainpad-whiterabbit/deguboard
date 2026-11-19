// Claude Code の Adapter（AG-5・MT-2、ADR-029）。会話記録（<設定>/projects/<作業ディレクトリ>/<session>.jsonl）から使用量とツールの回数を補う。
//   - 記録の場所があるとき（query.transcript。このマシンの deguboard-local/transcripts/）：そのファイルだけを、ID の出現を待たずに数える。
//     サブエージェントの記録（<session>/subagents/ の下。1 つの依頼で 1 ファイル）はファイルの先頭から、親のセッションのファイルは
//     ほかの Run と共有するので started_at から。同じファイルを先に使った Run が閉じていれば、その finished_at の後から（続けて頼まれた
//     サブエージェントの手直しなど）。ファイルを読めなければ（別のマシンの記録・消された）推測に落とさず null で残す
//   - 場所がなくセッション ID（Run の session）があるとき：探す範囲をそのセッションの記録（<session>.jsonl と <session>/subagents/ の下）に絞り、
//     下の推測で選ぶ。このマシンにそのセッションの記録がなければ null で残す
//   - どちらもないときの Run に結び付ける記録（推測）：探す範囲で Run の ID を最も早く含む会話記録のファイル（bindFile）。dg run start の出力を受け取ったエージェントの
//     記録になり、run start の警告などで後から ID を見ただけのファイルは選ばない。ID が最初に出たのが finished_at より後のファイル
//     （閉じた後に run refresh を呼んだセッションなど）は除く。同じ時刻なら、ファイルのパスの順で選ぶ（呼ぶ session によらない）。
//     サブエージェントは親と同じ session の subagents/ に別のファイルを持ち、作業ディレクトリと時刻だけでは並行するエージェントと区別できない
//   - 数える行：そのファイルの assistant の行のうち、Run の ID が出た後の started_at〜finished_at のもの。同じ応答が複数行に
//     分かれるので message.id で重ねない。subagents/ の外のファイルの isSidechain の行（古い版が親のファイルに書くサブエージェントの行）は数えない。
//     同じファイルで期間が重なるほかの Run があれば、応答は ID が先に出ていて開いている Run のうち最も新しく始まったものにだけ数える（OverlapClaims）。
//     ほかのファイルで ID が同じか先に出た Run には譲らない（その Run の記録はそちらのファイル）。すべて譲ったら量は 0
//   - 探す範囲：projects/ の下のすべて（別の worktree・別のディレクトリで始めたセッションも）のうち、started_at より後に書かれたファイル。
//     どのファイルも Run の ID と譲る相手の ID が最初に出るまでと、finished_at を過ぎるまでしか読まない。数える行を読むのは選んだファイルだけ
//   - ツールの回数：数える行の message.content の tool_use を、tool_use の id で重ねずに名前で種類に分けて数える（TOOL_KINDS）。
//     最初に書く（write）までの読む・探すも数える。Bash はコマンドで種類を分けない
//   - 検査とテストを回していた区間（checks）：数える行の Bash の tool_use のうち、コマンド（input.command）が数えるコマンド
//     （query.checkCommands。見分けは check-commands.ts の isCheckCommand）で、背後で回す印（input.run_in_background が true）の
//     ないものを、tool_use の行の時刻から、その結果（tool_use_id の合う tool_result）の行の時刻までの区間にする。
//     結果の見つからない呼び出し（中断された、記録が切れた）は区間にしない。コマンドの文字列は見分けに使うだけで返さない（MT-4）。
//     query.checkCommands がなければ数えない（null）
//   - 失敗した呼び出しの数（tools.errors）：数えた tool_use の結果（user の行の message.content の tool_result）のうち、失敗の印
//     （is_error が true）のあるものを、tool_use_id で重ねずに数える。落ちたコマンド・当たらなかった Edit のほか、許可を断られた呼び出しと
//     hook に拒まれた呼び出しにも Claude Code が同じ印を付ける（2026-11-14 に Claude Code 2.1 の記録で確かめた）。読むのは印だけで、
//     結果の文（content）は読まない。成功した結果は印がないか false。数えた呼び出しがあるのに結果が 1 つも見つからない記録は、
//     印を読めないものとして errors を書かない（0 にしない）
//   - 待ちの区間（readTranscriptWaits）：サブエージェントの記録（記録の場所が <session>/subagents/ の下）の、親の依頼を待った空き。
//     入力の行（user の行のうち tool_result を持たないもの）の出どころを origin.kind で見分け、coordinator（親が続きを頼んだ依頼）の
//     入力では、その前の user・assistant の行の時刻から入力の時刻までを待ちにする。origin のない入力（最初の依頼と harness の催促）・
//     task-notification（自分のバックグラウンドのコマンドの通知）・human・peer の入力で続いた空きは作業。tool_use から tool_result までは
//     入力で区切られないので作業で、結果の返っていない tool_use が残っている間に来た coordinator の入力までの空きも作業にする。
//     読むのは行の種類・時刻・origin.kind・tool_use と tool_result の id だけで、入力の文は読まない。知らない形の入力（知らない
//     origin.kind、origin が物でない、content が文字列でも配列でもない）が 1 つでもあれば、推し量らずに null と警告にする。
//     親のセッションの記録・場所のない Run（親が自分で開いた Run）は、人の入力を待つ間と作業を分けられないので null（警告はしない）。
//     読めないファイルも null（使用量の取り込みが同じ理由を警告するので、警告を重ねない）。
//     止まった応答の途中で届いた coordinator の入力は直前の行からの短い空きを待ちに数える（項目では見分けられない）
//     （2026-11-15 に Claude Code 2.1 の記録で origin.kind の 4 種類を確かめた）
//   - 返すのは数・区間の時刻とモデル名だけ。会話の中身・コマンド・パスは返さない（MT-4）。ツールは名前を種類に変えて数だけを返す
//   - 判定（detect）：Claude Code は実行するコマンドの環境に CLAUDECODE=1 と AI_AGENT（claude-code_<版>_<種類> の形）を付ける。
//     どちらかがあれば Claude Code が呼んだとみなす（2026-11 に Claude Code 2.1 の Bash の環境で確かめた）
//   - セッション（sessionFromEnv）：Claude Code は Bash の環境に CLAUDE_CODE_SESSION_ID を付ける。サブエージェントの Bash にも
//     親のセッションの ID（フックの session_id、記録の <session>/subagents/ の <session> と同じ）で付く。SessionStart のフックが
//     入れる DEGUBOARD_SESSION はサブエージェントの Bash に届かないので、こちらで補う（2026-11-08 に Claude Code 2.1.319 で確かめた）

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ToolKind, WaitInterval } from "../../model/run.js";
import { isCheckCommand, type CheckCommands } from "../check-commands.js";
import type { AgentAdapter, AgentEnv, CollectedUsage, UsageQuery } from "../define.js";
import {
  bindFile,
  claimedElsewhere,
  count,
  fresh,
  homeDir,
  list,
  none,
  OverlapClaims,
  parse,
  tallyTools,
  TAIL_MS,
  timeOf,
  TIMESTAMPS,
} from "./transcript.js";
import { claudeCodeHooks, claudeConfigDir } from "./claude-code-hooks.js";

type Counts = CollectedUsage["usage"];

const configDir = claudeConfigDir;

/** 作業ディレクトリから projects/ の下のディレクトリ名を作る（英数字以外を - にする） */
export function projectDirName(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/** projects/ の下の 1 つのディレクトリの会話記録と、そのサブエージェントの会話記録 */
async function projectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await list(dir)) {
    if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
    else {
      const sub = path.join(dir, entry, "subagents");
      for (const f of await list(sub)) if (f.endsWith(".jsonl")) files.push(path.join(sub, f));
    }
  }
  return files;
}

/** projects/ の下のすべての会話記録のうち、started_at より後に書かれたもの */
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
  /** 結果の見つかった tool_use の id ごとの、失敗の印（is_error）があったか */
  results: Map<string, boolean>;
  /** 検査とテストに数える前景の Bash の tool_use の id ごとの、呼び出しの時刻と結果の時刻（結果がまだなら to は undefined） */
  checks: Map<string, { from: number; to: number | undefined }>;
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

/**
 * user の行の tool_result を、数えた tool_use（tools）の結果だけ、tool_use_id をキーにして失敗の印で積む。
 * 読むのは tool_use_id と is_error だけで、結果の文（content）は読まない。ほかの Run に数えた呼び出しの結果は積まない
 */
function addResults(scan: Pick<Scan, "tools" | "results">, message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return;
  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const id = b["tool_use_id"];
    if (b["type"] !== "tool_result" || typeof id !== "string" || !scan.tools.has(id)) continue;
    // 同じ結果が複数の行にあっても 1 回。どれかに印があれば失敗
    scan.results.set(id, scan.results.get(id) === true || b["is_error"] === true);
  }
}

/**
 * 応答（時刻 at）の中の Bash の tool_use のうち、検査とテストに数える前景のコマンドを、id をキーにして呼び出しの時刻で積む。
 * 同じ id は最初の行の時刻を残す。id のない tool_use は結果と結べないので積まない
 */
function addCheckStarts(
  checks: Scan["checks"],
  message: Record<string, unknown>,
  at: number,
  counted: CheckCommands,
): void {
  const content = message["content"];
  if (!Array.isArray(content)) return;
  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const id = b["id"];
    if (b["type"] !== "tool_use" || b["name"] !== "Bash" || typeof id !== "string") continue;
    const input = b["input"];
    if (checks.has(id) || typeof input !== "object" || input === null) continue;
    const { command, run_in_background: background } = input as Record<string, unknown>;
    if (typeof command !== "string" || background === true) continue;
    if (isCheckCommand(command, counted)) checks.set(id, { from: at, to: undefined });
  }
}

/** user の行（時刻 at）の tool_result のうち、積んだ検査とテストの呼び出しの結果に、結果の時刻を書く。同じ結果が複数の行にあれば最初の行 */
function addCheckEnds(checks: Scan["checks"], message: unknown, at: number): void {
  if (checks.size === 0 || Number.isNaN(at) || typeof message !== "object" || message === null)
    return;
  for (const id of blockIds(
    (message as Record<string, unknown>)["content"],
    "tool_result",
    "tool_use_id",
  )) {
    const check = checks.get(id);
    if (check && check.to === undefined) check.to = at;
  }
}

/** 結果の見つかった検査とテストの呼び出しの区間。結果のない呼び出しと、時刻が前後した呼び出しは入れない */
function checkIntervals(checks: Scan["checks"]): WaitInterval[] {
  const out: WaitInterval[] = [];
  for (const { from, to } of checks.values())
    if (to !== undefined && to > from) out.push({ from, to });
  return out;
}

/** 失敗した呼び出しの数。数えた呼び出しがあるのに結果が 1 つも見つからなければ、印を読めないものとして undefined */
function toolErrors(scan: Pick<Scan, "tools" | "results">): number | undefined {
  if (scan.tools.size > 0 && scan.results.size === 0) return undefined;
  let errors = 0;
  for (const failed of scan.results.values()) if (failed) errors += 1;
  return errors;
}

/**
 * file を読み、期間の応答を積む。fromStart なら Run の ID の出現を待たずに積む（記録の場所があるとき）。
 * fromStart でなければ、Run の ID が出た後の行だけを積む（推測で選んだファイル）
 */
async function scan(
  file: string,
  query: UsageQuery,
  from: number,
  to: number,
  elsewhere?: ReadonlySet<string>,
  fromStart = false,
): Promise<Scan> {
  const claims = new OverlapClaims(query, from, to, elsewhere);
  const result: Scan = {
    firstSeen: fromStart ? -Infinity : undefined,
    messages: new Map(),
    tools: new Map(),
    results: new Map(),
    checks: new Map(),
    ceded: false,
    claims,
  };
  // subagents/ の外のファイルでは、サブエージェントの行（isSidechain）は親の使用量でない
  const sidechainFile = isSubagentFile(file);
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
    // 数えた呼び出しの結果は、時刻で区切らず tool_use_id で結ぶ（期間の終わりの呼び出しの結果は finished_at の後に書かれうる）。
    // 読み終えるのは下の assistant の行の時刻で決まる
    if (result.tools.size > 0 && line.includes('"tool_result"')) {
      const entry = parse(line);
      if (entry?.["type"] === "user") {
        addResults(result, entry["message"]);
        addCheckEnds(result.checks, entry["message"], timeOf(entry));
        return true;
      }
    }
    if (!line.includes('"assistant"')) return true;
    // 期間に入る timestamp の文字列がない行は JSON.parse しない。最上位の timestamp は message の後にあり、
    // 入れ子の中にも同じキーがありうるので、すべてを候補にする
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
    if (query.checkCommands) addCheckStarts(result.checks, message, at, query.checkCommands);
    const usage = message["usage"];
    if (typeof usage !== "object" || usage === null) return true;
    // 同じ応答の行は後の行が最終の値を持つ
    result.messages.set(key, { usage: usage as Record<string, unknown>, model: message["model"] });
    return true;
  };
  const input = createReadStream(file);
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const more = take(line);
      // ほかの Run の ID はその行の後の応答から効く
      claims.see(line);
      if (!more) break;
    }
  } finally {
    input.destroy();
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

/** Claude Code が呼んだか。CLAUDECODE=1 か、AI_AGENT が claude-code か claude-code_ で始まる */
function detect(env: AgentEnv): boolean {
  const aiAgent = env["AI_AGENT"] ?? "";
  return (
    env["CLAUDECODE"] === "1" || aiAgent === "claude-code" || aiAgent.startsWith("claude-code_")
  );
}

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  detect,
  sessionFromEnv: (env) => env["CLAUDE_CODE_SESSION_ID"] || undefined,
  skillDirs: {
    project: (topLevel) => path.join(topLevel, ".claude", "skills"),
    personal: (env) => path.join(homeDir(env), ".claude", "skills"),
  },
  hooks: claudeCodeHooks,
  countsChecks: true,
  async readTranscriptUsage(query) {
    // 時刻は秒までなので、終わりはその秒の終わりまで含める
    const to = Date.parse(query.finishedAt) + 999;
    if (query.transcript) return fromLocation(query, query.transcript, to);
    const projects = path.join(configDir(query.env), "projects");
    const from = Date.parse(query.run.started_at);
    // 探す範囲は projects/ の下のすべて。呼ぶ session（finish と refresh で違う）によらずに同じファイルを選ぶ。
    // Run にセッション ID があれば、そのセッションの記録だけにする
    let files = await allCandidates(query, projects);
    const session = query.run.session;
    if (session) {
      files = files.filter((f) => inSession(f, session));
      if (files.length === 0) {
        return none(
          `The Claude Code conversation record has no session ${session} for Run ${query.run.id} (the record is on another machine, or it was deleted). Usage is left as null`,
        );
      }
    }
    const rivals = new OverlapClaims(query, from, to).rivals;
    const bound = await bindFile(query, files, to, rivals);
    let best: Scan | undefined;
    if (bound.file) {
      best = await scan(bound.file, query, from, to).catch(() => undefined);
      // ほかのファイルで ID が同じか先に出た Run には譲らずに読み直す
      const elsewhere = best ? claimedElsewhere(best.claims, bound.others) : new Set<string>();
      if (elsewhere.size > 0) {
        best = await scan(bound.file, query, from, to, elsewhere).catch(() => undefined);
      }
    }
    if (!best) {
      return none(
        `Run ${query.run.id} not found in the Claude Code conversation record. Usage is left as null`,
      );
    }
    return collected(query, best);
  },
  async readTranscriptWaits(query) {
    const file = query.transcript;
    // 親のセッションの記録と場所のない Run は、人の入力を待つ間と作業を分けられない
    if (!file || !isSubagentFile(file)) return { intervals: null, warnings: [] };
    const readable = await stat(file)
      .then((s) => s.isFile())
      .catch(() => false);
    // 読めないファイルは使用量の取り込み（fromLocation）が同じ理由を警告するので、ここでは重ねない
    if (!readable) return { intervals: null, warnings: [] };
    const intervals = await scanWaits(file, Date.parse(query.finishedAt) + 999);
    if (intervals) return { intervals, warnings: [] };
    return {
      intervals: null,
      warnings: [
        `The Claude Code conversation record has an input of an unknown form, so the waits are not counted. waited_seconds of Run ${query.run.id} is left as null`,
      ],
    };
  },
};

/** 入力の出どころ（origin.kind）のうち、形を知っているもの。coordinator だけが親の依頼で、ほかは待ちにしない */
const KNOWN_ORIGINS: ReadonlySet<string> = new Set([
  "coordinator",
  "task-notification",
  "human",
  "peer",
]);

/**
 * 入力の行（tool_result を持たない user の行）の出どころ。coordinator は親の依頼、other はほかの知っている形
 * （origin のない最初の依頼と harness の催促を含む）、undefined は知らない形
 */
function inputOrigin(entry: Record<string, unknown>): "coordinator" | "other" | undefined {
  const origin = entry["origin"];
  if (origin === undefined || origin === null) return "other";
  if (typeof origin !== "object") return undefined;
  const kind = (origin as Record<string, unknown>)["kind"];
  if (typeof kind !== "string" || !KNOWN_ORIGINS.has(kind)) return undefined;
  return kind === "coordinator" ? "coordinator" : "other";
}

/** content の中の、type が合うブロックの id（key の項目）。配列でなければ空 */
function blockIds(content: unknown, type: string, key: string): string[] {
  if (!Array.isArray(content)) return [];
  return (content as unknown[]).flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const b = block as Record<string, unknown>;
    return b["type"] === type ? [typeof b[key] === "string" ? b[key] : ""] : [];
  });
}

/**
 * サブエージェントの記録から、親の依頼を待った区間を読む（冒頭のコメントの「待ちの区間」）。知らない形の入力があれば undefined。
 * to（Run の終わり）を過ぎた user・assistant の行を 1 つ読んだところで読むのをやめる
 */
async function scanWaits(file: string, to: number): Promise<WaitInterval[] | undefined> {
  const intervals: WaitInterval[] = [];
  /** 直前の user・assistant の行の時刻 */
  let last = NaN;
  /** 結果の返っていない tool_use の id */
  const pending = new Set<string>();
  const input = createReadStream(file);
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      // 終わりを過ぎた行を 1 つ読んだら、その後の空きは Run の範囲に入らない。終わりをまたぐ待ち（PR の作成時刻などで
      // 閉じる Run。RN-6）は、終わりを過ぎた最初の行が親の依頼なら区間になり、閉じる側が終わりで切る
      if (last > to) break;
      // user・assistant のほかの行（api-request・attachment など）は JSON を読まない
      if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
      const entry = parse(line);
      const type = entry?.["type"];
      if (!entry || (type !== "user" && type !== "assistant")) continue;
      const at = timeOf(entry);
      if (Number.isNaN(at)) continue;
      const message = entry["message"];
      const content =
        typeof message === "object" && message !== null
          ? (message as Record<string, unknown>)["content"]
          : undefined;
      if (type === "assistant") {
        for (const id of blockIds(content, "tool_use", "id")) pending.add(id);
      } else {
        const results = blockIds(content, "tool_result", "tool_use_id");
        if (results.length > 0) {
          for (const id of results) pending.delete(id);
        } else {
          if (typeof content !== "string" && !Array.isArray(content)) return undefined;
          const origin = inputOrigin(entry);
          if (origin === undefined) return undefined;
          if (origin === "coordinator" && pending.size === 0 && at > last)
            intervals.push({ from: last, to: at });
          // 入力で次のターンが始まる。結果の返らなかった呼び出しは、もう待たない
          pending.clear();
        }
      }
      last = at;
    }
  } finally {
    input.destroy();
  }
  return intervals;
}

/** 積んだ応答から返す値。期間の応答がなければ null、すべて後に始めた Run に譲ったなら 0 */
function collected(query: UsageQuery, best: Scan): CollectedUsage {
  if (best.messages.size === 0 && !best.ceded) {
    return none(
      `The Claude Code conversation record has no responses in the period of Run ${query.run.id}. Usage is left as null`,
    );
  }
  return {
    usage:
      best.messages.size === 0
        ? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
        : sum(best.messages),
    model: mainModel(best.messages),
    tools: tallyTools(best.tools.values(), toolErrors(best)),
    checks: query.checkCommands ? checkIntervals(best.checks) : null,
    warnings: [],
  };
}

/** サブエージェントの記録（<session>/subagents/ の直下）か。設定のディレクトリの途中の同じ名前では判定しない */
const isSubagentFile = (file: string): boolean => file.split(path.sep).at(-2) === "subagents";

/** そのセッションの記録（<session>.jsonl か、<session>/subagents/ の下）か */
export function inSession(file: string, session: string): boolean {
  const parts = file.split(path.sep);
  if (parts.at(-1) === `${session}.jsonl`) return true;
  const sub = parts.lastIndexOf("subagents");
  return sub > 0 && parts[sub - 1] === session;
}

/**
 * 記録の場所（このマシンのパス）から数える。サブエージェントの記録はファイルの先頭（同じファイルを先に使って閉じた Run があれば
 * その finished_at の後）から、親のセッションの記録は started_at から finished_at まで。ファイルを読めなければ null で残す
 * （警告にパスは書かない。MT-4）
 */
async function fromLocation(query: UsageQuery, file: string, to: number): Promise<CollectedUsage> {
  const readable = await stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!readable) {
    return none(
      `Cannot read the file in the conversation record location of Run ${query.run.id} (deguboard-local/transcripts/) (the record is on another machine, or it was deleted). Usage is left as null`,
    );
  }
  const from = isSubagentFile(file) ? previousEnd(query, file) : Date.parse(query.run.started_at);
  const best = await scan(file, query, from, to, undefined, true).catch(() => undefined);
  if (!best) {
    return none(
      `Cannot read the file in the conversation record location of Run ${query.run.id} (deguboard-local/transcripts/). Usage is left as null`,
    );
  }
  return collected(query, best);
}

/**
 * 同じファイルを先に使った Run がいれば、その Run の分の後（なければ -Infinity。ファイルの先頭から）。
 * 続けて頼まれたサブエージェントは同じファイルに書き足すので、前の Run の応答を二重に数えない。
 * 前の Run が開いたままか、この Run の開始より後に閉じたなら、この Run の started_at から（重なる期間は OverlapClaims が分ける）
 */
function previousEnd(query: UsageQuery, file: string): number {
  const self = query.run;
  const started = Date.parse(self.started_at);
  let from = -Infinity;
  for (const [id, span] of query.others ?? []) {
    if (id === self.id || span.transcript !== file) continue;
    // 自分より前に始まった Run だけ。同じ秒なら ID の順で決める（OverlapClaims と同じ）
    const before =
      span.started_at < self.started_at ||
      (span.started_at === self.started_at && id.localeCompare(self.id) < 0);
    if (!before) continue;
    // 終わりは秒までなので、その秒の終わりまでが前の Run の分
    // この Run の開始の秒までに閉じていればその後から、そうでなければ開始から
    const end = span.finished_at === null ? Infinity : Date.parse(span.finished_at) + 1000;
    const boundary = end <= started + 1000 ? end : started;
    if (!Number.isNaN(boundary) && boundary > from) from = boundary;
  }
  return from;
}
