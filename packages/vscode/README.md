# deguboard for VS Code

Git-native な AI ワークフロー・チケット管理ツール [deguboard](https://github.com/brainpad-whiterabbit/deguboard) の画面を VS Code の中で開く。

- Activity Bar の deguboard のアイコンを押すと、サイドバーに開いているフォルダ（リポジトリ）のカンバン・バックログ・Epic・Iteration が出る。チケットを押すと詳細がエディタ領域に開く。`dg` やエージェントが書いた変更は自動で画面に映る。タイトル行の再読み込みボタンで画面を読み直し、同期ボタンで `dg sync` と同じ同期をする。未 push・未取り込みの件数はバッジで出す
- コマンドパレットの「deguboard: 画面を開く」で、同じ画面をエディタ領域にも出せる
- 複数のフォルダを開いているときは、サイドバーは最初のフォルダを対象にする（ビューの見出しにフォルダ名が出る）。「画面を開く」はフォルダを選べる
- 画面の読み書きは拡張に同梱した core が直接行う。サーバーは起動しない
- CLI の `dg` は同梱しない。エージェントや CLI から使うには `npm i -g deguboard` で入れる。画面は `dg` なしで動く
- リポジトリで `dg init` を済ませていることが前提
