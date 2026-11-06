import { defineConfig } from "vitest/config";

// VS Code の実機（拡張開発ホスト）で Webview を確かめる検査（test/vscode）。VS Code 本体のダウンロードと画面（Xvfb）が要るので
// mise run test とは別に mise run test:vscode で回す
export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["test/vscode/**/*.vscode.ts"],
    // VS Code の起動と Webview の描画を待つ
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // 1 つの VS Code を使い回すのでファイルの中は順に流す
    fileParallelism: false,
  },
});
