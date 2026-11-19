# 使い方の細部

[English](usage.md) | 日本語

[README](../README.ja.md) の「使い方」に収めない、人がする操作をまとめる。コマンドの細部は `dg <コマンド> --help`、エージェントの手順は `dg guide <topic>`、約束は [requirements.md](requirements.md) が正本で、ここには写さない。

## Skill 一覧

Skill は Claude Code 向けです。普通の言葉で頼むか、コマンドを打ちます。コマンドの列は例で、引数は Skill の `argument-hint` と `dg guide <topic>` にあります。Skill を入れていないエージェントには、Ask Agent の文章の形を使います。

| Skill       | 何をするか                                                                                              | 頼み方の例                        | コマンド                |
| ----------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------- |
| `dgimport`  | 会話・計画・設計書を、承認を得てチケットにする                                                          | 「この検討をチケットにして」      | `/dgimport`             |
| `dgassign`  | チケットを Iteration か Epic に入れる（承認を得てから）                                                 | 「これをスプリントに入れて」      | `/dgassign s3`          |
| `dgcheck`   | チケット・Epic・Iteration・Plan の食い違いを見つけ、直す                                                | 「s3 のチケットを点検して」       | `/dgcheck s3`           |
| `dgplan`    | チケットの進める順を決め、承認待ちの Plan に記録する                                                    | 「s3 を計画して」                 | `/dgplan s3`            |
| `dgwork`    | 承認した Plan を ready・承認後のマージ・片付けまで進める                                                | 「p3 を進めて」                   | `/dgwork p3`            |
| `dgall`     | Iteration かチケットを、割り当てからリリースまで一つの流れで進める                                      | 「s3 を自動でリリースまで進めて」 | `/dgall s3 --auto`      |
| `dgaudit`   | リリースの前に、リポジトリ全体を観点ごとに見直し、指摘を起票する                                        | 「リリースの前に見直して」        | `/dgaudit s3`           |
| `dgrelease` | Iteration の完了を確かめてリリースを準備する。既定では関所を通すことと Iteration を閉じることは人に頼む | 「s3 をリリースして」             | `/dgrelease s3`         |
| `dgdone`    | マージ済みのチケットが完了かを確かめ、残った枝と worktree を片付ける                                    | 「t12 はマージした。片付けて」    | `/dgdone t12`           |
| `dgretro`   | 閉じた Iteration を、チームの観点で振り返る                                                             | 「s3 を振り返って」               | `/dgretro s3`           |
| `dgchange`  | 人が頼んだ変更を一つ行う（直す・閉じる・再開・やめる・取り消す）                                        | 「s3 を閉じて」                   | `/dgchange s3 閉じて`   |
| `dgdiscuss` | チケット・Epic・Iteration の論点を、人と相談して決める                                                  | 「t12 を検討して」                | `/dgdiscuss t12`        |
| `dgstatus`  | 進行中のチケットの作業がどこまで進み、止まっていれば理由を教える                                        | 「t12 はどこまで進んだ？」        | `/dgstatus t12`         |
| `dgexplain` | チケット・Epic・Iteration の中身を、図を入れて人に説明する                                              | 「t12 を説明して」                | `/dgexplain t12`        |
| `dgconfig`  | 設定と Workflow の項目を説明し、変更は前と後の差の承認を得てから書く                                    | 「commit.mode って何？」          | `/dgconfig commit.mode` |

## 最後まで任せる

Claude Code で `/dgall s3 --auto` のように Iteration かチケットを渡すと、エージェントが割り当て・計画・実装・見直し・リリースを続けて進める。割り当ては、渡したチケットのうちどの Iteration にもないものの Iteration を決めるだけで、Iteration を渡すとその中のチケットを進め、ほかの todo を入れるかは聞かない（入れるには `/dgassign`）。作りたいものの起票はしないので、先に `/dgimport` でチケットにする。

