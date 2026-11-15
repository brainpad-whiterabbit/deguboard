// test/scripts の型検査用。実装は build-info.mjs

export const BUILD_INFO_FILE: string;
export function readHeadCommit(root: string): string | undefined;
export function readBuiltCommit(distDir: string): string | undefined;
export function staleDistWarningOf(root: string): string | undefined;
