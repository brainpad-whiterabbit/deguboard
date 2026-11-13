// dg hook の人向けの出力の書き方。今の経路（output.ts の printHuman）と PreToolUse と Stop の速い経路（fast-hook.ts）が同じものを使う。
// 速い経路が読むので、ほかのファイルを読まない（fast-hook.test.ts が確かめる）

interface Streams {
  out(text: string): void;
  err(text: string): void;
}

/** 行ったことを標準エラーに、拒む文を標準出力に書く */
export function printHookView(
  streams: Streams,
  view: { done?: readonly string[]; output?: string | undefined } | undefined,
): void {
  // フックの標準出力は harness が会話に足しうる（SessionStart など）ので、何も出さず標準エラーにだけ書く
  for (const line of view?.done ?? []) streams.err(`dg hook: ${line}`);
  // ツールの使用を拒むときの文（製品の形）だけは標準出力に書き、harness が読む
  if (view?.output) streams.out(view.output);
}

/** 警告を標準エラーに書く（どのコマンドも同じ形） */
export function printWarnings(streams: Streams, warnings: readonly string[]): void {
  for (const w of warnings) streams.err(`Warning: ${w}`);
}
