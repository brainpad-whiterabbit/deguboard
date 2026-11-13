import { defineConfig } from "vitest/config";
import { resolveMaxWorkers } from "./vitest.workers.js";

// 時差を UTC に固定する。web の日時は手元の時差で整形するので、期待値（例：2026-01-01T00:00Z を 2026-01-01）が
// UTC より西の時差（America/Los_Angeles など）で 1 日ずれて落ちる。ワーカーに引き継がれるよう、本体のプロセスで先に決めておく。
// 手元の時差で整形すること自体は timeline.test.ts が時差を変えて確かめる
process.env.TZ = "UTC";

// ワーカー数の上限。全体のテストは check の flock で 1 本ずつになるが、test:related は lock の外で回るので、
// 全体のテストと重なる。vitest の既定（論理 CPU 数 - 1）のままだと 2 本で CPU 数のほぼ倍のワーカーが取り合い、
// 時間に頼るテストが落ちやすくなる。8 CPU で測ると、重ねたときは 4 と 7 で時間が変わらず（全体 193 秒と 195 秒）、
// 1 本だけのときは 4 が 2 割遅い（133 秒と 110 秒）だけだったので、既定を CPU 数の半分にして 2 本で CPU を埋める。
// 手元で 1 本だけ速く回したいときや、もっと絞りたいときは DEGUBOARD_TEST_MAX_WORKERS（数か "75%" のような割合）で変える。
// vitest 自身の VITEST_MAX_WORKERS を使わないのは、vitest がその値を parseInt で読むので "75%" が 75 本になり、
// 数でない値も黙って NaN になるから。この変数は vitest.workers.ts で読み、受けない値と 0 はエラーで止める
const maxWorkers = resolveMaxWorkers(process.env.DEGUBOARD_TEST_MAX_WORKERS);

export default defineConfig({
  // @deguboard/core を dist ではなく src で解決する（ビルドなしでテストする）
  resolve: { conditions: ["development"] },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    // Git を使うテストは bare リモートと clone を作るので余裕を持たせる
    testTimeout: 20_000,
    maxWorkers,
  },
});
