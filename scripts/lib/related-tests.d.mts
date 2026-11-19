// test/scripts の型検査用。実装は related-tests.mjs

export const RELATED_ENV: string;
export function isTestFile(file: string): boolean;
export function isSourceFile(file: string): boolean;
export const DATA_FILE_TESTS: readonly { pattern: RegExp; tests: readonly string[] }[];
export function selectRelatedTests(
  changed: readonly string[],
  tests: readonly string[],
  sources: readonly string[],
): { tests: string[]; unpaired: string[]; untested: string[] };
export function planRelatedRun(
  changed: readonly string[],
  files: readonly string[],
): { tests: string[]; messages: string[] };
export const FALLBACK_BASE_REF: string;
export function resolveBaseRef(output: string | undefined): { ref: string; message?: string };
