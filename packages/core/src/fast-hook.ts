// dg の 2 つの入口（bin/dg.js と、同梱の dg.mjs の入口 cli/src/bundle.ts。共通の流れは cli/bin/run-entry.mjs）の速い経路（t768・t769・t786）。
// 入口は cli の fast-hook.ts を通してここを呼ぶ。dg hooks install が書く、ツールを使う前のフック（PreToolUse）と、応答を終えたときの
// フック（Stop）の呼び出しを、CLI の全体（core の入口・zod・yaml・commander）を読まずに処理する。どちらもツールや応答のたびに呼ばれ、
// 全体を読むと 1 回に 200 ms を超えるため。
// 記録と判定は dg hook と同じ runToolRequested（commands/pre-tool-use.ts）と runTurnStopped（commands/turn-stopped.ts）を呼ぶので、
// 出力と記録は今の経路と同じになる。
// 受け持つのは、dg hook がストアを開かずに扱う入力（hook の storeless）のうち、git のリポジトリの中で初期化済みのものだけ。
// ほかの入力（オブジェクトでない・扱わないツール・git の外・初期化していない）は undefined を返し、入口が今の経路に回す。
// エージェントとイベントの名前は agents/fast-hooks.ts が決める（AG-5）。
// このファイルから静的に読むのは node の組み込みと依存の軽いファイルだけ（cli の fast-hook.test.ts が確かめる）。
// ただ 1 つの例外として、Stop で config のリモートの名前が要るとき（データのリポジトリの HEAD が基準から動いたとき）だけ、
// config を読むファイル（yaml・zod を読む）を動的に読む（今の経路の storelessRemote と同じ読み方）

import {
  DEFAULT_HOOK_AGENT,
  DEFAULT_STOP_EVENT,
  DEFAULT_TOOL_EVENT,
  defaultHookSupport,
} from "./agents/fast-hooks.js";
import { hookArgv } from "./commands/hook-argv.js";
import type { HookRunView } from "./commands/hook-records.js";
import { runToolRequested } from "./commands/pre-tool-use.js";
import { runTurnStopped } from "./commands/turn-stopped.js";
import {
  isInitialized,
  resolveRemote,
  resolveRepoPaths,
  type GitRepo,
  type RepoPaths,
} from "./git/repo.js";

/** 速い経路が受け持つイベント */
const FAST_EVENTS = [DEFAULT_TOOL_EVENT, DEFAULT_STOP_EVENT];

/**
 * 速い経路が受け持つ argv なら、そのイベントの名前（dg hooks install が既定のエージェントのそのイベントに書く形と同じ hookArgv から作る）。
 * 受け持たなければ undefined
 */
export function fastHookEventOf(argv: readonly string[]): string | undefined {
  return FAST_EVENTS.find((event) => {
    const expected = hookArgv(DEFAULT_HOOK_AGENT, event);
    return argv.length === expected.length && argv.every((a, i) => a === expected[i]);
  });
}

/**
 * フックの入力（JSON を読んだ値）を処理する。eventName は fastHookEventOf が返したもの。受け持たない入力は undefined（入口が今の経路に回す）。
 * cwd は dg を呼んだ場所（今の経路の -C を省いたときと同じ）
 */
export async function fastHook(opts: {
  eventName: string;
  cwd: string;
  payload: unknown;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}): Promise<HookRunView | undefined> {
  const { eventName, payload } = opts;
  // 今の経路は入力をオブジェクト（z.record）として検査する。それ以外は今の経路が誤りを伝える
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const event = defaultHookSupport.parse(eventName, record, opts.env);
  const handles =
    (eventName === DEFAULT_TOOL_EVENT && event?.kind === "tool_requested") ||
    (eventName === DEFAULT_STOP_EVENT && event?.kind === "turn_stopped");
  if (!event || !handles) return undefined;
  const paths = await resolveRepoPaths(opts.cwd).catch(() => undefined);
  if (!paths || !(await isInitialized(paths))) return undefined;
  const now = opts.now ?? (() => new Date());
  if (event.kind === "tool_requested")
    return runToolRequested({
      hooks: defaultHookSupport,
      eventName,
      payload: record,
      event,
      repo: paths,
      now,
    });
  if (event.kind !== "turn_stopped") return undefined;
  return runTurnStopped({
    hooks: defaultHookSupport,
    eventName,
    payload: record,
    event,
    repo: withoutRemote(paths),
    remote: () => remoteOf(paths),
    now,
  });
}

/** 場所だけの repo。リモートの名前と基準のブランチは config を読まないと分からないので、読むと例外を投げる（runTurnStopped には remote を渡す） */
function withoutRemote(paths: RepoPaths): GitRepo {
  const unread = (name: string) => ({
    get(): never {
      throw new Error(`${name} was read on the fast hook path`);
    },
  });
  return Object.defineProperties(
    { ...paths },
    { remote: unread("repo.remote"), baseBranch: unread("repo.baseBranch") },
  ) as GitRepo;
}

/** config のリモートの名前を読んで解決する（今の経路の storelessContext と同じ）。要るときだけ config を読むファイルを動的に読む */
async function remoteOf(paths: RepoPaths): Promise<string | null> {
  const { readRemoteName } = await import("./storage/remote-name.js");
  return resolveRemote(paths, await readRemoteName(paths.dataDir, paths.localDir));
}
