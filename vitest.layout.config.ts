import { defineConfig } from "vitest/config";

// 画面の配置と吹き出しの一覧の確認（test/layout）。Chromium が要るので mise run test とは別に mise run test:layout で回す
//
// vitest.config.ts の TZ の固定・HOME とエージェントの環境変数の除去・ワーカー数の上限は持たない。
// - TZ：日時はブラウザが整形し、時差で表示の変わる検査は Chromium の文脈に timezoneId を自分で渡す（sidebar.layout.ts）
// - HOME とエージェントの環境変数：確かめるのは横のはみ出し・行数・吹き出しの一覧で、警告の文字列や Run の記録の中身を比べない。
//   git の個人の設定は createFixture が GIT_CONFIG_GLOBAL=/dev/null にしてリポジトリに名前を書くので見ない
// - ワーカー数：下の fileParallelism: false でファイルを 1 つずつ流すので、上限で絞るものがない。check にも入らず、
//   全体のテストや test:related と重ねて回す前提がない
export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["test/layout/**/*.layout.ts"],
    testTimeout: 60_000,
    // 1 つのサーバーとブラウザを使い回すのでファイルの中は順に流す
    fileParallelism: false,
  },
});
