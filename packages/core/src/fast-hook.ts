// dg の 2 つの入口（bin/dg.js と、同梱の dg.mjs の入口 cli/src/bundle.ts。共通の流れは cli/bin/run-entry.mjs）の速い経路（t768・t769）。
// 入口は cli の fast-hook.ts を通してここを呼ぶ。dg hooks install が書く、ツールを使う前のフック（PreToolUse）の呼び出しを、
// CLI の全体（core の入口・zod・yaml・commander）を読まずに処理する。ツールのたびに呼ばれ、全体を読むと 1 回に 200 ms を超えるため。
// 記録と判定は dg hook と同じ runToolRequested（commands/pre-tool-use.ts）を呼ぶので、出力と記録は今の経路と同じになる。
// 受け持つのは、dg hook がストアを開かずに扱う入力（hook の storeless）のうち、git のリポジトリの中で初期化済みのものだけ。
// ほかの入力（オブジェクトでない・扱わないツール・git の外・初期化していない）は undefined を返し、入口が今の経路に回す。
// エージェントとイベントの名前は agents/fast-hooks.ts が決める（AG-5）。
// このファイルから静的に読むのは node の組み込みと依存の軽いファイルだけ（cli の fast-hook.test.ts が確かめる）

import { DEFAULT_HOOK_AGENT, DEFAULT_TOOL_EVENT, defaultHookSupport } from "./agents/fast-hooks.js";
import { hookArgv } from "./commands/hook-argv.js";
import { runToolRequested, type ToolRequestedView } from "./commands/pre-tool-use.js";
import { isInitialized, resolveRepoPaths } from "./git/repo.js";

/** 速い経路が受け持つ argv（dg hooks install が既定のエージェントのそのイベントに書く形と同じ hookArgv から作る） */
export function isFastHookArgv(argv: readonly string[]): boolean {
  const expected = hookArgv(DEFAULT_HOOK_AGENT, DEFAULT_TOOL_EVENT);
  return argv.length === expected.length && argv.every((a, i) => a === expected[i]);
}

/**
 * ツールを使う前のフックの入力（JSON を読んだ値）を処理する。受け持たない入力は undefined（入口が今の経路に回す）。
 * cwd は dg を呼んだ場所（今の経路の -C を省いたときと同じ）
 */
export async function fastPreToolUse(opts: {
  cwd: string;
  payload: unknown;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}): Promise<ToolRequestedView | undefined> {
  const { payload } = opts;
  // 今の経路は入力をオブジェクト（z.record）として検査する。それ以外は今の経路が誤りを伝える
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const event = defaultHookSupport.parse(DEFAULT_TOOL_EVENT, record, opts.env);
  if (event?.kind !== "tool_requested") return undefined;
  const paths = await resolveRepoPaths(opts.cwd).catch(() => undefined);
  if (!paths || !(await isInitialized(paths))) return undefined;
  return runToolRequested({
    hooks: defaultHookSupport,
    eventName: DEFAULT_TOOL_EVENT,
    payload: record,
    event,
    repo: paths,
    now: opts.now ?? (() => new Date()),
  });
}
