import { defineConfig } from "vitest/config";

// 画面の配置とドラッグの確認（test/layout）。Chromium が要るので mise run test とは別に mise run test:layout で回す
export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["test/layout/**/*.layout.ts"],
    testTimeout: 60_000,
    // 1 つのサーバーとブラウザを使い回すのでファイルの中は順に流す
    fileParallelism: false,
  },
});
