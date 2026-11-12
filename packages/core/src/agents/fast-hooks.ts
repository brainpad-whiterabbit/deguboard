// dg hooks install が --agent を省いて書く既定のエージェントと、そのフックの読み方。bin/dg.js の速い経路（fast-hook.ts。t768）が使う。
// agents/index.ts はすべての Adapter と使用量の読み方を読むので重い。フックの読み方（*-hooks.ts）は node の組み込みのほかを読まないので、
// ここから直に引く（AG-5）。hooksOf（agents/index.ts）と同じものを返すことは cli の fast-hook.test.ts が確かめる

import { claudeCodeHooks } from "./adapters/claude-code-hooks.js";
import type { HookSupport } from "./define.js";

/** フックのコマンドで --agent を省くエージェント（hookArgv） */
export const DEFAULT_HOOK_AGENT = "claude-code";

/** 既定のエージェントのフックの読み方 */
export const defaultHookSupport: HookSupport = claudeCodeHooks;

/** 既定のエージェントで、ツールを使う前に呼ばれるイベント（速い経路が受け持つ。hooks.parse が tool_requested にする） */
export const DEFAULT_TOOL_EVENT = "PreToolUse";
