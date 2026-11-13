// vitest のワーカー数の上限を、環境変数 DEGUBOARD_TEST_MAX_WORKERS の値から決める（vitest.config.ts が使う）。
// 既定と、受ける形の理由は vitest.config.ts のコメント。テストは test/lint/vitest-max-workers.test.ts

/** 環境変数がない（または空の）ときの上限。CPU 数の半分 */
export const DEFAULT_MAX_WORKERS = "50%";

/**
 * DEGUBOARD_TEST_MAX_WORKERS の値を vitest の maxWorkers に直す。
 * 受けるのは 1 以上の整数（"4"）か、1〜100 の百分率（"75%"）だけ。
 * vitest は数でない値を NaN に、"0%" を 1 に黙って直すので、ここで止めて受ける形を示す
 */
export function resolveMaxWorkers(raw: string | undefined): number | string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_MAX_WORKERS;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  if (/^([1-9]\d?|100)%$/.test(value)) return value;
  throw new Error(
    `DEGUBOARD_TEST_MAX_WORKERS must be a positive integer (e.g. "4") or a percentage from 1% to 100% (e.g. "75%"), got ${JSON.stringify(raw)}`,
  );
}
