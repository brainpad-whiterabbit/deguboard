// src/bundle.ts の型検査用。実装は run-entry.mjs

type FastHookResult =
  | { handled: true; exitCode: number }
  | { handled: false; stdin?: string | undefined };

export function runEntry(
  argv: readonly string[],
  entry: {
    loadFastHook: () => Promise<((argv: readonly string[]) => Promise<FastHookResult>) | undefined>;
    runMain: (opts: { stdinText?: string }) => Promise<number>;
  },
): Promise<number>;
