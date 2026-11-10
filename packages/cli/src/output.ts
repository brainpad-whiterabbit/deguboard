// 人向けの出力と --json。どちらも core の CommandResult をそのまま写す

import {
  formatIssue,
  type AskView,
  type CommandResult,
  type Issue,
  type WriteOutcome,
} from "@deguboard/core";
import type { ErrorView } from "./errors.js";

export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

type Row = Record<string, unknown>;

export function printJsonResult(streams: Streams, result: CommandResult<unknown>): void {
  streams.out(
    JSON.stringify(
      { ok: true, data: result.data, warnings: result.warnings, write: result.write ?? null },
      null,
      2,
    ),
  );
}

export function printJsonError(streams: Streams, error: ErrorView): void {
  const { exitCode: _exitCode, ...rest } = error;
  streams.out(JSON.stringify({ ok: false, error: rest }, null, 2));
}

export function printError(streams: Streams, error: ErrorView): void {
  streams.err(`Error: ${error.message}`);
  if (error.detail) streams.err(indent(error.detail));
}

/** 人向けの出力。コマンド名で形を選ぶ */
export function printHuman(
  streams: Streams,
  commandName: string,
  result: CommandResult<unknown>,
): void {
  const data = result.data;
  const group = commandName.split(".")[0] ?? "";
  if (commandName === "hook") {
    // フックの標準出力は harness が会話に足しうる（SessionStart など）ので、何も出さず標準エラーにだけ書く
    const view = data as { done?: string[]; output?: string } | undefined;
    for (const line of view?.done ?? []) streams.err(`dg hook: ${line}`);
    // ツールの使用を拒むときの文（製品の形）だけは標準出力に書き、harness が読む
    if (view?.output) streams.out(view.output);
  } else if (commandName === "ask" && isAskView(data)) {
    // 依頼文はそのまま貼れるよう標準出力に文だけを出し、候補は標準エラーに出す
    streams.out(data.text);
    streams.err(
      `Candidates: ${data.candidates.map((c) => `${c.recommended ? "★" : ""}${c.label} (${c.action})`).join(", ")}`,
    );
  } else if (commandName === "ticket.claim" && isClaimView(data)) {
    // 開いた Run の ID は控えるものなので、本文の後の最後の行に出す
    const { run, ...rest } = data;
    streams.out(record(rest));
    if (run) streams.out(`run: ${run}`);
  } else if (isIssueReport(data)) {
    if (data.issues.length === 0) streams.out("No issues");
    for (const issue of data.issues) streams.out(formatIssue(issue));
  } else if (Array.isArray(data)) {
    if (data.length === 0) streams.out("(none)");
    else streams.out(table(data as Row[], columnsFor(group)));
  } else if (data && typeof data === "object") {
    streams.out(record(data as Row));
  } else if (data !== undefined) {
    streams.out(String(data));
  }
  for (const w of result.warnings) streams.err(`Warning: ${w}`);
  if (result.write) streams.err(describeWrite(result.write));
}

function isAskView(data: unknown): data is Pick<AskView, "text" | "candidates"> {
  return typeof data === "object" && data !== null && "text" in data && "candidates" in data;
}

function isClaimView(data: unknown): data is Row & { run: string | null } {
  return typeof data === "object" && data !== null && "run" in data;
}

function isIssueReport(data: unknown): data is { ok: boolean; issues: Issue[] } {
  return (
    typeof data === "object" &&
    data !== null &&
    "issues" in data &&
    Array.isArray((data as { issues: unknown }).issues)
  );
}

/** 結果が ok: false を持てば終了コード 1（validate・lint・workflow validate） */
export function exitCodeOf(result: CommandResult<unknown>): number {
  const data = result.data as { ok?: unknown } | null;
  return data && typeof data === "object" && data.ok === false ? 1 : 0;
}

