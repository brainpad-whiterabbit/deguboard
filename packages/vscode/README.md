# deguboard for VS Code

Git-native な AI ワークフロー・チケット管理ツール [deguboard](https://github.com/brainpad-whiterabbit/deguboard) の画面を VS Code の中で開く。

- Activity Bar の deguboard のアイコンを押すと、サイドバーに開いているフォルダ（リポジトリ）の画面が出て、上部のタブでカンバン・バックログ・履歴・Run を切り替える。チケット・Iteration・Epic を押すと詳細がエディタ領域に開く（チケットの詳細は本文・属性・依存・Run の一覧・経過）。`dg` やエージェントが書いた変更（Run の開始・終了を含む）は自動で画面に映る。タイトル行の同期ボタンで `dg sync` と同じ同期をして画面を読み直す（リモートがなければ読み直すだけ）。未 push・未取り込みの件数はバッジで出す
- サイドバーのカンバンは、上に実行計画（Plan）の帯、見出しに Iteration の Status ごとの進みの帯を出し、行の頭の回る印と「実行中」でこのマシンで Run が実行中のチケットを、行の右端に Plan の番号と、todo なら着手可か待ちの相手を出す
- エディタ領域には詳細だけを出す。詳細の中から一覧（Epic で絞ったカンバンなど）を開くと、サイドバーがその画面に切り替わる
- 複数のフォルダを開いているときは、サイドバーは最初のフォルダを対象にする（ビューの見出しにフォルダ名が出る）
- 画面の読み書きは拡張に同梱した core が直接行う。サーバーは起動しない
- CLI の `dg` は同梱しない。画面は `dg` なしで動く。エージェントや CLI から使うには `dg` を入れる。npm には未公開なので、今は [deguboard の README の「使い始める」](https://github.com/brainpad-whiterabbit/deguboard#使い始める)のとおり clone してビルドする（公開後は `npm i -g deguboard`）
- リポジトリで `dg init` を済ませていることが前提
- Run の記録と集計の始め方は [deguboard の README](https://github.com/brainpad-whiterabbit/deguboard#readme)
