// test/scripts の型検査用。実装は related-tests.mjs

export const RELATED_ENV: string;
export function isTestFile(file: string): boolean;
export function isSourceFile(file: string): boolean;
export function selectRelatedTests(
  changed: readonly string[],
  tests: readonly string[],
  sources: readonly string[],
): { tests: string[]; unpaired: string[] };
