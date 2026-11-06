# deguboard の使い方（エージェント向け）

deguboard は Git で管理するチケットのツール。あなた（AI エージェント）は `dg` を Bash から呼んでチケットを読み書きする。人は「何を作るか」「どの順で進めるか」「成果物を承認するか」を決め、あなたは起票・計画・実装・レビューを進める。

## 毎回守ること

- `dg` は必ず `--json` を付けて呼び、結果の `ok` と `data` を読む。失敗は `error.code` と `error.message`。終了コードは 0 成功 / 1 失敗 / 2 使い方の誤り
- 毎回 `--actor agent` を付ける（環境変数は Bash の呼び出しをまたいで残らないことがある）。人だけに限られた操作はエージェントには拒否される（`TRANSITION_REJECTED`）。拒否されたら人に頼む
- あなたは `<ユーザ>/agent`（例：`eiki/agent`）として記録される。ユーザは `--user`・`DEGUBOARD_USER`・git config の `deguboard.user`・git の `user.name`・OS のユーザ名の順で決まり（`whoami` の `user_source` が出どころ）、人本人は `<ユーザ>`。チケットの起票者（`created_by`）と担当者（`assignee`）はこの形で入る。コマンドの `--created-by` と `--assignee` には `human`（ユーザ本人）か `agent`（ユーザの AI）の略記も書ける
- データのファイル（`.git/deguboard/` の下）を直接編集しない。読むのも `dg … show --json`
- チケットの ID は `t12` でも `12` でもよい。Epic は `e3`、Iteration は `s3`。リポジトリの外から呼ぶときは `-C <dir>`
- 書き込みは `commit.mode`（今は `{{commit.mode}}`）に従ってコミットされる。起票・claim・Iteration の start と reopen は即座にコミットして push される。`batch` ではそれ以外の変更が作業ツリーに残るので、区切りで `dg --json --actor agent sync` を回す。`manual` では `sync` もコミットしないので、人に `dg commit` を頼む
- 作業の実績は Run で残す。実装の Run は自分の `ticket claim` が開くので `data.run` の ID を控える（実装をサブエージェントに渡すなら `--no-run` で claim し、サブエージェントが開く）。見直し・手直しなどほかの Run は `dg --json --actor agent run start <id> <step> --agent <エージェント>` で自分で開く。終えたら `run finish <Run の ID> --result <結果>` で閉じる。使用量（トークン数）は finish が会話記録から取り込むので、数を自分で書かない。手順は `dg guide run` の「Run を記録する」
- 起票の結果に `provisional: true` があれば push できていない仮番号で、ID が変わりうる。人に伝え、`sync` を回す

## 同期が止まったとき

書き込みと `sync` は、リモートの deguboard ブランチを取り込んでから push する。止まったら次のとおりにする。どの場合もデータのファイルは直さない。

- **競合**：`sync` の `data.conflicts` が空でない（`ok` は true のまま）か、起票・claim・Iteration の start と reopen が `SYNC_CONFLICT` で失敗した。両側が同じフィールドを違う値に変えたか、本文の同じ行を変えている。ローカルのコミットは残り、解消するまで push・照合・起票・claim・Iteration の start と reopen が止まる。自分では解かず、`conflicts` のファイルと `data.status` の `ahead`・`behind` を人に伝え、どちらの値を残すかを決めて解消してもらう（人の戻し方：deguboard worktree で `git rebase <remote>/deguboard` から解いて `git rebase --continue` するか、`git reset --hard <remote>/deguboard` でローカルのコミットを捨てて操作をやり直す）。解消されたら `sync` を回し、`conflicts` が空になったことを確かめてから続ける
- **push の拒否が続く**：起票・claim・Iteration の start と reopen が `PUSH_FAILED` で失敗したら、何も取得できておらず、コミットも残っていない。少し置いて同じ操作をやり直す（claim なら先に `ticket show` で誰かが着手していないか確かめる）。それ以外の書き込みで push できなかった警告が出たら、コミットはローカルに残り、次の `sync` が再送する
- **リモートに届かない**：コミットはローカルに残り、起票した番号は仮番号（`provisional: true`）になる。届くようになったら `sync` を回す。仮番号がリモートの番号と重なっていれば `sync` が振り直し、`data.renumbered` に `{ from, to }` を出す。振り直されたら、人に伝えた番号を直して伝え直す。仮番号のほかに競合があるときと、`manual` で未コミットの変更が残るときは振り直せず、上の競合として出る

