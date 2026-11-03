# deguboard for VS Code

Git-native な AI ワークフロー・チケット管理ツール [deguboard](https://github.com/brainpad-whiterabbit/deguboard) の画面を VS Code の中で開く。

- Activity Bar の deguboard のアイコンを押すと、サイドバーに開いているフォルダ（リポジトリ）の画面が出て、上部のタブでカンバン・バックログ・履歴・Run を切り替える。チケット・Iteration・Epic を押すと詳細がエディタ領域に開く（チケットの詳細は本文・属性・依存・Run の一覧・経過）。`dg` やエージェントが書いた変更（Run の開始・終了を含む）は自動で画面に映る。タイトル行の同期ボタンで `dg sync` と同じ同期をして画面を読み直す（リモートがなければ読み直すだけ）。未 push・未取り込みの件数はバッジで出す。タイトル行の歯車で `config.yaml` の設定画面を開き、もう一度押すと元の画面に戻る（チーム全員に効く。VS Code の settings.json は使わない）。Project が 1 つなら Project の段は出さない
- サイドバーのカンバンは次のように出す
  - 見出しの 1 段目に閉じていない Iteration の札（進みつき）と「なし n」「+」を並べ、押すと切り替える（「+」は Iteration を作る）
  - 見出しの右端の漏斗で Epic と担当の絞り込みを開く。絞っている値は見出しの下に札で出し、× で外せる
  - 節の上の実行計画の帯は Plan ごとに 2 行（番号・状態・進み、作業中と次に着手するチケット）で、行を押すとその Plan の依存グラフを開閉する
  - 行の頭の回る印と「実行中」で、このマシンで Run が実行中のチケットを示す
  - 行の右端に担当の印（人は頭文字の丸、agent は持ち主の頭文字の丸と汎用のアイコン（Run の agent によらず 1 種）。ホバーで主体 ID と Run の agent）と Plan の番号、todo なら着手可か待ちの相手を出す。待ちと承認待ちの行は、実行中の Run がなければタイトルを薄くする
- サイドバーのバックログは次のように出す。細部は要件定義書の [UI-3・UI-12](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md#64-画面web-uivs-code-拡張)
  - 行を右クリックすると「Iteration を移す」（ドラッグと同じ）・「詳細を開く」・「ID をコピー」が出る
  - 検索欄の下によく使う絞り込みのチップと、効いている条件を × で外せる札を出す。行にはカンバンと同じ Plan の番号と着手可・待ち、優先度の札（low・medium・high）、自分とその agent 以外の担当の印を出す
- サイドバーの履歴は次のように出す。要件定義書の [UI-5](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md#64-画面web-uivs-code-拡張)
  - 件数付きの「Iteration / Epic / チケット」で見方を切り替える。Iteration・Epic の行を開くと中の終わったチケットを 1 本の一覧で出し、チケットの見方は終えた新しい順の 1 本の一覧にする
  - 検索中は当たったチケットを含む行を開き、当たったものだけを印付きで出す。Iteration の行の「Run の集計」で、その Iteration に絞った Run のタブを開く
- エディタ領域には詳細だけを出す。詳細の中から一覧（Epic で絞ったカンバンなど）を開くと、サイドバーがその画面に切り替わる
- 複数のフォルダを開いているときは、サイドバーは最初のフォルダを対象にする（ビューの見出しにフォルダ名が出る）
- 画面の読み書きは拡張に同梱した core が直接行う。サーバーは起動しない
- CLI の `dg` は同梱しない。画面は `dg` なしで動く。エージェントや CLI から使うには `dg` を入れる。npm には未公開なので、今は [deguboard の README の「使い始める」](https://github.com/brainpad-whiterabbit/deguboard#使い始める)のとおり clone してビルドする（公開後は `npm i -g deguboard`）
- リポジトリで `dg init` を済ませていることが前提
- 画面の主体名は `git config deguboard.user <名前>` で変えられ（環境変数の届かない VS Code でも効く）、`dg whoami` で確かめられる。優先順は `dg --help` の `--user` か要件定義書の [AG-1](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md#65-エージェント連携)
- Run の記録と集計の始め方は [deguboard の README](https://github.com/brainpad-whiterabbit/deguboard#readme)
