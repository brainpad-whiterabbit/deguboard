// vitest のワーカー数の上限を、環境変数 DEGUBOARD_TEST_MAX_WORKERS の値と、変えたファイルだけを回すか（test:related）から決める
// （vitest.config.ts が使う）。既定と、受ける形の理由は vitest.config.ts のコメント。テストは test/lint/vitest-max-workers.test.ts

/** 環境変数がない（または空の）ときの、全体のテストの上限。CPU 数の半分 */
export const DEFAULT_MAX_WORKERS = "50%";

/** 環境変数がない（または空の）ときの、test:related の上限。全体のテストより少なくする */
export const RELATED_MAX_WORKERS = "25%";

/**
 * vitest を変えたファイルに関わるテストだけで回しているか（test:related の vitest run --changed）を、コマンドの引数から見る。
 * package.json の test:related が --changed を渡すことは test/lint/vitest-max-workers.test.ts が確かめる
 */
export function isRelatedRun(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--changed" || arg.startsWith("--changed="));
}

/**
 * DEGUBOARD_TEST_MAX_WORKERS の値を vitest の maxWorkers に直す。値がなければ、test:related は全体のテストより少ない上限にする。
 * 受けるのは 1 以上の整数（"4"）か、1〜100 の百分率（"75%"）だけで、test:related でも値をそのまま使う。
 * vitest は数でない値を NaN に、"0%" を 1 に黙って直すので、ここで止めて受ける形を示す
 */
export function resolveMaxWorkers(raw: string | undefined, related = false): number | string {
  const value = raw?.trim() ?? "";
  if (value === "") return related ? RELATED_MAX_WORKERS : DEFAULT_MAX_WORKERS;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  if (/^([1-9]\d?|100)%$/.test(value)) return value;
  throw new Error(
    `DEGUBOARD_TEST_MAX_WORKERS must be a positive integer (e.g. "4") or a percentage from 1% to 100% (e.g. "75%"), got ${JSON.stringify(raw)}`,
  );
}
