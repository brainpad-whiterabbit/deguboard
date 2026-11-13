// bin/dg.js と、束ねた dg.mjs の入口（bundle.ts）が main を読む前に試す、PreToolUse と Stop の速い経路（t768・t769・t786）。
// argv が dg hooks install の書く PreToolUse か Stop の呼び出しなら、標準入力の JSON を core の fastHook に渡し、今の経路
// （program.ts の dg hook と output.ts の printHuman）と同じ書き方（hook-print.ts）で書く。
// 受け持たない入力は、読んだ標準入力を添えて今の経路に回す（標準入力は 1 度しか読めない）。
// commander・yaml・core の入口を読まない（fast-hook.test.ts が静的な import を確かめる）

import { fastHook, fastHookEventOf } from "@deguboard/core/fast-hook";
import { printHookView, printWarnings } from "./hook-print.js";

interface FastHookIo {
  /** 標準入力の全体。既定は process.stdin */
  stdin?: () => Promise<string>;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => Date;
}

/** 速い経路の結果。受け持たなければ、読んだ標準入力（読んでいれば）を今の経路に渡す */
type FastHookResult =
  | { handled: true; exitCode: number }
  | { handled: false; stdin?: string | undefined };

export async function tryFastHook(
  argv: readonly string[],
  io: FastHookIo = {},
): Promise<FastHookResult> {
  const eventName = fastHookEventOf(argv);
  if (eventName === undefined) return { handled: false };
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
    view = await fastHook({
      eventName,
      cwd: io.cwd ?? process.cwd(),
      payload,
      env: io.env ?? process.env,
      ...(io.now ? { now: io.now } : {}),
    });
  } catch {
    // 思わぬ失敗は、今の経路に任せる（そちらが警告にして 0 で返す）。今の経路はもう 1 度記録するので、回してよいのは
    // 最初の記録の前の失敗だけ。fastHook は記録を始めた後は投げず、undefined も返さない（core の fast-hook.ts）
    return { handled: false, stdin: text };
  }
  if (!view) return { handled: false, stdin: text };
  const streams = {
    out: io.out ?? ((t: string) => process.stdout.write(`${t}\n`)),
    err: io.err ?? ((t: string) => process.stderr.write(`${t}\n`)),
  };
  // printHuman の hook と同じ順と書き方（hook-print.ts）：行ったことと拒む文・続けさせる文の後に警告
  printHookView(streams, view);
  printWarnings(streams, view.warnings);
  return { handled: true, exitCode: 0 };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
