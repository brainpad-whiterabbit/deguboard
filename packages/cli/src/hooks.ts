// dg hooks install / uninstall：harness の設定に dg hook を呼ぶフックを書く・外す（AG-5、ADR-012）。
// 書くイベントと設定のファイルは agent の Adapter の hooks が決める。手で足した他のフックは残し、dg のフックだけを入れ替える

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hooksOf, resolveRepoPaths, type AgentEnv, type HookSupport } from "@deguboard/core";

/** dg が書いたフックのコマンドの末尾。これで見分けて入れ替える（基のコマンドが変わっても重ねない） */
const OURS = /(^|\s)hook \S+ --payload -$/;

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
  const unchanged = content === before;
  if (!meta.dryRun && !unchanged) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return { ...meta, file, unchanged, ...(meta.dryRun ? { content } : {}) };
}
