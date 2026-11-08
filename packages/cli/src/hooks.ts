// dg hooks install / uninstall：harness の設定に dg hook を呼ぶフックを書く・外す（AG-5、ADR-025）。
// 書くイベントと設定のファイルは agent の Adapter の hooks が決める。手で足した他のフックは残し、dg のフックだけを入れ替える

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  hooksOf,
  readHookInput,
  resolveRepoPaths,
  type AgentEnv,
  type HookSupport,
} from "@deguboard/core";

/** dg が書いたフックのコマンドの終わり。これで見分けて入れ替える（基のコマンドが変わっても重ねない） */
const OURS = /(^|\s)--actor agent hook \S+( --agent \S+)? --payload -$/;

export interface HooksResult {
  agent: string;
  scope: "project" | "personal";
  /** 設定のファイルの絶対パス */
  file: string;
  /** 入れた（install）か外した（uninstall）イベント */
  events: string[];
  /** 設定が変わらなかった */
  unchanged: boolean;
  dryRun: boolean;
  /** --dry-run のときは書くことになる設定の全体 */
  content?: string | undefined;
}

/** dg のフックのコマンドの、dg を呼ぶ部分（前の部分が base） */
const HANDLER_TAIL = /\s--actor agent hook\s/;

/** ハンドラ（dg を呼ぶコマンド）の確かめの結果。ok 以外は警告にする */
export type HandlerStatus =
  /** `--version` が終了コード 0 で終わった */
  | "ok"
  /** 実行ファイルが見つからない（PATH に dg がない） */
  | "missing"
  /** 時間切れ */
  | "timeout"
  /** 起動できたが終了コードが 0 でない・起動に失敗した */
  | "failed"
  /** シェルの書き方（~・引用符・VAR=x など）を含み、シェルを通さずに確かめられない */
  | "unverified";

export interface HookCheckEvent {
  event: string;
  /** 設定に dg のフックがあり、matcher も一致する */
  installed: boolean;
  /** ハンドラの確かめ。フックがなければ null */
  handler: HandlerStatus | null;
  /** 直近に受け取った時刻。記録がなければ null（まだ呼ばれていない、またはリポジトリの外） */
  received_at: string | null;
  /** 直近の入力で、受け取らなかった（有無が false の）項目 */
  missing: string[];
}

export interface HooksCheckResult {
  agent: string;
  scope: "project" | "personal";
  /** 設定のファイルの絶対パス */
  file: string;
  events: HookCheckEvent[];
  /** 警告。JSON では最上位の warnings に出す */
  warnings: string[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };
type Group = { matcher?: string; hooks?: Array<Record<string, unknown>> } & Record<string, unknown>;

/** dg のフックのコマンド。base は dg を呼ぶコマンド（既定は dg） */
const commandFor = (base: string, agent: string, event: string) =>
  `${base} --actor agent hook ${event}${agent === "claude-code" ? "" : ` --agent ${agent}`} --payload -`;

/** 設定から dg のフックを除く。空になった群とイベントも除く */
function withoutOurs(hooks: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = (groups as Group[])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter(
          (h) => !(typeof h["command"] === "string" && OURS.test(h["command"])),
        ),
      }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) next[event] = kept;
  }
  return next;
}

async function readSettings(file: string): Promise<Settings> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined || text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} は JSON のオブジェクトでない`);
  return parsed as Settings;
}

const execFileAsync = promisify(execFile);
/** シェルの書き方（~・引用符・展開・パイプなど）。シェルを通さないと確かめられない */
const SHELL_ONLY = /[~'"`$\\|&;<>()*?]/;
/** 先頭の VAR=x（シェルの代入） */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** dg を呼ぶコマンドが `--version` で動くかを確かめる。空白で割った先頭を execFile で実行し、シェルは通さない */
async function handlerStatus(base: string): Promise<HandlerStatus> {
  const parts = base.split(/\s+/).filter((p) => p !== "");
  // シェルでしか意味を持たない書き方は、シェルを通さずに実行すると別の結果になるので確かめない
  if (parts.length === 0 || SHELL_ONLY.test(base) || ASSIGNMENT.test(parts[0]!))
    return "unverified";
  const [file, ...args] = parts;
  try {
    await execFileAsync(file!, [...args, "--version"], { timeout: 15_000 });
    return "ok";
  } catch (error) {
    const e = error as { code?: unknown; killed?: unknown };
    if (e.code === "ENOENT") return "missing";
    if (e.killed === true) return "timeout";
    return "failed";
  }
}

function support(agent: string): HookSupport {
  const hooks = hooksOf(agent);
  if (!hooks) throw new Error(`agent ${agent} にはフックがない`);
  return hooks;
}

async function settingsFile(
  hooks: HookSupport,
  options: { cwd: string; scope: "project" | "personal"; env: AgentEnv },
): Promise<string> {
  return options.scope === "personal"
    ? hooks.settings.personal(options.env)
    : hooks.settings.project((await resolveRepoPaths(options.cwd)).topLevel);
}

/** フックを入れる。もう一度実行しても重ならない（dg のフックを入れ替える） */
export async function installHooks(options: {
  cwd: string;
  scope: "project" | "personal";
  env: AgentEnv;
  agent?: string;
  /** dg を呼ぶコマンド。PATH に dg がなければ npx deguboard など */
  command?: string | undefined;
  dryRun?: boolean;
}): Promise<HooksResult> {
  const agent = options.agent ?? "claude-code";
  const hooks = support(agent);
  const file = await settingsFile(hooks, options);
  const current = await readSettings(file);
  const base = options.command ?? "dg";
  const next: Record<string, unknown> = withoutOurs(current.hooks ?? {});
  for (const { event, matcher } of hooks.events) {
    const groups = Array.isArray(next[event]) ? [...(next[event] as Group[])] : [];
    groups.push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: commandFor(base, agent, event) }],
    });
    next[event] = groups;
  }
  return write(file, current, next, {
    agent,
    scope: options.scope,
    events: hooks.events.map((e) => e.event),
    dryRun: options.dryRun ?? false,
  });
}

