# deguboard for VS Code

Git-native な AI ワークフロー・チケット管理ツール [deguboard](https://github.com/brainpad-whiterabbit/deguboard) の画面を VS Code の中で開く。

- コマンドパレットの「deguboard: 画面を開く」で、開いているフォルダ（リポジトリ）のカンバン・バックログ・チケット詳細・Epic・Iteration を Webview に出す
- 画面の読み書きは拡張に同梱した core が直接行う。サーバーは起動しない
- CLI の `dg` は同梱しない。エージェントや CLI から使うには `npm i -g deguboard` で入れる。画面は `dg` なしで動く
- リポジトリで `dg init` を済ませていることが前提
