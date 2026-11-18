// vitest のワーカー数の上限を、環境変数 DEGUBOARD_TEST_MAX_WORKERS の値と、変えたファイルだけを回すか（test:related）から決める
// （vitest.config.ts が使う）。ワーカー数の決まりの正本はこのコメントで、ほかの文書と設定はここを指す。
// テストは test/lint/vitest-max-workers.test.ts
//
// 既定は、全体のテストが CPU 数の半分、test:related が 4 分の 1。全体のテストは check の flock で 1 本ずつになるが、
// test:related は lock の外で回るので、全体のテストと重なる。vitest の既定（論理 CPU 数 - 1）のままだと 2 本で CPU 数の
// ほぼ倍のワーカーが取り合い、時間に頼るテストが落ちやすくなる。8 CPU で測ると、重ねたときは 4 と 7 で時間が変わらず
// （全体 193 秒と 195 秒）、1 本だけのときは 4 が 2 割遅い（133 秒と 110 秒）だけだったので、全体のテストを CPU 数の半分にする。
// 並列のエージェントは worktree ごとに test:related を回すので、半分ずつでも何本も重なる（2026-11-17 に 3 本が重なり、
// 8 CPU で負荷平均が 16、全体のテストが 432 秒かかった）。test:related は lock に入れず待たずに回したいので、
// 全体のテストより少ない 4 分の 1 にする。test:related かどうかは vitest run の --changed で見る（isRelatedRun）。
//
// 手元で 1 本だけ速く回したいときや、もっと絞りたいときは DEGUBOARD_TEST_MAX_WORKERS に数か "75%" のような割合を渡す。
// test:related でも、渡した値をそのまま使う。それ以外の値と 0 はエラーで止まる。
// vitest 自身の VITEST_MAX_WORKERS を使わないのは、vitest がその値を parseInt で読むので "75%" が 75 本になり、
// 数でない値も黙って NaN になるから

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
