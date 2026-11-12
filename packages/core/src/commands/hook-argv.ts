// dg hooks install が設定に書くフックの、dg に渡す引数（dg を呼ぶ部分の後ろ）。
// bin/dg.js の速い経路が受け持つ argv も同じここから作る（t768。書く形と受け持つ形がずれない）。依存の軽いファイルだけを読む

import { DEFAULT_HOOK_AGENT } from "../agents/fast-hooks.js";

/** フックが dg に渡す引数。既定のエージェントは --agent を省く */
export function hookArgv(agent: string, event: string): string[] {
  return [
    "--actor",
    "agent",
    "hook",
    event,
    ...(agent === DEFAULT_HOOK_AGENT ? [] : ["--agent", agent]),
    "--payload",
    "-",
  ];
}
