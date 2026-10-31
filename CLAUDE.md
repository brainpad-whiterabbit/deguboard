# deguboard

Git-native な AI ワークフロー・チケット管理ツール。CLI は `dg`。概要は [README.md](README.md)。

このファイルには、このリポジトリで毎回守る規約だけを書く。特定の作業のときだけ要る手順は [docs/development.md](docs/development.md) に書き、ここから参照する。

## ドキュメント（入口と正本）

| 読み手                 | 入口                 | そこから引くもの                                               |
| ---------------------- | -------------------- | -------------------------------------------------------------- |
| Claude（毎回）         | このファイル         | 作業に応じて development.md・requirements.md・ADR 一覧の要る節 |
| 利用者                 | README.md            | requirements.md                                                |
| 開発者（人）           | docs/development.md  | 規約はこのファイル                                             |
| 仕様                   | docs/requirements.md | 理由が要るときだけ ADR                                         |
| エージェント（作業中） | `dg guide <topic>`   | 手順は CLI が出す。docs は読まない                             |

- 仕様の正本は [docs/requirements.md](docs/requirements.md)。約束（振る舞いとデータの形）だけを書き、細部の正本はヘルプ・コード・テスト。書く範囲は [ADR-001](docs/adr/ADR-001-doc-strategy.md)
- 設計判断は [docs/adr/](docs/adr/README.md)。**テーマごとに 1 本で、小さな変更は該当 ADR を直接書き換える**（更新日を変え、一覧も直す）。新しい ADR を書くのは方針を反転する大きな変更だけ。迷ったら書き換える
- requirements.md と development.md は見出しを探して要る節だけを読む。ADR は一覧から番号で引き、全件読まない
- 文書の大きさの予算は `mise run check:docs` が検査する。超えたら細部を正本へ移す
- 文書を重複させない。規約はこのファイルにだけ書き、README と development.md には書き写さない
- 記述を足すだけにしない。文書・README・このファイル・コードのコメントで古くなった記述は、見つけた変更で消す

## 開発環境とコマンド

ツールと作業コマンドは mise に統一する（[mise.toml](mise.toml)、[ADR-008](docs/adr/ADR-008-tech-stack.md)）。始め方は [docs/development.md の「開発の始め方」](docs/development.md#開発の始め方)。

- コードや文書を変更したら、コミットの前に `mise run format` で整え、`mise run check` が通ることを確かめる
- 新しいタスクは mise.toml に足し、pnpm scripts を呼ぶだけにする。`pnpm run` や `npx` を直接案内しない

## コードの規約

- `packages/core` は VS Code API・HTTP・React に依存させない。`server`・`vscode` は `core` だけに依存し、`cli` は `dg serve` のために `server` にも依存する（[ADR-007](docs/adr/ADR-007-architecture.md)）
- すべての操作は `packages/core/src/commands/` のコマンド定義に置き、CLI・HTTP・Webview はそれを写す。入口にロジックを書かない
- git・gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- Git 操作のテストは、一時ディレクトリに作った bare リモート付きのリポジトリで行う
- コメント・ドキュメント・テスト名は日本語で書く

## チケット

- このリポジトリのチケットは deguboard 自身で管理する（ドッグフーディング）。`mise run dg -- <引数>` で読み書きし、`.git/deguboard/` のファイルを直接編集しない。Issue は使わない。手順は [docs/development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)
- 作業はチケットに紐づける。`claim` してから着手し、PR の本文に ID（`t12`）を書く
- Claude は `DEGUBOARD_ACTOR=agent` を付けて `dg` を呼ぶ。人の指示や承認で起票するときは `--created-by human` を付ける（起票者はユーザ本人）。拒否された操作（`TRANSITION_REJECTED`）は人に頼む。abandoned・done の取り消し・Epic や Iteration を閉じる・再開するのは、人の指示があるときだけ行う
- 要件を変える変更は、同じ PR で requirements.md を直す。判断を変える変更は該当 ADR を書き換える

## ブランチ・PR・マージ

- 変更は `main` から切った作業ブランチを git worktree に checkout して行う。`main` に直接コミットせず、`main` の worktree では作業しない。手順は [docs/development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)
- コミットメッセージと PR のタイトルは日本語で、要約を 1 行目に書く
- PR は `main` に向ける。ローカルで `mise run check` が通り、承認されたことをマージの条件にする。CI は使わない（[ADR-008](docs/adr/ADR-008-tech-stack.md)）
- マージは squash で行い、リモートとローカルのブランチと worktree を消す
