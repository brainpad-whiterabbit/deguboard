import { defineConfig } from "vitest/config";

// 時差を UTC に固定する。web の日時は手元の時差で整形するので、期待値（例：2026-01-01T00:00Z を 2026-01-01）が
// UTC より西の時差（America/Los_Angeles など）で 1 日ずれて落ちる。ワーカーに引き継がれるよう、本体のプロセスで先に決めておく。
// 手元の時差で整形すること自体は timeline.test.ts が時差を変えて確かめる
process.env.TZ = "UTC";

export default defineConfig({
  // @deguboard/core を dist ではなく src で解決する（ビルドなしでテストする）
  resolve: { conditions: ["development"] },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    // Git を使うテストは bare リモートと clone を作るので余裕を持たせる
    testTimeout: 20_000,
  },
});
