# deguboard for VS Code

Git-native な AI ワークフロー・チケット管理ツール [deguboard](https://github.com/brainpad-whiterabbit/deguboard) の画面を VS Code の中で開く。

- Activity Bar の deguboard のアイコンを押すと、サイドバーに開いているフォルダ（リポジトリ）の画面が出て、上部のタブでカンバン・バックログ・履歴・Run を切り替える。チケット・Iteration・Epic を押すと詳細がエディタ領域に開く（チケットの詳細は本文・属性・依存・Run の一覧・経過）。`dg` やエージェントが書いた変更（Run の開始・終了を含む）は自動で画面に映る。タイトル行の同期ボタンで `dg sync` と同じ同期をして画面を読み直す（リモートがなければ読み直すだけ）。未 push・未取り込みの件数はバッジで出す
- エディタ領域には詳細だけを出す。詳細の中から一覧（Epic で絞ったカンバンなど）を開くと、サイドバーがその画面に切り替わる
- 複数のフォルダを開いているときは、サイドバーは最初のフォルダを対象にする（ビューの見出しにフォルダ名が出る）
- 画面の読み書きは拡張に同梱した core が直接行う。サーバーは起動しない
- CLI の `dg` は同梱しない。エージェントや CLI から使うには `npm i -g deguboard` で入れる。画面は `dg` なしで動く
- リポジトリで `dg init` を済ませていることが前提
- Run の記録と集計の始め方は [deguboard の README](https://github.com/brainpad-whiterabbit/deguboard#readme)
