# deguboard

Agentic-Agile を実践するための、Git リポジトリの中で動くカンバン。CLI は `dg`。概要は [README.md](README.md)。このファイルには毎回守る規約だけを書く。

## ドキュメント（入口と正本）

- Claude は毎回このファイルを読む。[development.md](docs/development.md)・requirements.md は見出しから要る節だけ、ADR は一覧から番号で引く。作業中の手順は `dg guide <topic>` が出す
- 仕様の正本は [docs/requirements.md](docs/requirements.md)。約束（振る舞いとデータの形）だけを書き、細部の正本はヘルプ・コード・テスト。要件の 1 項は約束の 1〜2 文と正本への案内にし、ADR の決定を写さない（字数の上限は ADR-001）。理由が要るときだけ ADR を引く。読み手ごとの入口と書く範囲は [ADR-001](docs/adr/ADR-001-doc-strategy.md)
- 設計判断は [docs/adr/](docs/adr/README.md)。**ADR を書くのは、戻すのに移行が要る・利用者に見える約束とデータの形・構成と技術の選択・また提案されそうな案を退ける、のどれかに当たる判断だけ。端のケース・バグ修正・版の扱い・1 PR で戻せる規則は、テストとコードのコメントの「なぜ」に置く。ADR は今の判断と理由だけを書き、判断を変える PR で同じ ADR の本文を直接書き換える（番号は変えない）。覆した判断のうち提案されそうなものは「採らなかった案」に 1 行で残す**（書き方は ADR-001）
- ADR の細部は、判断を変えずに正本へ移していつでも消してよい。要らなくなった ADR は削除し、番号は使い回さない。ADR は冒頭に決定の要約を置き、長くなったら分割・整理する
- 文書の重複と参照の切れ、要件の 1 項の上限、コードとテストが指す ADR が今の判断でなくなっていないかは `mise run check:docs` が検査する。文書全体の大きさの予算は持たない。細部は正本へ移す
- PR で変えた約束・手順・規約の文書を同じ PR で直さないのは規約の違反。前からある文書のずれは PR の見直しで重い指摘にせず、Iteration ごとの文書の見直し（`dg guide audit`）でまとめて直す
- 文書を重複させない。規約はこのファイルにだけ書き、README と development.md に写さない
- 記述を足すだけにしない。文書・README・このファイル・コードのコメントの古い記述は、見つけた変更で消す（ADR を除く。ADR の判断を変えるときは、同じ PR でその ADR の本文を書き換える）

## 開発環境とコマンド

ツールとコマンドは mise に統一する（[mise.toml](mise.toml)、[ADR-008](docs/adr/ADR-008-tech-stack.md)）。始め方は [development.md の「開発の始め方」](docs/development.md#開発の始め方)。

- コードや文書を変更したら、コミットの前に `mise run format` で整え、`mise run check` が通ることを確かめる。`main` との差分のファイルがすべて config の `actions.light_paths`（`dg config show` で見る）に入るときは、`mise run check` の代わりに軽い検査 `mise run check:light` でよい（書式・文書の検査と文書を読むテストを回す。品質ゲートの検査と同じ扱い）。段（`gate`）が free のチケットは、品質ゲートが検査を判定しないので `mise run check` は要らない（`mise run format` はする）
- 作業の途中は `mise run test:related` で変えたファイルに関わるテストだけを回す。全体は、コミットの前の `mise run check` でだけ回す
- 新しいタスクは mise.toml に足し、pnpm scripts を呼ぶだけにする。`pnpm run`・`npx` を直接案内しない

## コードの規約

- `packages/core` は VS Code API・HTTP・React に依存させない。`server`・`vscode` は `core` だけに依存し、`cli` は `dg serve` と `dg mcp` のために `server` にも依存する（[ADR-033](docs/adr/ADR-033-architecture.md)）
- すべての操作は `packages/core/src/commands/` のコマンド定義に置き、CLI・HTTP・Webview は写すだけにする。入口にロジックを書かない
- git・gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- Git 操作のテストは、一時ディレクトリの bare リモート付きリポジトリで行う
- コメント・ドキュメント・テスト名は日本語で書く。README.md と packages/cli/README.md は GitHub・Marketplace・npm の入口なので英語で書く（日本語版の README.ja.md も同じ PR で同じ節の構成に合わせる）。guide・Skill の雛形・dg の出力（ヘルプ・エラー・警告などエージェントと利用者が読む文字列）も英語で書く（[ADR-001](docs/adr/ADR-001-doc-strategy.md)）

## チケット

- このリポジトリのチケットは deguboard 自身で管理する。`mise run dg -- <引数>` で読み書きし、`.git/deguboard/` のファイルを直接編集しない。Issue は使わない。手順は [development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)
- Skill（`dg*`）の手順の中の `dg` も、PATH に `dg` があっても `mise run dg --` で呼ぶ
- 作業はチケットに紐づける。`claim` してから着手し、PR の本文に ID（`t12`）を書く。PR の要らない作業（チケットのデータの整備・確認）は `claim --without-branch` で着手し、受け入れ条件をすべて確かめたら agent が done にする。確かめられない項目は review に置いて人に報告する
- Claude は `DEGUBOARD_ACTOR=agent` を付けて `dg` を呼ぶ。人の指示や承認で起票するときは `--created-by human` を付ける（起票者はユーザ本人）。拒否された操作（`TRANSITION_REJECTED`）は人に頼む。abandoned・done の取り消し・段（`gate`）を下げる・Epic や Iteration を閉じる・再開するのは、人の指示があるときだけ行う
- 利用者への約束を変える変更は、同じ PR で requirements.md の項を直す（細部は書き足さない）。判断を変える変更は、同じ PR でその ADR の本文を直接書き換える（番号は変えない。判断が ADR を書く場面に当たらなくなったら削除する。書き方は ADR-001）。新しく ADR を書くのは、ADR を書く場面に当たる判断だけ。当たらない変更は ADR を書かず、テストとコメントで示す

## ブランチ・PR・マージ

手順は [development.md の「チケットと作業の流れ」](docs/development.md#チケットと作業の流れ)。

- 変更は `main` から切った作業ブランチを git worktree に checkout して行う。`main` に直接コミットせず、`main` の worktree で作業しない
- コミットメッセージと PR のタイトルは日本語で、要約を 1 行目に書く
- 画面の見た目を変える PR は、変えた画面のスクリーンショットを本文に載せる。画像は orphan ブランチ `pr-screenshots` に置き、作業ブランチに入れない
- PR は `main` に向ける。ローカルの `mise run check`（軽い検査で済む変更は `mise run check:light`）の通過と承認をマージの条件にする（段（`gate`）が free のチケットは、この条件を外す）。CI は使わない（[ADR-008](docs/adr/ADR-008-tech-stack.md)）
- マージは squash で行い、リモートとローカルのブランチと worktree を消す
- PR の見直しで疑いを確かめるために動かすのは 1 回までにし、引数や回数を変えて回し直さない
- 競合のように確率でしか起きない不具合は、再現を試さずにコードの根拠（どの順序で何が起きるか）で重い指摘にし、再現するテストは手直しに任せる
- 決まった検査（`mise run check`・`mise run check:light`）は、上の 1 回の上限に含めない
