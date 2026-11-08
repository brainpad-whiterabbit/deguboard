# deguboard

Git-native な AI ワークフロー・チケット管理ツール。CLI は `dg`。概要は [README.md](README.md)。このファイルには毎回守る規約だけを書く。

## ドキュメント（入口と正本）

- Claude は毎回このファイルを読む。[development.md](docs/development.md)・requirements.md は見出しから要る節だけ、ADR は一覧から番号で引く。作業中の手順は `dg guide <topic>` が出す
- 仕様の正本は [docs/requirements.md](docs/requirements.md)。約束（振る舞いとデータの形）だけを書き、細部の正本はヘルプ・コード・テスト。理由が要るときだけ ADR を引く。読み手ごとの入口と書く範囲は [ADR-001](docs/adr/ADR-001-doc-strategy.md)
- 設計判断は [docs/adr/](docs/adr/README.md)。**ADR は判断ごとに 1 本で、決めたら書き換えない。判断を変えるときは新しい ADR を書き、古い ADR を「置き換え」にして一覧を直す**（書き方は ADR-001）
- 文書の重複と参照の切れは `mise run check:docs` が検査する。大きさの予算は持たない。細部は正本へ移す
- PR で変えた約束・手順・規約の文書を同じ PR で直さないのは規約の違反。前からある文書のずれは PR の見直しで重い指摘にせず、Iteration ごとの文書の見直し（`dg guide audit`）でまとめて直す
- 文書を重複させない。規約はこのファイルにだけ書き、README と development.md に写さない
- 記述を足すだけにしない。文書・README・このファイル・コードのコメントの古い記述は、見つけた変更で消す（ADR を除く。ADR の判断を変えるには置き換えの ADR を書き、書き換えてよいのは ADR-001 の例外だけ）

## 開発環境とコマンド

ツールとコマンドは mise に統一する（[mise.toml](mise.toml)、[ADR-008](docs/adr/ADR-008-tech-stack.md)）。始め方は [development.md の「開発の始め方」](docs/development.md#開発の始め方)。

- コードや文書を変更したら、コミットの前に `mise run format` で整え、`mise run check` が通ることを確かめる
- 新しいタスクは mise.toml に足し、pnpm scripts を呼ぶだけにする。`pnpm run`・`npx` を直接案内しない

## コードの規約

- `packages/core` は VS Code API・HTTP・React に依存させない。`server`・`vscode` は `core` だけに依存し、`cli` は `dg serve` と `dg mcp` のために `server` にも依存する（[ADR-007](docs/adr/ADR-007-architecture.md)）
- すべての操作は `packages/core/src/commands/` のコマンド定義に置き、CLI・HTTP・Webview は写すだけにする。入口にロジックを書かない
- git・gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- Git 操作のテストは、一時ディレクトリの bare リモート付きリポジトリで行う
- コメント・ドキュメント・テスト名は日本語で書く。README.md と packages/cli/README.md は GitHub・Marketplace・npm の入口なので英語で書く（日本語版の README.ja.md も同じ PR で同じ節の構成に合わせる）

## チケット

- このリポジトリのチケットは deguboard 自身で管理する。`mise run dg -- <引数>` で読み書きし、`.git/deguboard/` のファイルを直接編集しない。Issue は使わない。手順は [development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)
- Skill（`dg*`）の手順の中の `dg` も、PATH に `dg` があっても `mise run dg --` で呼ぶ
- 作業はチケットに紐づける。`claim` してから着手し、PR の本文に ID（`t12`）を書く。PR の要らない作業（チケットのデータの整備・確認）は `claim --without-branch` で着手し、受け入れ条件をすべて確かめたら agent が done にする。確かめられない項目は review に置いて人に報告する
- Claude は `DEGUBOARD_ACTOR=agent` を付けて `dg` を呼ぶ。人の指示や承認で起票するときは `--created-by human` を付ける（起票者はユーザ本人）。拒否された操作（`TRANSITION_REJECTED`）は人に頼む。abandoned・done の取り消し・Epic や Iteration を閉じる・再開するのは、人の指示があるときだけ行う
- 要件を変える変更は、同じ PR で requirements.md を直す。判断を変える変更は新しい ADR を書き、古い ADR を置き換えにする（一節か一項だけなら失効の印。書き方は ADR-001）

## ブランチ・PR・マージ

手順は [development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)。

- 変更は `main` から切った作業ブランチを git worktree に checkout して行う。`main` に直接コミットせず、`main` の worktree で作業しない
- コミットメッセージと PR のタイトルは日本語で、要約を 1 行目に書く
- 画面の見た目を変える PR は、変えた画面のスクリーンショットを本文に載せる。画像は orphan ブランチ `pr-screenshots` に置き、作業ブランチに入れない
- PR は `main` に向ける。ローカルの `mise run check` の通過と承認をマージの条件にする。CI は使わない（[ADR-008](docs/adr/ADR-008-tech-stack.md)）
- マージは squash で行い、リモートとローカルのブランチと worktree を消す
