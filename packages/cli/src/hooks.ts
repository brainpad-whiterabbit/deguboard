// dg hooks install / uninstall：harness の設定に dg hook を呼ぶフックを書く・外す（AG-5、ADR-025）。
// 書くイベントと設定のファイルは agent の Adapter の hooks が決める。手で足した他のフックは残し、dg のフックだけを入れ替える。
// 既定は追跡しない local の設定に、動いている node と dg.js の絶対パスで書く（t698）。ハーネスがフックを動かす環境の PATH は
// 利用者のシェルと違いうる（node を mise・nvm・volta などで入れ、対話のシェルでだけ有効にしているなど）ので、PATH の dg や node に頼らない

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  hooksOf,
  hooksSilentWarning,
  readHookInput,
  resolveRepoPaths,
  UsageError,
  type AgentEnv,
  type HookSupport,
} from "@deguboard/core";

/** dg が書いたフックのコマンドの終わり。これで見分けて入れ替える（基のコマンドが変わっても重ねない） */
const OURS = /(^|\s)--actor agent hook \S+( --agent \S+)? --payload -$/;

/** 書く設定。local はリポジトリの追跡しない設定（既定）、project は追跡する設定（--shared）、personal は個人の設定 */
export type HookScope = "local" | "project" | "personal";

/** --personal・--shared から書く設定を選ぶ。両方は選べない */
export function hookScope(opts: { personal?: boolean; shared?: boolean }): HookScope {
  if (opts.personal && opts.shared)
    throw new UsageError("--personal and --shared cannot be given together");
  return opts.personal ? "personal" : opts.shared ? "project" : "local";
}

export interface HooksResult {
  agent: string;
  scope: HookScope;
  /** 設定のファイルの絶対パス */
  file: string;
  /** 入れた（install）か外した（uninstall）イベント */
  events: string[];
  /** 設定が変わらなかった */
  unchanged: boolean;
  dryRun: boolean;
  /** --dry-run のときは書くことになる設定の全体 */
  content?: string | undefined;
  /** 警告。JSON では最上位の warnings に出す */
  warnings: string[];
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
  /** シェルの書き方（~・単一引用符・VAR=x など）を含み、シェルを通さずに確かめられない */
  | "unverified"
  /** 命令の中の絶対パス（node や dg.js）がもうない。node を上げた・移したなど */
  | "gone";

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
  scope: HookScope;
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
    throw new Error(`${file} is not a JSON object`);
  return parsed as Settings;
}