- `--auto` を付けると、カンバンの Workflow（`workflow.yaml`）の値が `ask_unless_auto` の場面だけを聞かずに進める。既定では、割り当て・点検の直し・Plan の承認・チケットの着手（todo → in_progress）・品質ゲートを通った PR のマージ。ほかの場面は `--auto` でも止まって聞く。既定では、見直しの指摘、リリースの PR のマージと公開、チケットをやめる・done を取り消す、Epic を閉じる・再開するなど。人だけが行う操作（`human_only`）もあり、エージェントは承認があっても行えないので、コマンドを示して人を待つ。既定では、リリースの関所を通すことと Iteration を閉じること（`dg checkpoint release <S>`・`dg iteration close <S>`）、チケットの削除（値の見方と変え方は [Workflow](#workflow)、一覧は `dg guide all`）
- 品質ゲートを通った PR は、エージェントがマージしてよいかを聞き、承認したときだけマージする（承認は PR に残る）。聞かずにマージするのは、`--auto` で、review → done の境目の値が `ask_unless_auto`（既定）のときだけ。品質ゲートを満たさない PR は、満たさない条件を示してそれでもマージするかを聞く。承認すれば満たさない条件を越えてマージするが、PR が開いていて下書きでないこと、base と衝突しないこと、判定したコミットをマージすることは越えられない
- 進み具合はカンバンで見られ、計画の帯の Plan の行を押すと依存のグラフが開く
- Claude Code 以外のエージェントには「`dg guide all` を読んで、`--auto` で最後まで進めて」と頼む

## 品質ゲートの段

PR を ready にする・マージするときに判定する条件は、チケットの段（`gate`）で変わる。

| 段             | 判定する条件                        |
| -------------- | ----------------------------------- |
| `high`（既定） | 検査と独立した見直しを含むすべて    |
| `low`          | 見直しを除く（検査はする）          |
| `free`         | PR が開いていて、衝突しないことだけ |

段はチケット詳細か `dg ticket update <id> --gate <段>` で付ける。`/dgall`・`/dgwork` に `--gate-high`・`--gate-low`・`--gate-free` を付けると、対象のチケットの段を指定する（付けなければ各チケットの段のまま）。段を上げるのはその場で反映する。段を下げる（high → low → free）のは人だけができる。エージェントの呼び出しを dg が拒否するので、流れはチケットごとに `dg ticket update <id> --gate <段>` を打つよう人に頼んで待つ。条件の細部は `dg gate --help`。

## Workflow

カンバンの Workflow（`workflow.yaml`）は、カンバンで誰が何をしてよいかを決める。エージェントが自分で行う Status の動き、先に人に聞く場面、人だけが行えること、`--auto` で聞かずに進める段階がここで決まる。Workflow はカンバンに 1 つでチームが共有し、個人の上書きはない。設定（`config.yaml`）とは別のファイルになる。`dg init` が既定の Workflow を置き、ファイルで省いた項目（ファイルがないときはすべて）は既定になる。

### 何を決めるか

| 項目         | 決めること                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `states`     | 5 つの Status の表示名。Status は増やせず、減らせない                                                                                                                      |
| `boundaries` | 前へ進む 3 つの動き（todo → in_progress、in_progress → review、review → done）ごとに、求める Git の事実（`requires`）と誰が決めるか（`decide`）                            |
| `exceptions` | 流れの外の動きを誰が行えるか：`abandon`（abandoned にする）、`back`（前の Status に戻す）、`reopen`（done から戻す）                                                       |
| `wip`        | 列ごとのチケットの上限                                                                                                                                                     |
| `flow`       | 流れの段階（`assign`・`check`・`plan`・`audit`・`release`・`retro`）ごとに誰が決めるか、飛ばす段階（`skip`）、独自の段階                                                   |
| `governance` | チケットの削除（`delete`）、チームの設定の変更（`config`）、ほかの人の担当と claim の変更（`reassign`）、Epic を閉じる・再開する（`epic`）、起票（`create`）を誰が行えるか |

`requires` に書ける事実は、`deps_done`（依存するチケットが done）、`branch_exists`、`branch_pushed`、`branch_merged`、`pr_open`、`pr_draft`、`pr_merged`。`!pr_draft` のように前に `!` を付けると、その事実が偽であることを求める。

### 値の意味

`decide` と、`exceptions`・`flow`・`governance` の値は、次のどれかをとる。

| 値                | 人                           | エージェント                                        |
| ----------------- | ---------------------------- | --------------------------------------------------- |
| `anyone`          | 行える                       | 行える                                              |
| `ask_unless_auto` | 行える                       | 先に人に聞く。`--auto` で始めた流れでは聞かずに行う |
| `always_ask`      | 行える                       | `--auto` でも先に人に聞く                           |
| `human_only`      | 行える                       | 拒否される。エージェントは人が打つコマンドを示す    |
| `agent_only`      | `--override "<理由>"` が要る | 行える                                              |

エージェントが人の承認を得て行うと、dg は承認者を記録する（`dg history` で見られる）。`dg sync` が Git の事実から行う動きはエージェントの側に数える。満たさない `requires` は、人が `--override "<理由>"` で越えられる。

既定では、エージェントは review への移動を自分で行う。チケットの着手（todo → in_progress。チケットを進める指示と、そのチケットを含む Plan の承認は、着手の承認に数える）、PR のマージ（review → done）、割り当て、点検の直し、Plan の承認は先に人に聞き、`--auto` ならこれらを聞かずに進める。チケットをやめる・done から戻す、見直しの指摘と振り返りの改善の起票、チームの設定の変更、ほかの人の claim の変更、Epic を閉じる・再開するのは、いつも先に聞く。Iteration を閉じる（リリース）とチケットを削除するのは人だけが行える。WIP の上限は in_progress が 5、review が 3。

### Core の固定

次の操作は Core が固定し、`workflow.yaml` では緩められない：Workflow 自体の変更（`dg workflow set`）にはいつも人の承認が要る。フックを外す・このクローンから deguboard を外す（`dg uninstall`）・チケットの段を下げる操作は人だけが行える。品質ゲートを満たさない PR のマージにはいつも人の承認が要る。

### 見る・変える

- **見る**：`dg workflow show` が値ごとに既定と変えたかどうかを出し、その `moves` が Status の動きごとに人とエージェントにとっての意味を出す。設定画面の Workflow タブも同じ行を出し（読むだけ）、行からエージェントに頼める
- **変える**：`/dgconfig` に「flow.release は何をする？」「Iteration を閉じるのを、聞いてからならエージェントに任せたい」のように頼む。エージェントは変わる値ごとに前 → 後を示し、承認したときだけ `dg workflow set` で書く。Skill を使わないときは、`dg --json workflow show` の `definition` をファイルに書き、値を変えて `dg workflow set --file <ファイル>` を打つ。データのブランチの `workflow.yaml` を直接編集しない
- **検査する**：`dg workflow validate` がファイルの誤りを指摘する。誤りのある Workflow は使わない

項目ごとの意味は `dg workflow show --help`、独自の段階は `dg flow next --help` にある。

## 同期の競合を解く

同じチケットの同じ項目を二人が違う値に変えると、同期は push の前で止まり、通知に競合した項目の remote と local の値が並ぶ。

- 通知の「remote を採る」か「local を採る」を押すと、競合した項目だけがその側の値になる（ほかの変更は残る）。ターミナルでは `dg sync --resolve remote` か `dg sync --resolve local`
- 解くまで、push と、起票・claim のようにすぐ push する書き込みは待つ
- `config.yaml` や Workflow（`workflow.yaml`）の競合にはボタンが出ない。`dg sync` の警告にある手順で、人が手で解く

エージェント向けの手順は `dg guide overview` の「When sync stops」、細部は `dg sync --help`。

## データを別のリポジトリに置く

カンバンのデータ（`deguboard` ブランチ）は、既定ではコードと同じリモートに fetch・push する。コードとは別のリポジトリに置くには、そのリポジトリを指す git のリモートの名前を、config の `git.data_remote` に書く。作業ブランチと PR はコードのリモート（`git.remote`）のままで、クローンの中のデータの置き場所も変わらない。

新しくカンバンを始めるときと、新しいクローンから加わるときは、`dg init` にデータのリポジトリを渡す（リモートの名前か URL。URL なら dg がリモートを足す）。

```sh
dg init --data-remote git@github.com:acme/kanban.git
```

VS Code では、導入のチェックリストのボードの項目で同じことができる。チームのボードが別のリポジトリにあることを選び、リポジトリとブランチを入れて確かめる。ボタンは `--data-remote` と `--data-branch` を付けて `dg init` を実行する。

データのリモートに届かない（ネットワーク・認証・URL のどれかが違う）ときは、`dg init` はボードを作らずに止まる。接続を直してから `dg init` をもう一度実行すると、チームのボードを取り込む。VS Code では、ボードの項目が理由と「もう一度確かめる」ボタンを出す。「チームのボードがないと分かっているなら」の下にある別のボタンは `dg init --new-board` を実行し、手元だけにボードを作る。リモートにすでにボードがあると、新しいボードは履歴を共有しないので、`dg sync` は `DATA_HISTORY_UNRELATED` で止まる。`--new-board` は、チームにまだボードがないと分かっているときか、別のボードを作ると決めたときだけ使う。

今あるカンバンを別のリポジトリへ移すときは、人が次の順に行う。

1. `dg sync` を実行し、新しいリポジトリをリモートに足して、データを push する

   ```sh
   dg sync
   git remote add kanban git@github.com:acme/kanban.git
   git push kanban deguboard
   ```

2. config を変えてから同期する。`dg config set` は変更をすぐ元のリモートへ push し、続く `dg sync` が新しいリモートへ push するので、両方に変更が入る

   ```sh
   dg config set git.data_remote kanban
   dg sync
   ```

3. ほかのクローンは、同じ名前でリモートを足し（`git remote add kanban <URL>`）、`dg sync` を実行する。config の変更を取り込んだ最初のコマンドは、push せずに止まってもう一度の実行を求め、それ以降そのクローンは新しいリモートを使う。VS Code でカンバンを開いているクローンは、変更を先に自動で取り込んでいることがあり、そのときは次のコマンドが止まらずに新しいリモートを使う。リモートを足していないクローンは止まり、`git remote add` のコマンドを示す。そのクローンだけ別の名前のリモートを使うなら、`dg config set git.data_remote <名前> --local` を実行する
4. すべてのクローンが移ってから、元のリモートのブランチを消す。移っていないクローンは元のリモートへデータを push し直すので、最後に行う

   ```sh
   git push origin --delete deguboard
   ```

カンバンのデータのブランチが `deguboard` でないとき（次の節）は、1 で `git push kanban deguboard:<データのブランチ>` と push し、4 で `<データのブランチ>` を消す。

## 1 つのリポジトリに複数のカンバンを置く

カンバン専用のリポジトリ 1 つに、複数のコードのリポジトリのカンバンを並べられる。リポジトリごとに `git.data_branch` でデータのブランチを分け（`deguboard-<名前>` を勧める）、各クローンは自分のブランチだけを fetch・push する。カンバンはリポジトリごとに分かれ、番号・依存・Iteration・Epic はリポジトリをまたがない。

```sh
# webapp のリポジトリで
dg init --data-remote git@github.com:acme/kanban.git --data-branch deguboard-webapp
# api のリポジトリで
dg init --data-remote git@github.com:acme/kanban.git --data-branch deguboard-api
```

- 新しいクローンも、同じ `--data-remote` と `--data-branch` で `dg init` する。ブランチ名は config の `git.data_branch` に入るが、config はデータの中にあるので、最初の init には渡す
- ブランチ名に `/` は使えない。`deguboard/webapp` は拒まれ、`deguboard-webapp` を勧められる
- データのリモートかデータのブランチが、ほかのカンバンのブランチを指したとき（共通の履歴がなく、両方がデータを持つ）は、`dg sync` と書き込みは取り込む前に `DATA_HISTORY_UNRELATED` で止まる。このカンバンに自分のブランチを与える：`dg init --data-branch <ブランチ>`（たとえば `deguboard-<リポジトリ>`）、`dg sync`、`dg config set git.data_branch <ブランチ>` の順に実行する
- 見る権限はリポジトリ単位でしか分けられない。専用のリポジトリを読める人は、そこのどのカンバンも読める。一部の人にだけ見せるカンバンは、別のリポジトリに置く
- 今あるカンバンのデータのブランチ名を変えるときは、前の節の手順を同じリモートで行う。1 で `git push <データのリモート> deguboard:<新しい名前>`、2 で `dg config set git.data_branch <新しい名前>` と `dg sync` を実行し、4 で元のブランチを消す。共有のリポジトリへ新しい名前で移すときは、先にブランチ名を変えてから、リポジトリへ移す（1 つずつ移す）。両方を一度に変えると、次のコマンドが新しいリポジトリの元のブランチ名へ push し、そこがほかのカンバンのブランチのこともある

## 振り返りの観点と指標

`/dgretro` は、閉じた Iteration をチームの観点で振り返る。観点はチームの `config.yaml` の `retro.perspectives` に置く。既定の観点は 7 つで、Outcome（成果、`outcome`）・Review effectiveness（見直しの効き目、`review`）・Spec quality（仕様の質、`spec`）・Slicing（分け方、`slicing`）・Agent stability（エージェントの安定、`stability`）・Cost（コスト、`cost`）・Improvement tracking（改善の追跡、`improvement`）。最初はどの観点にも指標はない。

- **指標とは**：dg が計算する式ではなく、数え方の文と、数の出どころのコマンドの組。振り返りのたびに、エージェントが定義を読んでコマンドを実行し、対象の Iteration と直近の回の値を計算して傾向を出す。値は保存しない
- **指標の決め方**：指標のない観点には、エージェントが dg の持つ推薦の指標を参照して指標を提案する。記録するのは人が承認したものだけ。トークンを数える指標には `metrics.read_transcripts` が要る（[トークンを数える](#トークンを数える)）
- **変える**：`dg retro perspective` で観点を足すか名前・問いを変え、`dg retro metric` で承認した指標を記録し、`dg retro remove` で指標か観点ごと消す。`dg config unset retro.perspectives` で既定の観点に戻る。`dg config set` と設定画面では書けない
- **見る**：`dg config show` か、設定画面（読むだけ）

推薦の指標とその定義、引数は `dg retro --help` と `dg guide retro` にある。

## トークンを数える

トークンは、会話記録から使用量を取り込む設定を有効にしたときだけ集計されます（Claude Code・Codex・Copilot CLI）。設定するには次のとおりにします。

```sh
dg config set metrics.read_transcripts true
```

設定はチームで共有されます。自分のマシンだけ止めるときは `DEGUBOARD_NO_TRANSCRIPTS=1` を設定します。

## 承認待ちの通知

承認待ちの Plan と review のチケットがあると、サイドバーのタイトルに件数が出て（「DEGUBOARD: 承認待ち 3」）、増えたときは通知が出る。通知の「開く」で詳細が開く。

承認待ちの通知は設定画面（歯車）の「通知」で切れる（件数の表示は残る）。チームの設定のまま自分だけ切るときは、設定画面の「自分」のタブか `--local` を使う。

```sh
dg config set notify.approvals false --local
```

## リモートの更新を取り込む

VS Code でカンバンを開いている間、dg は間を空けてリモートを fetch する。リモートの更新が fast-forward だけで取り込めるときは、確かめずに取り込んで画面を読み直す。未 push のコミット・未コミットの変更・途中の rebase・dg の外の変更があるときは取り込まないので、同期のボタンを押す。人の同期が要る間は、サイドバーのタイトル行の同期のボタンに点が付き、ツールチップに件数が出る。未 push のコミットがある間（「同期（未 push 1 / 未取り込み 2）」）と、dg が取り込めずにリモートの更新が残っている間（「同期（未取り込み 2・自動では取り込めません）」）である。Activity Bar のアイコンの数字は、未 push のコミットと未取り込みのリモートの更新の合計を示す。

## 導入のチェックリスト

導入のチェックリストの項目が欠けている間は、サイドバーのタイトル行の左端のセットアップのアイコンに点が付き、ツールチップに欠けている件数が出る（「セットアップ（2 件が欠けています）」）。

## チケットへ移動する

コマンドパレットの「deguboard: チケットへ移動」（Go to Ticket）か `Ctrl+K Ctrl+Alt+G`（macOS は `⌘K ⌘⌥G`）で、チケット・Iteration・Epic・Plan を ID かタイトルで絞り込んで詳細を開く。

## CLI で使う

画面と同じ操作をターミナルの `dg` でも行える。コマンドパレットの「dg コマンドを入れる」（Install dg command）が `~/.local/bin/dg` を張る（PATH に `~/.local/bin` がなければ足す）。

```sh
dg ticket create "ログインの検証" --summary "入力の検査" --acceptance "空のとき拒否する"
dg ticket list                # --json で機械向け
dg --help                     # コマンドの一覧
```

Skill を入れていないエージェントには、`dg ask --format text` で作った文章を貼って頼める。

## エージェントへの指示を書く

dg はエージェントへの指示（`CLAUDE.md`・`AGENTS.md`）を書かず、変えもしない。Skill と `dg guide` が作業をカンバンに載せるのは、頼みごとがそれらを通るときだけで、「このバグを直して」のようにどの Skill にも当たらない頼みは、claim もチケットもなしにそのまま進む。エージェントへの指示に数行足すと、そうした作業もカンバンに載る。

```markdown
## チケット

- チケットは `dg` で読み書きする。`.git/deguboard/` を直接編集しない
- 作業は `dg ticket claim <id>` から始め、PR の本文にチケットの ID（`t12` など）を書く
- dg が操作を拒否したら（`TRANSITION_REJECTED`）、人に実行を頼む
- リリース：<リリースの手順>
```

- エージェントの PATH に `dg` がないときは、呼び方も書く。たとえば `~/.local/share/deguboard/dg`（拡張が入れるランチャー）か、[CLI で使う](#cli-で使う)の「dg コマンドを入れる」
- `dg guide release` の手順は、リポジトリの規約（エージェントへの指示・README・開発の文書）からリリースの手順をエージェントに探させる。見つからなければ、エージェントは手順を推し量らず、リリースなしで Iteration を閉じるかを人に尋ねる

dg の手順（計画・実装・見直し・マージの進め方）は、エージェントへの指示に写さない。`dg guide` はエージェントへの指示に写したものを読まず、guide は dg に同梱されるので、写しは dg を更新すると古くなる。リポジトリに合わせて手順を変えるときは、見出しのない文書を書き、そのパスを `guide.notes.<topic>`（たとえば `guide.notes.work`）に設定する。dg はそれを `dg guide <topic>` の題の直後に差し込む。検査のコマンドは `actions.test` と `actions.light_test` に置く。値は `dg config show` で見て、`/dgconfig` で変える。

## 他のエージェントで使う

dg のフックは、エージェントの協力なしに Run を記録し、データとマージを守る。フックが届くのは今は Claude Code だけなので、ほかのエージェントでは次の違いがある。フックがセッションに届いているかは、リポジトリで `dg hooks check` を実行して確かめる。このコマンドは、Claude Code の設定にフックがあるかを確かめ、各フックの dg コマンドを `--version` で実行して動くかを確かめ、dg が受け取ったフックの記録を調べる。フックのないエージェントでは届いていないと警告するだけになる（入れ直したあとにも回せる）。

フックが届かないエージェントでは、次のとおりになる。

- Run は、エージェント自身の `dg run` の呼び出しでしか残らない。サブエージェントの Run は自動で開いて閉じられないので、親のエージェントが実装と手直しを自分で行ってよく、`dg run` で Run を開いて閉じる（guide の手順がそう案内する）
- 直接の書き換えと、dg を経由しない PR の ready・マージを止めるガードが効かない。`.git/deguboard/` の直接の書き換えや、`dg pr merge` を経由しない `gh pr merge` を止めるものがなく、応答の終わりに dg の外の変更を知らせない
- トークン数は、会話記録を読めるエージェント（今は Claude Code・Codex・Copilot CLI）だけで集計される。数えるには、[トークンを数える](#トークンを数える)の設定を有効にする
- 見直し役を起動できないエージェントは、PR の見直しを人に頼み、PR の本文に見直していないと書く

## Claude Desktop から使う（MCP）

`dg mcp` は stdio の MCP サーバーで、`dg` のコマンドをツールとして出す。`claude_desktop_config.json` の `command` に、拡張が入れる起動ファイル `~/.local/share/deguboard/dg` の絶対パスを書き（JSON は `~` を展開しないので、macOS は `/Users/<you>/...`、Linux は `/home/<you>/...`）、引数に `-C <対象のリポジトリ>` と `mcp` を渡す。Claude Code は Bash で `dg` を呼べるので、登録は要らない。

```json
{
  "mcpServers": {
    "deguboard": {
      "command": "/Users/<you>/.local/share/deguboard/dg",
      "args": ["-C", "/path/to/repo", "mcp"]
    }
  }
}
```

## 書き込む場所と実行するコマンド

ボードのデータは `.git/deguboard/` に置く。拡張は起動のたびに、`.git` の外へ次の 2 つだけを書く。

- ターミナルとフックが呼ぶ `dg` の起動ファイルと、同梱の `dg` を指す `current`。`~/.local/share/deguboard/` に置く
- リポジトリの `.claude/skills/` と `~/.claude/skills/` に入れてある dg の Skill（`dg*`）。古い版の `dg` が書いたものだけを書き換える。新しい版の `dg` が書いた Skill は上書きせず、手で直した Skill は残して警告を出す

入れていない Skill は自分からは入れない。dg の Skill を入れてある置き場所に足りない同梱の Skill があれば、通知で知らせる。

- **入れる** を選ぶと入れる。リポジトリに入れたときは、`dg skill install` と同じく、入れた Skill ごとの行を `.claude/.gitignore` に足す（コミットする）
- **今後は表示しない** を選ぶと、その Skill は知らせない

`~/.local/bin/dg` は「dg コマンドを入れる」でだけ書き、「dg コマンドを外す」で外す。

拡張が自分で起動するコマンドは `git`・`gh`・`dg --version` だけで、信頼したフォルダーでだけ動く。ほかのコマンドと文はターミナルに入れ、人がボタンを押したときだけ入れる。

- 導入のチェックリストのボタンは、deguboard のターミナルにコマンドを入れて Enter で実行する。`git init`・`dg init`・チェックリストが示す `dg skill install` と `dg hooks install`・`dg uninstall`（`dg uninstall --personal`）。入れる行は先にフォルダーへ移り（`cd`）、コマンドを `&&` でつなぎ、失敗したところで止まる。`dg` は PATH からではなく起動ファイルの絶対パスで呼ぶ。このターミナルは、これらのボタンを押したときだけ開く
- 行や見出しの **エージェントに頼む** から送ると、依頼文（`dg ask` と同じ依頼文）を、選んだ開いているターミナルに入れる。Enter は押さない。複数行の依頼文はクリップボードを通して貼り付け、クリップボードは後で元に戻す。ターミナルもエージェントも起動しない

Skill は `dg guide` を読ませる文面だけ。フックは `dg hook <イベント>` を呼ぶだけで、Run を記録し、`dg` を通さない PR の ready・マージとデータへの書き込みを拒む。Skill は `dg skill install --dry-run`、フックは `dg hooks install --dry-run` で中身を見られる。dg の Skill は `dg skill uninstall` で外せる（自分の Skill と `.claude/.gitignore` は残る）。deguboard をすべて外すときは[アンインストール](#アンインストール)を見る。

## アンインストール

やめ方は 3 つある。このマシンで止める、1 つのクローンから外す、チームでやめる。リモートのボードのデータに触れるのは最後だけなので、クローンから外した後は `dg init` でボードを取り込み直せる（このマシンで止めた後は、先に拡張を入れ直す）。

VS Code 拡張は最後に消す。フックとマージドライバは、拡張が入れる起動ファイル（`~/.local/share/deguboard/dg`）を通して `dg` を絶対パスで呼ぶ。拡張を先に消すと、フックが毎回失敗し、それを外す `dg hooks uninstall` も動かなくなる。外すには Claude Code の設定を手で直すしかなくなる。

### このマシンで止める

消すもの：各クローンの中のもの（次の節）、`~/.claude/settings.json` の dg のフック、`~/.claude/skills` の dg の Skill、拡張と起動ファイル。

1. deguboard を使ったクローンごとに、次の節のとおりに外す。最後のクローンでは `dg uninstall --personal` を実行し、このマシンのどのリポジトリでも使う個人のフックと Skill も外す。クローンをもう外した後なら、代わりに `dg hooks uninstall --personal` と `dg skill uninstall --personal` を実行する
2. VS Code 拡張を消す。起動ファイル・その `current`・`~/.local/bin/dg` のリンクが、その拡張の `dg` を指していれば、それらも片付く。ほかの版やほかのエディタの拡張が使う起動ファイルは残る

### このクローンから外す

消すもの：`.claude/settings.local.json` の dg のフック、`.claude/skills` の dg の Skill（手で直した Skill は残る）、ボードの worktree（`.git/deguboard`）、手元のデータのブランチ、git config のマージドライバ（`merge.deguboard`）、`.git/deguboard-local`（個人の設定・会話記録・キャッシュ）。残すもの：リモートのデータのブランチ、データのリモート、コミットした `.claude/.gitignore`、`.claude/settings.json` の dg のフック。

リポジトリの最上位で次を実行する。`dg uninstall` を実行できるのは人だけで、エージェントは `--dry-run` だけを実行できる。

```sh
dg sync
dg uninstall --dry-run
dg uninstall
```

- `--dry-run` は、消すもの、残すもの（それぞれを手で消すコマンドつき）、止める理由を出す
- このクローンにしかないもの（送っていないデータ、dg の外でしたデータの変更や dg がコミットしていない変更、進行中か review のチケットの worktree）があるとき、rebase の途中のとき、データを読めないときは、何も消さずに止まる。`--dry-run` は理由ごとに次にすること（`dg sync`・`dg adopt`・`dg commit` など）を出すので、それをしてから実行し直す。`--force` を付けると消し、それらは失われる

VS Code では、Setup のチェックリスト（サイドバーのタイトル行のチェックリストのアイコン）の末尾の **アンインストール** の節を開くか、コマンドパレットの「deguboard: このリポジトリからアンインストール」を実行する。

1. **このリポジトリだけ** か、**個人の Skill とフックも**（`--personal` と同じ）を選ぶ
2. `dg uninstall --dry-run` の結果の **消すもの** と **残すもの** を確かめる。止める理由がある間はボタンを押せない。**同期する** でデータを送る
3. **外す…** を押し、続けて **外す** を押す。deguboard のターミナルで `dg uninstall`（か `dg uninstall --personal`）が動く

外し終わると、画面は始めるときのチェックリストに戻り、拡張は最後に消すことを知らせる。

### チームでやめる

1. フックを共有の設定に入れていたなら、1 人が `dg hooks uninstall --shared` で外し、`.claude/settings.json` をコミットする。これを先にする。そのフックが残ったまま拡張を消した人は、フックが失敗するようになる
2. 全員が、[このクローンから外す](#このクローンから外す)のとおりにクローンから外す
3. `.claude/.gitignore` から dg の行を消してコミットする
4. リモートのデータのブランチをどうするか決める。残すことを勧める。チケット・Plan・Run の履歴があり、dg がなくても読める（たとえば `git show origin/deguboard:tickets/t1.md`）。消すと戻せない。消すときは次を実行する

   ```sh
   git push origin --delete deguboard
   ```

   データを別のリポジトリに置いていたなら、そのリモートとデータのブランチを使う（たとえば `git push deguboard-data --delete deguboard`）。

5. `dg init --data-remote <URL>` がデータ用のリモートを足していたなら、クローンごとに外す

   ```sh
   git remote remove deguboard-data
   ```
