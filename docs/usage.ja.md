# 使い方の細部

[English](usage.md) | 日本語

[README](../README.ja.md) の「使い方」に収めない、人がする操作をまとめる。コマンドの細部は `dg <コマンド> --help`、エージェントの手順は `dg guide <topic>`、約束は [requirements.md](requirements.md) が正本で、ここには写さない。

## Skill 一覧

Skill は Claude Code 向けです。普通の言葉で頼むか、コマンドを打ちます。コマンドの列は例で、引数は Skill の `argument-hint` と `dg guide <topic>` にあります。Skill を入れていないエージェントには、Ask Agent の文章の形を使います。

| Skill       | 何をするか                                                           | 頼み方の例                        | コマンド           |
| ----------- | -------------------------------------------------------------------- | --------------------------------- | ------------------ |
| `dgimport`  | 会話・計画・設計書を、承認を得てチケットにする                       | 「この検討をチケットにして」      | `/dgimport`        |
| `dgassign`  | チケットを Iteration か Epic に入れる（承認を得てから）              | 「これをスプリントに入れて」      | `/dgassign s3`     |
| `dgcheck`   | チケット・Epic・Iteration・Plan の食い違いを見つけ、直す             | 「s3 のチケットを点検して」       | `/dgcheck s3`      |
| `dgplan`    | チケットの進める順を決め、承認待ちの Plan に記録する                 | 「s3 を計画して」                 | `/dgplan s3`       |
| `dgwork`    | 承認した Plan を ready・承認後のマージ・片付けまで進める             | 「p3 を進めて」                   | `/dgwork p3`       |
| `dgall`     | Iteration かチケットを、割り当てからリリースまで一つの流れで進める   | 「s3 を自動でリリースまで進めて」 | `/dgall s3 --auto` |
| `dgaudit`   | リリースの前に、リポジトリ全体を観点ごとに見直し、指摘を起票する     | 「リリースの前に見直して」        | `/dgaudit s3`      |
| `dgrelease` | Iteration の完了を確かめ、承認を得てリリースする                     | 「s3 をリリースして」             | `/dgrelease s3`    |
| `dgdone`    | マージ済みのチケットが完了かを確かめ、残った枝と worktree を片付ける | 「t12 はマージした。片付けて」    | `/dgdone t12`      |
| `dgretro`   | 閉じた Iteration を、チームの観点で振り返る                          | 「s3 を振り返って」               | `/dgretro s3`      |
| `dgchange`  | 人が頼んだ変更を一つ行う（直す・閉じる・再開・やめる・取り消す）     | 「s3 を閉じて」                   | `/dgchange s3`     |
| `dgdiscuss` | チケット・Epic・Iteration の論点を、人と相談して決める               | 「t12 を検討して」                | `/dgdiscuss t12`   |
| `dgstatus`  | 進行中のチケットの作業がどこまで進み、止まっていれば理由を教える     | 「t12 はどこまで進んだ？」        | `/dgstatus t12`    |

## 最後まで任せる

Claude Code で `/dgall s3 --auto` のように Iteration かチケットを渡すと、エージェントが割り当て・計画・実装・見直し・リリースを続けて進める。作りたいものの起票はしないので、先に `/dgimport` でチケットにする。

- `--auto` を付けると、config の `auto.decisions` に入っている判断は提案の選択肢で進む。リリース、チケットをやめる・削除する、Epic・Iteration を閉じるなど、人が決めることでは止まって聞く（一覧は `dg guide all`）
- 品質ゲートを通った PR は、エージェントがマージしてよいかを聞き、承認したときだけマージする（承認は PR に残る）。聞かずにマージするのは、`--auto` で config の `auto.merge` が true のときだけ。品質ゲートを満たさない PR は、満たさない条件を示してそれでもマージするかを聞く。承認で越えられるのは config の `merge.approval_overrides` にある条件だけで、PR が開いていて下書きでないこと、base と衝突しないこと、判定したコミットをマージすることは越えられない
- 進み具合はカンバンで見られ、計画の帯を押すと依存のグラフが出る
- Claude Code 以外のエージェントには「`dg guide all` を読んで、`--auto` で最後まで進めて」と頼む

## 品質ゲートの段

PR を ready にする・マージするときに判定する条件は、チケットの段（`gate`）で変わる。

| 段             | 判定する条件                        |
| -------------- | ----------------------------------- |
| `high`（既定） | 検査と独立した見直しを含むすべて    |
| `low`          | 見直しを除く（検査はする）          |
| `free`         | PR が開いていて、衝突しないことだけ |

段はチケット詳細か `dg ticket update <id> --gate <段>` で付ける。`/dgall`・`/dgwork` に `--gate-high`・`--gate-low`・`--gate-free` を付けると、対象のチケットの段をまとめて決める（付けなければ各チケットの段のまま）。段を下げるのは人の指示があるときだけにする。条件の細部は `dg gate --help`。

## 同期の競合を解く

同じチケットの同じ項目を二人が違う値に変えると、同期は push の前で止まり、通知に競合した項目の remote と local の値が並ぶ。

- 通知の「remote を採る」か「local を採る」を押すと、競合した項目だけがその側の値になる（ほかの変更は残る）。ターミナルでは `dg sync --resolve remote` か `dg sync --resolve local`
- 解くまで、push と、起票・claim のようにすぐ push する書き込みは待つ
- `config.yaml` やワークフローの競合にはボタンが出ない。`dg sync` の警告にある手順で、人が手で解く

エージェント向けの手順は `dg guide overview` の「When sync stops」、細部は `dg sync --help`。

## 承認待ちの通知

承認待ちの Plan と review のチケットがあると、サイドバーのタイトルに件数が出て（「DEGUBOARD: 承認待ち 3」）、増えたときは通知が出る。通知の「開く」で詳細が開く。Activity Bar のアイコンの数字は別で、未 push のコミットと未取り込みのリモートの更新の合計を示す。

通知は設定画面（歯車）の「通知」で切れる（件数の表示は残る）。チームの設定のまま自分だけ切るときは、設定画面の「自分」のタブか `--local` を使う。

```sh
dg config set notify.approvals false --local
```

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

## 他のエージェントで使う

dg のフックは、エージェントの協力なしに Run を記録し、データとマージを守る。フックが届くのは今は Claude Code だけなので、ほかのエージェントでは次の違いがある。届くかは、リポジトリで `dg hooks check` を実行して確かめる（届いていないフックを警告する。入れ直したあとにも回せる）。

フックが届かないエージェントでは、次のとおりになる。

- Run は、エージェント自身の `dg run` の呼び出しでしか残らない。サブエージェントの Run は自動で開いて閉じられないので、親のエージェントが実装と手直しを自分で行い、`dg run` で Run を開いて閉じる（guide の手順がそう案内する）
- 直接の書き換えと、dg を経由しない PR の ready・マージを止めるガードが効かない。`.git/deguboard/` の直接の書き換えや、`dg pr merge` を経由しない `gh pr merge` を止めるものがなく、応答の終わりに dg の外の変更を知らせない
- トークン数は、会話記録を読めるエージェント（今は Claude Code・Codex・Copilot CLI）だけで集計される。数えるには `metrics.read_transcripts` を有効にする（README を見る）
- 見直し役を起動できないエージェントは、PR の見直しを人に頼み、PR の本文に見直していないと書く

## Claude Desktop から使う

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
