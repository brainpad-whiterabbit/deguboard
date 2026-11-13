// dg hooks install / uninstall：harness の設定に dg hook を呼ぶフックを書く・外す（AG-5、ADR-025）。
// 書くイベントと設定のファイルは agent の Adapter の hooks が決める。手で足した他のフックは残し、dg のフックだけを入れ替える。
// 既定は追跡しない local の設定に、動いている node と dg.js の絶対パスで書き、隣の .gitignore にその設定の行を足す（t698・AG-9）。起動ファイル経由なら起動ファイルの絶対パスで書く（t735）。
// ハーネスがフックを動かす環境の PATH は利用者のシェルと違いうる（node を mise・nvm・volta などで入れ、対話のシェルでだけ有効にしているなど）ので、PATH の dg や node に頼らない

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  bundleLayout,
  hookArgv,
  hooksOf,
  hooksSilentWarning,
  readHookInput,
  resolveRepoPaths,
  takeHookWarnings,
  UsageError,
  type AgentEnv,
  type HookSupport,
} from "@deguboard/core";
import { ensureIgnoreLines, trackedFiles } from "./gitignore.js";
import { isLauncherPath, launcherFrom } from "./launcher-env.js";

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
  /** install がこの実行で無視の行を足した .gitignore の絶対パス。足さなかった（すでにある・local でない・--dry-run）なら null。uninstall にはない */
  ignoreFile?: string | null;
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

/**
 * dg のフックのコマンド。base は dg を呼ぶコマンド（既定は dg）。後ろの引数は bin/dg.js の速い経路が受け持つ argv と
 * 同じ hookArgv から作る（t768）
 */
const commandFor = (base: string, agent: string, event: string) =>
  `${base} ${hookArgv(agent, event).join(" ")}`;

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

/** このプロセスを動かしている dg の起動ファイル（bin/dg.js。束ねた CLI では dg.mjs）の実パス。リンク（~/.local/bin/dg など）は辿る */
function dgScript(): string {
  return realpathSync(
    bundleLayout()?.entry ?? fileURLToPath(new URL("../bin/dg.js", import.meta.url)),
  );
}

/**
 * 既定の、dg を呼ぶコマンド。追跡しない設定（local・personal）には、動いている node と dg.js の絶対パスを書き、PATH に頼らない。
 * 起動ファイル経由で動いていれば（env に DEGUBOARD_LAUNCHER があれば）、node と dg.js の代わりに起動ファイルを書く。
 * 追跡する設定（project）はほかのマシンでも読まれるので、マシンのパスを書かずに PATH の dg を呼ぶ
 */
function defaultCommand(scope: HookScope, env: AgentEnv): string {
  if (scope === "project") return "dg";
  const launcher = launcherFrom(env);
  return launcher !== undefined
    ? doubleQuote(launcher)
    : `${doubleQuote(process.execPath)} ${doubleQuote(dgScript())}`;
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
 * 追跡しない設定に書くときの警告：そのファイルを git がすでに追跡している（無視の行が効かず、マシンのパスが共有される）、
 * 追跡する設定にも dg のフックが残っている（両方が動き、追跡する方は動かないマシンで失敗する）。
 * 無視していないことは警告しない（installHooks が .gitignore に行を足す）
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
    const [tracked] = await trackedFiles(topLevel, file);
    if (tracked !== undefined)
      warnings.push(
        `${tracked} is tracked by git, so the ignore line in .gitignore does not apply to it. It holds this machine's paths to node and dg. ` +
          `Stop tracking it at the repository root with git rm --cached ${tracked} and commit (the file stays on disk)`,
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
  const base = options.command ?? defaultCommand(options.scope, options.env);
  const next: Record<string, unknown> = withoutOurs(current.hooks ?? {});
  for (const { event, matcher } of hooks.events) {
    const groups = Array.isArray(next[event]) ? [...(next[event] as Group[])] : [];
    groups.push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: commandFor(base, agent, event) }],
    });
    next[event] = groups;
  }
  const dryRun = options.dryRun ?? false;
  const result = await write(file, current, next, {
    agent,
    scope: options.scope,
    events: hooks.events.map((e) => e.event),
    dryRun,
    warnings: await installWarnings(hooks, options, file),
  });
  // local の設定はマシンのパスを持つので、実行のたびに隣の .gitignore に自分の行がなければ足す（設定が変わらなくても）
  const ignoreFile = join(dirname(file), ".gitignore");
  const added =
    options.scope === "local" && !dryRun && (await ensureIgnoreLines(ignoreFile, [basename(file)]));
  return { ...result, ignoreFile: added ? ignoreFile : null };
}

/**
 * フックの状態を確かめる：設定に dg のフックが入っているか（イベントごと・matcher）、ハンドラが動くか、直近の入力に
 * 受け取らなかった項目があるか（deguboard-local/hook-inputs/ の記録。値は見ない）。欠けていれば警告にする。
 * まだ知らせていないフックの中の警告（deguboard-local/hook-sessions/。t756）も警告に足す
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
    // 起動ファイルがなくなったときは、拡張が残っていれば dg hooks install を案内しない（別の dg が node と dg.js を書き直してしまう）。拡張を開き直して書かせる。
    // 拡張を消したとき（起動ファイルも current もない）は開き直せないので、入れ直すか外す案内にする（t742）
    const launcherGone = gone.filter((p) => isLauncherPath(p, options.env));
    const otherGone = gone.filter((p) => !launcherGone.includes(p));
    if (verdict === "gone" && launcherGone.length > 0) {
      const extensionRemoved = launcherGone.every((p) => !existsSync(join(dirname(p), "current")));
      warnings.push(
        extensionRemoved
          ? `Handler "${base}": ${launcherGone.join(", ")} no longer exists, and the deguboard extension that wrote it was removed. Run dg hooks install again to write hooks that call this dg, or dg hooks uninstall to remove them`
          : `Handler "${base}": ${launcherGone.join(", ")} no longer exists (the deguboard launcher was removed). Open VS Code with the deguboard extension once to write it again`,
      );
      if (otherGone.length === 0) continue;
    }
    const text: Record<Exclude<HandlerStatus, "ok">, string> = {
      missing:
        "not found (it is not on PATH. Run dg hooks install without --command to call node and dg by their absolute paths)",
      gone: `${otherGone.join(", ")} no longer exists (node or deguboard was upgraded or moved). Run dg hooks install again`,
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
    // フックの中で出た警告（SubagentStop が届かないことを含む）のうち、まだ知らせていないもの（t756）
    warnings.push(...(await takeHookWarnings(localDir)));
  }
  return { agent, scope: options.scope, file, events, warnings };
}

/**
 * dg のフックを外す。手で足したフックは残す。
 * .gitignore の settings.local.json の行は消さない。settings.local.json は Claude Code が dg の外でも各自のマシンの設定（許可など）に使うので、
 * dg のフックがなくなっても追跡させないままにする（t804）
 */
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
