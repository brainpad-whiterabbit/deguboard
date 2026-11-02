# deguboard

Git-native な AI ワークフロー・チケット管理ツール。CLI は `dg`。概要は [README.md](README.md)。

このファイルには、このリポジトリで毎回守る規約だけを書く。特定の作業のときだけ要る手順は [docs/development.md](docs/development.md) に書き、ここから参照する。

## ドキュメント（入口と正本）

- Claude（毎回）：このファイル。作業に応じて development.md・requirements.md は見出しから要る節だけを、ADR は一覧から番号で引く（全件読まない）
- 利用者：README.md から requirements.md
- 開発者（人）：docs/development.md。規約はこのファイル
- エージェント（作業中）：`dg guide <topic>`。手順は CLI が出し、docs は読まない
- 仕様の正本は [docs/requirements.md](docs/requirements.md)。約束（振る舞いとデータの形）だけを書き、細部の正本はヘルプ・コード・テスト。理由が要るときだけ ADR を引く。書く範囲は [ADR-001](docs/adr/ADR-001-doc-strategy.md)
- 設計判断は [docs/adr/](docs/adr/README.md)。**テーマごとに 1 本で、小さな変更は該当 ADR を直接書き換える**（更新日を変え、一覧も直す）。新しい ADR を書くのは方針を反転する大きな変更だけ。迷ったら書き換える
- 文書の大きさの予算は `mise run check:docs` が検査する。超えたら細部を正本へ移す
- 文書を重複させない。規約はこのファイルにだけ書き、README と development.md には書き写さない
- 記述を足すだけにしない。文書・README・このファイル・コードのコメントで古くなった記述は、見つけた変更で消す

## 開発環境とコマンド

ツールと作業コマンドは mise に統一する（[mise.toml](mise.toml)、[ADR-008](docs/adr/ADR-008-tech-stack.md)）。始め方は [development.md の「開発の始め方」](docs/development.md#開発の始め方)。

- コードや文書を変更したら、コミットの前に `mise run format` で整え、`mise run check` が通ることを確かめる
- 新しいタスクは mise.toml に足し、pnpm scripts を呼ぶだけにする。`pnpm run` や `npx` を直接案内しない

## コードの規約

- `packages/core` は VS Code API・HTTP・React に依存させない。`server`・`vscode` は `core` だけに依存し、`cli` は `dg serve` と `dg mcp` のために `server` にも依存する（[ADR-007](docs/adr/ADR-007-architecture.md)）
- すべての操作は `packages/core/src/commands/` のコマンド定義に置き、CLI・HTTP・Webview はそれを写す。入口にロジックを書かない
- git・gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- Git 操作のテストは、一時ディレクトリに作った bare リモート付きのリポジトリで行う
- コメント・ドキュメント・テスト名は日本語で書く

## チケット

- このリポジトリのチケットは deguboard 自身で管理する。`mise run dg -- <引数>` で読み書きし、`.git/deguboard/` のファイルを直接編集しない。Issue は使わない。手順は [development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)
- Skill（`dg*`）の手順の中の `dg` も、PATH に `dg` があっても `mise run dg --` で呼ぶ（PATH の `dg` はこのリポジトリのビルドと食い違いうる）
- 作業はチケットに紐づける。`claim` してから着手し、PR の本文に ID（`t12`）を書く。PR の要らない作業（チケットのデータの整備・確認）は `claim --without-branch` で着手し、受け入れ条件をすべて確かめたら agent が done にする。確かめられない項目が残れば review に置いて人に報告する
- todo・abandoned 以外に進めるチケットは Iteration に入れる。`claim` の前に `ticket show` の `iteration` で確かめ、入っていなければ active の Iteration（なければ次の planned）に `iteration add` で入れる。Iteration に入れずに終えると、カンバンの「Iteration なし」の done に残り続ける
- Claude は `DEGUBOARD_ACTOR=agent` を付けて `dg` を呼ぶ。人の指示や承認で起票するときは `--created-by human` を付ける（起票者はユーザ本人）。拒否された操作（`TRANSITION_REJECTED`）は人に頼む。abandoned・done の取り消し・Epic や Iteration を閉じる・再開するのは、人の指示があるときだけ行う
- 要件を変える変更は、同じ PR で requirements.md を直す。判断を変える変更は該当 ADR を書き換える

## ブランチ・PR・マージ

手順は [development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)。

- 変更は `main` から切った作業ブランチを git worktree に checkout して行う。`main` に直接コミットせず、`main` の worktree では作業しない
- コミットメッセージと PR のタイトルは日本語で、要約を 1 行目に書く
- 画面の見た目を変える PR は、変えた画面のスクリーンショットを本文に載せる。画像は orphan ブランチ `pr-screenshots` に置き、作業ブランチに入れない
- PR は `main` に向ける。ローカルで `mise run check` が通り、承認されたことをマージの条件にする。CI は使わない（[ADR-008](docs/adr/ADR-008-tech-stack.md)）
- マージは squash で行い、リモートとローカルのブランチと worktree を消す
