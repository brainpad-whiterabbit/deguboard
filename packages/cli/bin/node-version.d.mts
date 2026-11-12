// test/scripts の型検査用。実装は node-version.mjs

export const REQUIRED_NODE_MAJOR: number;
export function isPreToolUseHookArgv(argv: readonly string[]): boolean;
export function nodeVersionExitCodeOf(argv: readonly string[]): 1 | 2;
export function nodeVersionProblemOf(version: string, argv?: readonly string[]): string | undefined;
