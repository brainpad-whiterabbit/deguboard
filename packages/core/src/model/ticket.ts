// Ticket の frontmatter（tickets/t12.md。requirements.md 5.4）

import { z } from "zod";
import {
  isoDateTime,
  isTerminal,
  slugSchema,
  STATUSES,
  statusSchema,
  type Status,
} from "./common.js";
import { epicIdSchema, iterationIdSchema, ticketIdSchema, type TicketId } from "./id.js";

export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

// スキーマにないキーは looseObject で残す（DT-2）。Workflow の fields の値もここを通る
const ticketFrontmatter = z.looseObject({
  id: ticketIdSchema,
  project: slugSchema,
  title: z.string().min(1),
  status: statusSchema,
  priority: z.enum(PRIORITIES).default("medium"),
  labels: z.array(z.string()).default([]),
  iteration: iterationIdSchema.optional(),
  epic: epicIdSchema.optional(),
  depends_on: z.array(ticketIdSchema).default([]),
  workflow: slugSchema.optional(),
  /** 起票者。`eiki` か `eiki/agent`（TK-7）。古いファイルにはない */
  created_by: z.string().optional(),
  /** 担当者。claim で付き、todo / abandoned で消える（ST-3、ST-8） */
  assignee: z.string().optional(),
  /** 旧名。読むときに assignee へ読み替え、assignee を書く操作が消す */
  claimed_by: z.string().optional(),
  branch: z.string().optional(),
  /** `branch` を記録した時刻。照合はこれより前にマージされた PR を根拠にしない（ST-6）。古いファイルにはない */
  branch_at: isoDateTime.optional(),
  pr: z.number().int().positive().optional(),
  provisional: z.boolean().optional(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export const ticketSchema = ticketFrontmatter.transform(({ claimed_by, ...t }) => {
  const assignee = t.assignee ?? claimed_by;
  return assignee === undefined ? t : { ...t, assignee };
});
export type Ticket = z.output<typeof ticketSchema>;

/** チケットの集まりの進み（Epic・Plan の進捗、カンバンの見出し）。done の件数、abandoned を除く件数、Status ごとの件数（EP-3） */
export interface Progress {
  total: number;
  done: number;
  by_status: Record<Status, number>;
}

/** 進みを数える。数え方はここだけに置く（web は core の実行時のコードを取り込まないので写し、テストで同じ結果になることを確かめる） */
export function progressOf(tickets: readonly Pick<Ticket, "status">[]): Progress {
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const t of tickets) by_status[t.status] += 1;
  return { total: tickets.length - by_status.abandoned, done: by_status.done, by_status };
}

/**
 * depends_on の残りの待ちの相手（WF-2）。done・abandoned でない依存先を depends_on の順で返す。
 * statusOf は依存先の Status を引き、見つからない依存先（undefined）も待ちに数える。deps_done・ticket.show の pending_deps・Plan の待ち（PL-6）はここだけを使う
 */
export function pendingDeps(
  ticket: Pick<Ticket, "depends_on">,
  statusOf: (id: TicketId) => Status | undefined,
): TicketId[] {
  return ticket.depends_on.filter((id) => {
    const status = statusOf(id);
    return status === undefined || !isTerminal(status);
  });
}

/** `## 受け入れ条件` の見出し行。節の切り出しと雛形で共有する */
const ACCEPTANCE_HEADING = /^## 受け入れ条件[ \t]*$/m;
/** チェックリストの 1 行。[1] が印、[2] が文 */
const CHECK_ITEM = /^- \[([ xX])\] (.*\S)[ \t]*$/gm;

/**
 * 本文の雛形（TK-3）。`## 概要` に summary を、`## 受け入れ条件` に acceptance の項目をチェックリストで置く。
 * 項目がなければ空の `- [ ] ` を 1 行置く（lint が空として指摘する）
 */
export function ticketBodyTemplate(summary = "", acceptance: readonly string[] = []): string {
  const items = acceptance.length === 0 ? ["- [ ] "] : acceptance.map((a) => `- [ ] ${a.trim()}`);
  return `## 概要\n\n${summary}\n\n## 受け入れ条件\n\n${items.join("\n")}\n`;
}

/**
 * 本文から `## 受け入れ条件` の節（見出しの次の行から、次の `## ` 見出しの手前か末尾まで）を返す。
 * 見出しがなければ undefined
 */
export function acceptanceSection(body: string): string | undefined {
  const range = acceptanceRange(body);
  return range && body.slice(range.start, range.end);
}

/** 節の本文の位置（見出しの次の文字から、次の見出しの手前か末尾まで） */
function acceptanceRange(body: string): { start: number; end: number } | undefined {
  const m = ACCEPTANCE_HEADING.exec(body);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const next = /^## /m.exec(body.slice(start));
  return { start, end: next ? start + next.index : body.length };
}

/**
 * `## 受け入れ条件` の節の項目を items で置き換えた本文を返す。他の節は変えない。
 * 同じ文の項目が済み（`- [x]`）なら印を保つ（TK-5）。節がなければ末尾に足す
 */
export function replaceAcceptance(body: string, items: readonly string[]): string {
  const range = acceptanceRange(body);
  const current = range ? body.slice(range.start, range.end) : "";
  const checked = new Set(
    [...current.matchAll(CHECK_ITEM)].filter((m) => m[1] !== " ").map((m) => m[2]),
  );
  const lines = items.map((raw) => {
    const text = raw.trim();
    return `- [${checked.has(text) ? "x" : " "}] ${text}`;
  });
  const section = `\n\n${lines.join("\n")}\n`;
  if (!range) {
    const sep = body === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return `${body}${sep}## 受け入れ条件${section}`;
  }
  // 次の節が続くなら空行で区切る
  const tail = range.end < body.length ? "\n" : "";
  return body.slice(0, range.start) + section + tail + body.slice(range.end);
}

/** 受け入れ条件の 1 項目。index は 1 始まりで、文のない行（雛形の `- [ ] `）は数えない */
export interface AcceptanceItem {
  index: number;
  text: string;
  checked: boolean;
}

/** 節の中のチェックリストの 1 行。[1] が印、[2] が文（空のこともある）。CRLF の本文は行末の \r を文に入れない */
const CHECK_LINE = /^- \[([ xX])\] (.*?)\r?$/;

/** 節を行に割り、文のある項目に番号を振る。節がなければ undefined */
function scanAcceptance(body: string) {
  const range = acceptanceRange(body);
  if (!range) return undefined;
  const lines = body.slice(range.start, range.end).split("\n");
  const items: (AcceptanceItem & { line: number })[] = [];
  lines.forEach((line, i) => {
    const m = CHECK_LINE.exec(line);
    const text = m?.[2]?.trim();
    if (!m || !text) return;
    items.push({ index: items.length + 1, text, checked: m[1] !== " ", line: i });
  });
  return { range, lines, items };
}

/**
 * `## 受け入れ条件` の節の項目を番号・文・済みで返す（TK-3）。
 * 節がなければ undefined、節はあるが項目がなければ []（lint の missing / empty の区別に使う）
 */
export function parseAcceptance(body: string): AcceptanceItem[] | undefined {
  return scanAcceptance(body)?.items.map(({ line: _line, ...item }) => item);
}

/**
 * 番号で指した項目の印だけを `[x]` か `[ ]` に書き換えた本文を返す（TK-5）。
 * 他の行・他の節は変えない。節がないか範囲外の番号は何もしない（検査は呼び手）
 */
export function setAcceptance(body: string, indexes: readonly number[], checked: boolean): string {
  const scan = scanAcceptance(body);
  if (!scan) return body;
  const targets = new Set(indexes);
  const lines = [...scan.lines];
  for (const item of scan.items) {
    if (!targets.has(item.index)) continue;
    lines[item.line] = lines[item.line]!.replace(/^- \[[ xX]\]/, `- [${checked ? "x" : " "}]`);
  }
  return body.slice(0, scan.range.start) + lines.join("\n") + body.slice(scan.range.end);
}
