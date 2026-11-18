import { defineConfig } from "vitest/config";

// VS Code の実機（拡張開発ホスト）で Webview を確かめる検査（test/vscode）。VS Code 本体のダウンロードと画面（Xvfb）が要るので
// mise run test とは別に mise run test:vscode で回す
//
// vitest.config.ts の TZ の固定・HOME とエージェントの環境変数の除去・ワーカー数の上限は持たない。
// - HOME とエージェントの環境変数：拡張が動く VS Code のプロセスには、launchHost が一時の HOME を渡し、cleanEnv がエージェントと
//   dg の環境変数を外す（test/vscode/host.ts）。vitest のプロセスは VS Code を操作するだけなので、ここで外さない
// - TZ：確かめるのは要素の数・属性・CSP 違反と例外で、時差で変わる日時の文字列を比べない（スクリーンショットは出すだけで比べない）
// - ワーカー数：下の fileParallelism: false でファイルを 1 つずつ流すので、上限で絞るものがない。check にも入らず、
//   全体のテストや test:related と重ねて回す前提がない
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
