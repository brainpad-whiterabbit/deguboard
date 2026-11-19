// vitest のワーカー数の上限を、環境変数 DEGUBOARD_TEST_MAX_WORKERS の値と、変えたファイルだけを回すか（test:related）から決める
// （vitest.config.ts が使う）。ワーカー数の決まりの正本はこのコメントで、ほかの文書と設定はここを指す。
// テストは test/lint/vitest-max-workers.test.ts
//
// 既定は、全体のテストが CPU 数の 4 分の 3、test:related が 4 分の 1。全体のテストは check の flock で 1 本ずつになるが、
// test:related は lock の外で回るので、全体のテストと重なる。vitest の既定（論理 CPU 数 - 1）のままだと 2 本で CPU 数の
// ほぼ倍のワーカーが取り合い、時間に頼るテストが落ちやすくなる。そこで、全体のテスト 1 本と test:related 1 本を足して
// CPU 数に収まる割合にする（足して 100% 以下であることは test/lint/vitest-max-workers.test.ts が確かめる）。
// テストの時間のほとんどは git の子プロセスの起動で、CPU を使い切るまではワーカー数に応じて縮む。8 CPU（4 コア）で
// 全体のテスト（162 ファイル）を 1 回ずつ測ると、1 本だけのときは 4 本で 153 秒・6 本で 122 秒・8 本で 116 秒、
// 2 ワーカーの vitest（test:related 1 本に当たる）を重ねたときは 4 本で 170 秒・6 本で 149 秒で、どれも落ちなかった
// （2026-11-19、t1139）。
// 8 本は 6 本とほぼ変わらず、重なる test:related の分が残らないので採らない。
// 並列のエージェントは worktree ごとに test:related を回すので、何本も重なる（全体のテストも test:related も CPU 数の
// 半分だった 2026-11-17 に 3 本が重なり、8 CPU で負荷平均が 16、全体のテストが 432 秒かかった）。test:related は
// lock に入れず待たずに回したいので、4 分の 1 にする。test:related が 2 本以上重なるとワーカーの合計は CPU 数を超えるが
// （2 本以上を重ねた計測はしていない）、テストの上限の時間（vitest.config.ts の testTimeout、20 秒）に余裕があり、
// 1 本を重ねた計測では落ちなかったので、全体のテストは 4 分の 3 にする。時間に頼るテストが落ち始めたら半分に戻す。
// test:related かどうかは、scripts/test-related.mjs が vitest に渡す
// 環境変数 DEGUBOARD_TEST_RELATED で見る（isRelatedRun）。
//
// 手元で 1 本だけ速く回したいときや、もっと絞りたいときは DEGUBOARD_TEST_MAX_WORKERS に数か "50%" のような割合を渡す。
// test:related でも、渡した値をそのまま使う。それ以外の値と 0 はエラーで止まる。
// vitest 自身の VITEST_MAX_WORKERS を使わないのは、vitest がその値を parseInt で読むので "75%" が 75 本になり、
// 数でない値も黙って NaN になるから

/** 環境変数がない（または空の）ときの、全体のテストの上限。CPU 数の 4 分の 3 */
export const DEFAULT_MAX_WORKERS = "75%";

/** 環境変数がない（または空の）ときの、test:related の上限。全体のテストより少なくする */
export const RELATED_MAX_WORKERS = "25%";

/**
 * vitest を変えたファイルに関わるテストだけで回しているか（test:related）を、環境変数から見る。
 * scripts/test-related.mjs がこの変数を "1" にして vitest を起動することは test/lint/vitest-max-workers.test.ts が確かめる
 */
export function isRelatedRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DEGUBOARD_TEST_RELATED === "1";
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