/**
 * フックの状態を確かめる：設定に dg のフックが入っているか（イベントごと・matcher）、ハンドラが動くか、直近の入力に
 * 受け取らなかった項目があるか（deguboard-local/hook-inputs/ の記録。値は見ない）。欠けていれば警告にする
 */
export async function checkHooks(options: {
  cwd: string;
  scope: "project" | "personal";
  env: AgentEnv;
  agent?: string;
}): Promise<HooksCheckResult> {
  const agent = options.agent ?? "claude-code";
  const hooks = support(agent);
  const file = await settingsFile(hooks, options);
  // 入力の記録はリポジトリの中にある。個人の設定をリポジトリの外で見るときは確かめずに飛ばす
  const localDir = await resolveRepoPaths(options.cwd).then(
    (paths) => paths.localDir,
    () => undefined,
  );
  const warnings: string[] = [];
  let current: Settings = {};
  try {
    current = await readSettings(file);
  } catch (error) {
    warnings.push(`設定を読めない（${error instanceof Error ? error.message : String(error)}）`);
  }
  const statuses = new Map<string, Promise<HandlerStatus>>();
  const events: HookCheckEvent[] = [];
  for (const { event, matcher } of hooks.events) {
    const groups = Array.isArray(current.hooks?.[event]) ? (current.hooks?.[event] as Group[]) : [];
    // dg のフックを持つ群と、そのコマンド
    const ours = groups
      .map((group) => ({
        group,
        command: (group.hooks ?? [])
          .map((h) => h["command"])
          .find((c): c is string => typeof c === "string" && OURS.test(c)),
      }))
      .find((x) => x.command !== undefined);
    const command = ours?.command;
    const installed =
      command !== undefined && (matcher === undefined || ours?.group.matcher === matcher);
    if (command !== undefined && !installed)
      warnings.push(
        `${event} のフックの matcher が「${ours?.group.matcher ?? "（なし）"}」。「${matcher}」であるべき（dg hooks install で入れ直す）`,
      );
    let handler: HandlerStatus | null = null;
    if (command !== undefined) {
      const m = HANDLER_TAIL.exec(command);
      const base = (m ? command.slice(0, m.index) : command).trim();
      if (!statuses.has(base)) statuses.set(base, handlerStatus(base));
      handler = await statuses.get(base)!;
    }
    const record = localDir === undefined ? undefined : await readHookInput(localDir, event);
    const missing = Object.entries(record?.fields ?? {})
      .filter(([, present]) => !present)
      .map(([field]) => field);
    if (record !== undefined && missing.length > 0)
      warnings.push(
        `${event} の直近の入力（${record.received_at}）に ${missing.join("・")} がない。Claude Code の入力の形が変わった可能性があり、この項目を使う記録（Run など）が取れていないかもしれない`,
      );
    events.push({ event, installed, handler, received_at: record?.received_at ?? null, missing });
  }
  const absent = events.filter((e) => !e.installed).map((e) => e.event);
  if (absent.length === hooks.events.length)
    warnings.push("設定に dg のフックがない（dg hooks install で入れる）");
  else if (absent.length > 0)
    warnings.push(
      `設定に dg のフックがないイベント：${absent.join("・")}（dg hooks install で入れ直す）`,
    );
  for (const [base, status] of statuses) {
    const verdict = await status;
    if (verdict === "ok") continue;
    const text: Record<Exclude<HandlerStatus, "ok">, string> = {
      missing: "見つからない（PATH に dg がない。npx なら dg hooks install --command で直す）",
      timeout: "--version が時間切れ（15 秒）",
      failed: "--version が異常終了した（起動に失敗したか終了コードが 0 でない）",
      unverified:
        "シェルの書き方（~・引用符・VAR=x など）を含むので確かめられない。単純なコマンドで dg hooks install --command し直すと確かめられる",
    };
    warnings.push(`ハンドラ「${base}」：${text[verdict]}`);
  }
  return { agent, scope: options.scope, file, events, warnings };
}

/** dg のフックを外す。手で足したフックは残す */
export async function uninstallHooks(options: {
  cwd: string;
  scope: "project" | "personal";
  env: AgentEnv;
  agent?: string;
  dryRun?: boolean;
}): Promise<HooksResult> {
  const agent = options.agent ?? "claude-code";
  const hooks = support(agent);
  const file = await settingsFile(hooks, options);
  const current = await readSettings(file);
  const next = withoutOurs(current.hooks ?? {});
  return write(file, current, next, {
    agent,
    scope: options.scope,
    events: hooks.events.map((e) => e.event),
    dryRun: options.dryRun ?? false,
  });
}

async function write(
  file: string,
  current: Settings,
  hooks: Record<string, unknown>,
  meta: Pick<HooksResult, "agent" | "scope" | "events" | "dryRun">,
): Promise<HooksResult> {
  const { hooks: _old, ...rest } = current;
  const settings = Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const before = `${JSON.stringify(current, null, 2)}\n`;
  // 整形だけの違いでは書き直さない
  const unchanged = isDeepStrictEqual(settings, current) || content === before;
  if (!meta.dryRun && !unchanged) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return { ...meta, file, unchanged, ...(meta.dryRun ? { content } : {}) };
}