## 人だけに限られうる操作

既定ではすべての操作をエージェントも行える。制限は設定で足す。

- コマンド単位：`config.yaml` の `actor.human_only` に入ったコマンドは agent からは拒否される。今の設定：{{actor.human_only}}。例：`plan.approve`（計画の承認を人に限る）、`epic.close`、`iteration.close`
- チケットの遷移：Workflow の `transitions` が `by: [human]` を書いた遷移（abandoned にする、done から戻す、など）は agent からは拒否される。`dg --json --actor agent workflow show <id>` で確かめられる
- チケットをやめる（abandoned）、done の取り消し、Epic や Iteration を閉じる・再開するのは人の判断に関わるので、拒否されなくても、人の指示がないときは実行する前に人に確かめる
- Plan の承認（`plan approve`）は、拒否されなくても人が承認したときだけ行う（`dg guide plan`）

## トピック

| トピック | Skill     | 内容                                                                                                                              | 読むとき                                                       |
| -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| import   | dgimport  | 会話の内容をチケットに起こす（分解、依存、Epic、下書きの取り込み）                                                                | 要件が固まり「チケットにして」と言われたとき                   |
| assign   | dgassign  | Iteration（スプリント）と Epic に入れる                                                                                           | 「スプリントに入れて」と言われたとき                           |
| check    | dgcheck   | `sync`・`validate`・`lint` の指摘と直す案を表で示し、承認を得て直す                                                               | 計画を立てる前・「点検して」と言われたとき                     |
| plan     | dgplan    | どの順で進めるかを決め、Plan に記録して人の承認を得る（依存、`--ready`、`plan create`・`plan approve`）                           | 複数のチケットを進める前                                       |
| work     | dgwork    | 1 枚のチケットを進める（Plan の順と範囲、claim、worktree、受け入れ条件の確認、PR、照合。PR の要らない作業も）                     | チケットに着手するとき                                         |
| run      | なし      | Run の記録と Plan の段階ごとのモデル、閉じ損ねた Run の始末（work・parallel・review から読む補助）                                | Run を記録・モデルを選ぶ・閉じ損ねた Run を始末するとき        |
| parallel | なし      | Plan の着手できるチケットをチケットごとのサブエージェントで同時に進める（上限、親とサブエージェントの役割、1 件でほかを止めない） | 着手できるチケットが複数あり、サブエージェントを起動できるとき |
| review   | なし      | PR を出す前とマージの前の品質ゲート（検査・受け入れ条件・見直し・衝突なし）と、別のサブエージェントの見直し・上限付きの修正ループ | PR を draft で出したあと・自動でマージする前                   |
| audit    | dgaudit   | リリースの前にリポジトリ全体を観点ごとに見直し、指摘を承認を得て起票する（サブエージェント。ファイルは直さない）                  | Iteration か Epic のチケットがすべて done になったとき         |
| release  | dgrelease | Iteration のチケットがすべて done かを確かめ、リポジトリのリリースの手順で進めて Iteration を閉じる                               | 見直しを終えてリリースするとき                                 |
| done     | dgdone    | マージ後の後始末と残った受け入れ条件の確認、Plan を閉じる                                                                         | PR がマージされたあと                                          |
| all      | dgall     | 割り当て → 点検 → 計画 → 作業 → 見直し → リリースを、状態から段階を求めて続けて進める（同じ引数で再開できる）                     | 「s3 を最後まで進めて」と言われたとき                          |

`dg guide <topic>` で読む。Claude Code では `dg skill install` が入れる Skill（`/dgimport` など）がそのトピックを読む。Skill は任意で、なければ `dg guide <topic>` を読んで同じ手順で進める。コマンドの一覧は `dg --help`、各コマンドのオプションは `dg <群> <操作> --help`。
