# deguboard の使い方（エージェント向け）

deguboard は Git で管理するチケットのツール。あなた（AI エージェント）は `dg` を Bash から呼んでチケットを読み書きする。人は「何を作るか」「どの順で進めるか」「成果物を承認するか」を決め、あなたは起票・計画・実装・レビューを進める。

## 毎回守ること

- `dg` は必ず `--json` を付けて呼び、結果の `ok` と `data` を読む。失敗は `error.code` と `error.message`。終了コードは 0 成功 / 1 失敗 / 2 使い方の誤り
- 毎回 `--actor agent` を付ける（環境変数は Bash の呼び出しをまたいで残らないことがある）。人だけに限られた操作はエージェントには拒否される（`TRANSITION_REJECTED`）。拒否されたら人に頼む
- あなたは `<ユーザ>/agent`（例：`eiki/agent`）として記録される。ユーザは git の `user.name`（`--user` か `DEGUBOARD_USER` で変えられる）で、人本人は `<ユーザ>`。チケットの起票者（`created_by`）と担当者（`assignee`）はこの形で入る。コマンドの `--created-by` と `--assignee` には `human`（ユーザ本人）か `agent`（ユーザの AI）の略記も書ける
- データのファイル（`.git/deguboard/` の下）を直接編集しない。読むのも `dg … show --json`
- チケットの ID は `t12` でも `12` でもよい。Epic は `e3`、Iteration は `s3`。リポジトリの外から呼ぶときは `-C <dir>`
- 書き込みは `commit.mode`（今は `{{commit.mode}}`）に従ってコミットされる。起票と claim は即座にコミットして push される。`batch` ではそれ以外の変更が作業ツリーに残るので、区切りで `dg --json --actor agent sync` を回す。`manual` では `sync` もコミットしないので、人に `dg commit` を頼む
- 起票の結果に `provisional: true` があれば push できていない仮番号で、ID が変わりうる。人に伝え、`sync` を回す

## 人だけに限られうる操作

既定ではすべての操作をエージェントも行える。制限は設定で足す。

- コマンド単位：`config.yaml` の `actor.human_only` に入ったコマンドは agent からは拒否される。今の設定：{{actor.human_only}}。例：`plan.approve`（計画の承認を人に限る）、`epic.close`、`iteration.close`
- チケットの遷移：Workflow の `transitions` が `by: [human]` を書いた遷移（abandoned にする、done から戻す、など）は agent からは拒否される。`dg --json --actor agent workflow show <id>` で確かめられる
- チケットをやめる（abandoned）、done の取り消し、Epic や Iteration を閉じる・再開するのは人の判断に関わるので、拒否されなくても、人の指示がないときは実行する前に人に確かめる
- Plan の承認（`plan approve`）は、拒否されなくても人が承認したときだけ行う（`dg guide plan`）

## トピック

| トピック | 内容                                                                                                          | 読むとき                                     |
| -------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| create   | 会話の内容をチケットに起こす（分解、依存、Epic、下書きの取り込み）                                            | 要件が固まり「チケットにして」と言われたとき |
| plan     | どの順で進めるかを決め、Plan に記録して人の承認を得る（依存、`--ready`、`plan create`・`plan approve`）       | 複数のチケットを進める前                     |
| assign   | Iteration（スプリント）と Epic に入れる                                                                       | 「スプリントに入れて」と言われたとき         |
| work     | 1 枚のチケットを進める（Plan の順と範囲、claim、worktree、受け入れ条件の確認、PR、照合。PR の要らない作業も） | チケットに着手するとき                       |
| finish   | マージ後の後始末と残った受け入れ条件の確認、Plan を閉じる                                                     | PR がマージされたあと                        |

`dg guide <topic>` で読む。コマンドの一覧は `dg --help`、各コマンドのオプションは `dg <群> <操作> --help`。