function describeWrite(write: WriteOutcome): string {
  if (!write.committed) return "Left in the working tree (commit with dg commit or dg sync)";
  const parts = ["Committed"];
  parts.push(write.pushed ? "pushed" : "not pushed (the next dg sync sends it)");
  if (write.provisional) parts.push("provisional number");
  return parts.join(", ");
}

const COLUMNS: Record<string, string[]> = {
  ticket: ["id", "status", "priority", "title", "labels", "iteration", "epic", "assignee"],
  epic: ["id", "status", "title", "progress"],
  iteration: ["id", "status", "name", "start", "end"],
  project: ["id", "status", "name", "workflow"],
  workflow: ["id", "name", "path"],
  plan: ["id", "status", "project", "tickets", "progress"],
  // dg metrics show の単位ごとの集計
  groups: [
    "key",
    "runs",
    "results",
    "retries",
    "duration_seconds",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "tools",
    "missing",
    "estimated_runs",
    "reviews",
  ],
  // dg history の events
  events: ["at", "id", "type", "changes", "subject"],
};

function columnsFor(group: string): string[] | undefined {
  return COLUMNS[group];
}

function cell(key: string, row: Row): string {
  const v = row[key];
  if (v === undefined || v === null) return "";
  if (key === "id" && row["provisional"] === true) return `${String(v)}*`;
  if (key === "progress" && typeof v === "object") {
    const p = v as { done: number; total: number };
    return `${p.done}/${p.total}`;
  }
  if (key === "tickets" && Array.isArray(v))
    return `${v.length} ${v.length === 1 ? "item" : "items"}`;
  if (key === "changes" && Array.isArray(v))
    return (v as { field: string; from: string | null; to: string | null }[])
      .map((c) => `${c.field}: ${c.from ?? "-"} → ${c.to ?? "-"}`)
      .join(", ");
  if (Array.isArray(v)) return v.map(String).join(",");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function table(rows: Row[], columns?: string[]): string {
  const cols = (columns ?? Object.keys(rows[0] ?? {})).filter((c) =>
    rows.some((r) => r[c] !== undefined && r[c] !== null),
  );
  const cells = rows.map((r) => cols.map((c) => cell(c, r)));
  const widths = cols.map((c, i) => Math.max(width(c), ...cells.map((row) => width(row[i] ?? ""))));
  const line = (values: string[]) =>
    values
      .map((v, i) => pad(v, widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(cols), ...cells.map(line)].join("\n");
}

/** show 系の出力。入れ子のオブジェクトは `key.sub: value`、オブジェクトの配列は表、body は最後に本文として出す */
function record(data: Row, prefix = ""): string {
  const { body, ...rest } = data;
  const lines: string[] = [];
  const tables: string[] = [];
  for (const [k, v] of Object.entries(rest)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => x && typeof x === "object" && !Array.isArray(x))
    ) {
      const group = columnsFor(k) ? k : guessGroup(v[0] as Row);
      tables.push(`${prefix}${k}:`, indent(table(v as Row[], columnsFor(group))));
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      lines.push(record(v as Row, `${prefix}${k}.`));
    } else {
      lines.push(`${prefix}${k}: ${formatValue(v)}`);
    }
  }
  if (tables.length > 0) lines.push("", ...tables);
  if (typeof body === "string" && body.trim()) lines.push("", body.trimEnd());
  return lines.join("\n");
}

/** 行の形から表の列を選ぶ（チケットの配列なら ticket の列） */
function guessGroup(row: Row): string {
  const id = String(row["id"] ?? "");
  return id.startsWith("t")
    ? "ticket"
    : id.startsWith("e")
      ? "epic"
      : id.startsWith("s")
        ? "iteration"
        : "";
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v))
    return v.length === 0
      ? "[]"
      : v.every((x) => typeof x !== "object")
        ? v.map(String).join(", ")
        : JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 全角を 2 として表示幅を数える（表の列を揃えるため） */
function width(text: string): number {
  let w = 0;
  for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(text: string, to: number): string {
  return text + " ".repeat(Math.max(0, to - width(text)));
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