const execFileAsync = promisify(execFile);
/** 引用しない語に現れるシェルの書き方（~・引用符・展開・パイプなど）。シェルを通さないと確かめられない */
const SHELL_ONLY = /[~'"`$\\|&;<>()*?]/;
/** 二重引用符で囲んだ語のうち、シェルが中身を変えないもの（展開・エスケープを含まない） */
const PLAIN_QUOTED = /^"([^"$`\\]*)"$/;
/** 先頭の VAR=x（シェルの代入） */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * シェルを通さずに同じ意味で実行できる語の並び。引用しない語と、中身を変えない二重引用符の語だけを受け付ける
 * （install が書く "<node>" "<dg.js>" の形はここを通る）。それ以外の書き方は undefined
 */
function plainWords(base: string): string[] | undefined {
  const words: string[] = [];
  for (const token of base.match(/"[^"]*"|\S+/g) ?? []) {
    const quoted = PLAIN_QUOTED.exec(token);
    if (quoted) words.push(quoted[1]!);
    else if (SHELL_ONLY.test(token)) return undefined;
    else words.push(token);
  }
  if (words.length === 0 || ASSIGNMENT.test(words[0]!)) return undefined;
  return words;
}

interface HandlerCheck {
  status: HandlerStatus;
  /** status が gone のとき、もうない絶対パス */
  gone: string[];
}

/** dg を呼ぶコマンドが `--version` で動くかを確かめる。語に割って先頭を execFile で実行し、シェルは通さない */
async function handlerStatus(base: string): Promise<HandlerCheck> {
  const words = plainWords(base);
  // シェルでしか意味を持たない書き方は、シェルを通さずに実行すると別の結果になるので確かめない
  if (!words) return { status: "unverified", gone: [] };
  // node を上げて install のときの絶対パスがなくなると、フックは黙って失敗する（t698）
  const gone = words.filter((w) => isAbsolute(w) && !existsSync(w));
  if (gone.length > 0) return { status: "gone", gone };
  const [file, ...args] = words;
  try {
    await execFileAsync(file!, [...args, "--version"], { timeout: 15_000 });
    return { status: "ok", gone: [] };
  } catch (error) {
    const e = error as { code?: unknown; killed?: unknown };
    if (e.code === "ENOENT") return { status: "missing", gone: [] };
    if (e.killed === true) return { status: "timeout", gone: [] };
    return { status: "failed", gone: [] };
  }
}

/** シェルの二重引用符で囲む（パスの空白のため）。展開やエスケープを含むパスは plainWords が確かめられないが、書くことはできる */
const doubleQuote = (s: string) => `"${s.replaceAll(/(["$`\\])/g, "\\$1")}"`;

/** このプロセスを動かしている dg の起動ファイル（bin/dg.js）の実パス。リンク（~/.local/bin/dg など）は辿る */
function dgScript(): string {
  return realpathSync(fileURLToPath(new URL("../bin/dg.js", import.meta.url)));
}

/**
 * 既定の、dg を呼ぶコマンド。追跡しない設定（local・personal）には、動いている node と dg.js の絶対パスを書き、PATH に頼らない。
 * 追跡する設定（project）はほかのマシンでも読まれるので、マシンのパスを書かずに PATH の dg を呼ぶ
 */
function defaultCommand(scope: HookScope): string {
  return scope === "project" ? "dg" : `${doubleQuote(process.execPath)} ${doubleQuote(dgScript())}`;
}

function support(agent: string): HookSupport {
  const hooks = hooksOf(agent);
  if (!hooks) throw new Error(`agent ${agent} has no hooks`);
  return hooks;
}

async function settingsFile(
  hooks: HookSupport,
  options: { cwd: string; scope: HookScope; env: AgentEnv },
): Promise<string> {
  if (options.scope === "personal") return hooks.settings.personal(options.env);
  const { topLevel } = await resolveRepoPaths(options.cwd);
  return options.scope === "local"
    ? hooks.settings.local(topLevel)
    : hooks.settings.project(topLevel);
}

/** 設定に dg のフックがあるか */
const hasOurs = (settings: Settings) =>
  Object.values(settings.hooks ?? {}).some(
    (groups) =>
      Array.isArray(groups) &&
      (groups as Group[]).some((g) =>
        (g.hooks ?? []).some((h) => typeof h["command"] === "string" && OURS.test(h["command"])),
      ),
  );

/**
 * 追跡しない設定に書くときの警告：そのファイルを git が無視していない（マシンのパスが共有されうる）、追跡する設定にも
 * dg のフックが残っている（両方が動き、追跡する方は動かないマシンで失敗する）
 */
async function installWarnings(
  hooks: HookSupport,
  options: { cwd: string; scope: HookScope },
  file: string,
): Promise<string[]> {
  if (options.scope === "project") return [];
  const topLevel = await resolveRepoPaths(options.cwd).then(
    (p) => p.topLevel,
    () => undefined,
  );
  if (topLevel === undefined) return [];
  const warnings: string[] = [];
  if (options.scope === "local") {
    const ignored = await execFileAsync("git", ["check-ignore", "-q", file], {
      cwd: topLevel,
    }).then(
      () => true,
      (e: { code?: unknown }) => (e.code === 1 ? false : undefined),
    );
    if (ignored === false)
      warnings.push(
        `${file} is not ignored by git. It holds this machine's paths to node and dg, so add it to .gitignore`,
      );
  }
  const shared = hooks.settings.project(topLevel);
  const sharedSettings = await readSettings(shared).catch(() => ({}) as Settings);
  if (hasOurs(sharedSettings))
    warnings.push(
      `${shared} (tracked) also has dg hooks, so both run, and the shared ones fail where their command cannot start. Remove them with dg hooks uninstall --shared`,
    );
  return warnings;
}

/** フックを入れる。もう一度実行しても重ならない（dg のフックを入れ替える） */
export async function installHooks(options: {
  cwd: string;
  scope: HookScope;
  env: AgentEnv;
  agent?: string;
  /** dg を呼ぶコマンド。省けば defaultCommand */
  command?: string | undefined;
  dryRun?: boolean;
}): Promise<HooksResult> {
  const agent = options.agent ?? "claude-code";
  const hooks = support(agent);
  const file = await settingsFile(hooks, options);
  const current = await readSettings(file);
  const base = options.command ?? defaultCommand(options.scope);
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
    warnings: await installWarnings(hooks, options, file),
  });
}

