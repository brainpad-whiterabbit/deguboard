// bin/dg.js が main を読む前に試す、PreToolUse の速い経路（t768）。argv が dg hooks install の書く PreToolUse の呼び出しなら、
// 標準入力の JSON を core の fastPreToolUse に渡し、今の経路（program.ts の dg hook と output.ts の printHuman）と同じ形で書く。
// 受け持たない入力は、読んだ標準入力を添えて今の経路に回す（標準入力は 1 度しか読めない）。
// commander・yaml・core の入口を読まない（fast-hook.test.ts が静的な import を確かめる）

import { fastPreToolUse, isFastHookArgv } from "@deguboard/core/fast-hook";

export interface FastHookIo {
  /** 標準入力の全体。既定は process.stdin */
  stdin?: () => Promise<string>;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => Date;
}

/** 速い経路の結果。受け持たなければ、読んだ標準入力（読んでいれば）を今の経路に渡す */
export type FastHookResult =
  | { handled: true; exitCode: number }
  | { handled: false; stdin?: string | undefined };

export async function tryFastHook(
  argv: readonly string[],
  io: FastHookIo = {},
): Promise<FastHookResult> {
  if (!isFastHookArgv(argv)) return { handled: false };
  const text = await (io.stdin ?? readStdin)();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // JSON でない入力は、今の経路（YAML として読む）が扱う
    return { handled: false, stdin: text };
  }
  let view;
  try {
    view = await fastPreToolUse({
      cwd: io.cwd ?? process.cwd(),
      payload,
      env: io.env ?? process.env,
      ...(io.now ? { now: io.now } : {}),
    });
  } catch {
    // 思わぬ失敗は、今の経路に任せる（そちらが警告にして 0 で返す）
    return { handled: false, stdin: text };
  }
  if (!view) return { handled: false, stdin: text };
  const out = io.out ?? ((t: string) => process.stdout.write(`${t}\n`));
  const err = io.err ?? ((t: string) => process.stderr.write(`${t}\n`));
  // printHuman の hook と同じ順：行ったことを標準エラーに、拒む文を標準出力に、警告を標準エラーに
  for (const line of view.done) err(`dg hook: ${line}`);
  if (view.output) out(view.output);
  for (const w of view.warnings) err(`Warning: ${w}`);
  return { handled: true, exitCode: 0 };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