/**
 * フックの状態を確かめる：設定に dg のフックが入っているか（イベントごと・matcher）、ハンドラが動くか、直近の入力に
 * 受け取らなかった項目があるか（deguboard-local/hook-inputs/ の記録。値は見ない）。欠けていれば警告にする
 */
export async function checkHooks(options: {
  cwd: string;
  scope: HookScope;
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
    warnings.push(
      `Cannot read the settings (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const statuses = new Map<string, Promise<HandlerCheck>>();
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
        `The matcher of the ${event} hook is "${ours?.group.matcher ?? "(none)"}". It should be "${matcher}" (reinstall with dg hooks install)`,
      );
    let handler: HandlerStatus | null = null;
    if (command !== undefined) {
      const m = HANDLER_TAIL.exec(command);
      const base = (m ? command.slice(0, m.index) : command).trim();
      if (!statuses.has(base)) statuses.set(base, handlerStatus(base));
      handler = (await statuses.get(base)!).status;
    }
    const record = localDir === undefined ? undefined : await readHookInput(localDir, event);
    const missing = Object.entries(record?.fields ?? {})
      .filter(([, present]) => !present)
      .map(([field]) => field);
    if (record !== undefined && missing.length > 0)
      warnings.push(
        `The latest input for ${event} (${record.received_at}) lacks ${missing.join(", ")}. The shape of Claude Code's input may have changed, and records that use these fields (such as Runs) may not be captured`,
      );
    events.push({ event, installed, handler, received_at: record?.received_at ?? null, missing });
  }
  const absent = events.filter((e) => !e.installed).map((e) => e.event);
  if (absent.length === hooks.events.length)
    warnings.push("The settings have no dg hooks (install them with dg hooks install)");
  else if (absent.length > 0)
    warnings.push(
      `The settings have no dg hooks for these events: ${absent.join(", ")} (reinstall with dg hooks install)`,
    );
  for (const [base, status] of statuses) {
    const { status: verdict, gone } = await status;
    if (verdict === "ok") continue;
    const text: Record<Exclude<HandlerStatus, "ok">, string> = {
      missing:
        "not found (it is not on PATH. Run dg hooks install without --command to call node and dg by their absolute paths)",
      gone: `${gone.join(", ")} no longer exists (node or deguboard was upgraded or moved). Run dg hooks install again`,
      timeout: "--version timed out (15 seconds)",
      failed: "--version exited abnormally (it failed to start or the exit code is not 0)",
      unverified:
        "it uses shell syntax (~, single quotes, expansions, VAR=x, etc.), so it cannot be verified. Run dg hooks install --command again with a plain command to verify it",
    };
    warnings.push(`Handler "${base}": ${text[verdict]}`);
  }
  // ハンドラの確かめは dg 自身の環境で走るので、ハーネスの環境（PATH が違いうる）で動くかは分からない。
  // 届いた記録で確かめる：入れてあるのに一度も届いていないイベントと、呼んだセッションに届いていないこと（t697）
  if (localDir !== undefined) {
    const never = events.filter((e) => e.installed && e.received_at === null).map((e) => e.event);
    if (never.length > 0)
      warnings.push(
        `dg has never received these installed hooks: ${never.join(", ")}. If they were just installed, start a new session and check again. Otherwise the command the hooks call may not run in the agent's environment (for example, node is not on its PATH), even when the handler check above passes in this shell`,
      );
    const silent = await hooksSilentWarning(localDir, options.env);
    if (silent) warnings.push(silent);
  }
  return { agent, scope: options.scope, file, events, warnings };
}

/** dg のフックを外す。手で足したフックは残す */
export async function uninstallHooks(options: {
  cwd: string;
  scope: HookScope;
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
    warnings: [],
  });
}

async function write(
  file: string,
  current: Settings,
  hooks: Record<string, unknown>,
  meta: Pick<HooksResult, "agent" | "scope" | "events" | "dryRun" | "warnings">,
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
