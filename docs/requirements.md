# deguboard 要件定義書

今の仕様の正本。利用者（人・エージェント）に約束する振る舞いとデータの形だけを書く。細部（CLI オプション、集計の規則、画面の並びや文言）はヘルプ・コード・テストが正本で、各節から案内する。判断の理由は [ADR 一覧](adr/README.md)から引く。書く範囲は [ADR-001](adr/ADR-001-doc-strategy.md)。

要件の ID（`TK-1` など）はコードとテストから参照する。文を縮めても ID と見出しのアンカーは変えず、消した ID は再利用しない。「Phase」の列は実装の予定で、約束の有無ではない。

## 1. 目的

deguboard は、Git で管理するチケットとユーザー定義のワークフローを組み合わせた、Local-first で AI エージェント対応のタスク管理ツールである。

- 人は「何を作るか」「どの順で進めるか」「成果物を承認するか」を決める
- AI エージェント（Claude Code・Codex など）は、普段どおりの対話の中でチケットの起票・計画・実行・レビュー・完了を進める。エージェントは人が動かし、deguboard は起動も監視もしない（[ADR-004](adr/ADR-004-agents-and-state.md)）
- データは Git リポジトリ内のテキストファイルで管理し、外部 SaaS・DB・常駐サーバーを必須としない
- ソフトウェア開発・コンサルティング・調査・資料作成など、業務の違いはワークフロー定義で表し、Core に組み込まない

## 2. 想定利用者と前提

| 項目         | 内容                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 利用者       | 個人、および同じ Git リポジトリを共有する小規模チーム                                                                      |
| 実行環境     | Linux / macOS。Node.js 24 以上。ブラウザ、または VS Code（デスクトップ）                                                   |
| 必須ツール   | git 2.30 以上。GitHub CLI（`gh`）は PR の事実を照合に使うときだけ                                                          |
| リポジトリ   | Git リポジトリ。リモートは任意（なければ同期なしで動く）。`git.base_branch` を作業ブランチの元と「マージ済み」の判定に使う |
| エージェント | `dg` を Bash から呼べるものなら何でも。Skill は Claude Code 向けに配る                                                     |

## 3. 用語

| 用語               | 意味                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Project            | チケットを束ねる単位。1 リポジトリに複数置ける                                                           |
| Ticket             | 最小の作業単位。`t12`                                                                                    |
| Iteration          | 期間の計画（スプリント）。`s3`。`sprint` はエイリアス                                                    |
| Plan               | チケットをどの順で進めるかと承認の記録。`p7`                                                             |
| Workflow           | ステータス・遷移・照合規則・追加フィールドの定義                                                         |
| Status / category  | チケットの進捗。Status はワークフローごと、category は `todo` / `active` / `review` / `done` の固定 4 種 |
| Run                | 1 回の AI 実行の記録。`step`（工程）を持つ                                                               |
| claim              | チケットに着手する操作。push の成功で排他を得る                                                          |
| 照合（reconcile）  | 作業ブランチの事実からチケットの状態を前進させること                                                     |
| deguboard worktree | orphan ブランチ `deguboard` を checkout した `<git-common-dir>/deguboard/`                               |

## 4. ユースケース

- **ソフトウェア開発**：エージェントが要件を整理してチケットに分解し、依存を付けて Iteration に入れる。チケットごとに作業ブランチと worktree を作って claim し、実装・テスト・PR を作る。別のエージェントか人がレビューし、マージされると照合で done になる。Run に使用量が残る
- **コンサルティング**：調査・分析・資料作成・レビューの工程を Workflow の step として定義し、同じ仕組みでチケットを進める。PR はなく、成果物のブランチがマージされると done になる

## 5. データ要件

### 5.1 配置

- データは orphan ブランチ `deguboard` に置き、`<git-common-dir>/deguboard/` に専用 worktree として checkout する。読み書きはすべてここで行い、作業ブランチにはデータを置かない（[ADR-002](adr/ADR-002-storage-and-id.md)）
- Git 管理外のもの（ローカルロック、実行中の詳細ログ、索引）は `<git-common-dir>/deguboard-local/` に置く

```
config.yaml
projects/<slug>.yaml
tickets/t0012.md            # 1 チケット 1 ファイル
tickets/deleted/t0009.md    # 墓標。番号を再利用しない
iterations/s03.yaml
plans/p07.yaml
workflows/<id>.yaml
runs/                       # Phase 3。完了時の集計だけ
```

- DT-1 書き込みは一時ファイルへ書いてから rename する。読み込みは Zod のスキーマで検証し、読めないファイルは止めずに `dg validate` と画面で報告する
- DT-2 スキーマにない項目は読み書きで残す（版の違う `dg` が消さない）

### 5.2 ID と番号

- DT-3 ID は接頭辞＋連番（`t12`・`s3`・`p7`）。ファイル名は 4 桁ゼロ埋め（`t0012.md`）。番号はリポジトリ全体で一意
- DT-4 採番は「既存と墓標の最大 + 1」。作成は fetch → 採番 → commit → push を 1 単位とし、push が拒否されたら採番し直す
- DT-5 push できないときは `provisional: true` を付けてローカルに commit し、次の `dg sync` で衝突があれば番号・ファイル名・未 push のコミット内の参照を振り直す。`dg ticket list` は仮番号に印を出す
- DT-6 CLI と UI は `t12` でも `12` でも受け付ける

### 5.3 Project（`projects/<slug>.yaml`）

`id`（slug）、`name`、`description`、`workflow`（既定のワークフロー）、`status`（`active` / `archived`）。`dg init` は `default` を作る。

### 5.4 Ticket（`tickets/t0012.md`）

```markdown
---
id: t12
project: webapp
title: ログイン画面のバリデーション
status: in_progress
priority: medium # low | medium | high
labels: [frontend]
iteration: s3
depends_on: [t9]
workflow: software-development
claimed_by: eiki@laptop
branch: feature/t12-login-validation
pr: 42 # 任意
runs: [r1]
created_at: 2026-10-31T04:00:00Z
updated_at: 2026-10-31T05:10:00Z
---

## 概要

…

## 受け入れ条件

- [ ] …
```

- TK-1 必須は `id`・`project`・`title`・`status`・`created_at`・`updated_at`。`workflow` を省くと Project の既定を使う
- TK-2 `depends_on` は同じリポジトリのチケットの ID。循環は作成・更新時に拒否する
- TK-3 本文は Markdown。`## 概要` と `## 受け入れ条件`（`- [ ]` のチェックリスト）を推奨し、`dg lint` が欠けを指摘する
- TK-4 Workflow の `fields` で定義した任意フィールドを frontmatter に持てる
- TK-5 受け入れ条件のチェックは、作業した人かエージェントが PR や成果物で確認できたときに付ける。deguboard が自動で付けることはない

### 5.5 Iteration（`iterations/s03.yaml`）

`id`、`project`、`name`、`goal`、`start`、`end`、`status`（`planned` / `active` / `closed`）、`tickets`（並び順）。閉じたときに `closed_at` と完了・持ち越しの件数を書く。

### 5.6 Plan（`plans/p07.yaml`）

- PL-1 `id`、`project`、`tickets`、`after`（計画内だけの待ち。チケットの依存とは別）、`pending_approval`、`approved_by`、`approved_at`、`details.<ticket>.{scope, approach}` を持つ
- PL-2 進捗は Plan に書かない。チケットの状態から都度求める。Plan を書くのは作成・承認・終了のときだけ
- PL-3 1 つのチケットは同時に 1 つの Plan にしか入らない。done のチケットは入れられない

### 5.7 Workflow（`workflows/<id>.yaml`）

```yaml
id: software-development
name: Software Development
statuses: # 並びがカンバンの列と「前進」の基準
  - { id: todo, label: TODO, category: todo }
  - { id: in_progress, label: In Progress, category: active }
  - { id: review, label: Review, category: review }
  - { id: done, label: Done, category: done }
transitions: # 表にない遷移は拒否する
  - { from: todo, to: in_progress, by: [human, agent], requires: [deps_done] }
  - { from: in_progress, to: review, by: [human, agent, reconcile] }
  - { from: review, to: in_progress, by: [human] }
  - { from: review, to: done, by: [human, reconcile], requires: [branch_merged] }
reconcile: # 上から評価し、前進するときだけ書き換える
  - { when: [branch_merged], status: done }
  - { when: [pr_open, "!pr_draft"], status: review }
  - { when: [branch_exists], status: in_progress }
fields:
  - { id: estimate, type: number, label: 見積 }
```

- WF-1 `statuses` の各要素は `id`・`label`・`category` を持ち、4 つの category をすべて含む
- WF-2 `requires` と `reconcile.when` に書けるのは組み込みの事実（`deps_done`、`branch_exists`、`branch_pushed`、`branch_merged`、`pr_open`、`pr_draft`、`pr_merged`）とその否定（`!pr_draft`）だけ。利用者のスクリプトは実行しない（[ADR-003](adr/ADR-003-status-and-workflow.md)）
- WF-3 存在しない Status を指す遷移、category の欠け、未知の条件は読み込み時と `dg workflow validate` で指摘する
- WF-4 `software-development`・`consulting`・`general` のテンプレートを同梱し、`dg init --template` でコピーする
- WF-5 Phase 3 で `steps`（Run の step の語彙）と、step ごとの Action・承認の要否を足す。手続きは YAML に書かず `dg guide` が持つ

### 5.8 Run（`runs/`、Phase 3）

- RN-1 1 Run 1 ファイル。`id`、`ticket`、`step`、`agent`、`model`、`started_at`、`finished_at`、`result`（`success` / `failure` / `interrupted`）、`error`、`retries`、`usage`（input / output / cache_read / cache_write のトークン）
- RN-2 取れなかった値は `null`。推定した値は `estimated: true` を付ける。費用は持たない（[ADR-005](adr/ADR-005-work-metrics.md)）
- RN-3 Git に入れるのは完了時の集計だけ。実行中の詳細ログは `deguboard-local/runs/`

### 5.9 設定（`config.yaml`）

| 項目                             | 意味                                         | 既定                  |
| -------------------------------- | -------------------------------------------- | --------------------- |
| `default_project`                | 省略時の Project                             | `default`             |
| `git.remote` / `git.base_branch` | 同期先と、作業ブランチの元・マージ判定の基準 | `origin` / `main`     |
| `worktree.root`                  | 作業 worktree の置き場所                     | `../<repo>.worktrees` |
| `commit.mode`                    | `each` / `batch` / `manual`                  | `batch`               |
| `push.mode`                      | `auto` / `manual`                            | `auto`                |
| `metrics.read_transcripts`       | 会話記録を読むか                             | `false`               |
| `actions.shell`                  | 任意のシェルの Action を許すか（Phase 3）    | `false`               |

項目の全体は `dg config --help` とスキーマ（`packages/core/src/model/config.ts`）が正本。利用者ごとの上書きは設けない。

## 6. 機能要件

### 6.1 `dg` CLI

- CL-1 すべてのコマンドに `--json` があり、エージェントはそれを読む。終了コードは 0（成功）/ 1（失敗）/ 2（使い方の誤り）
- CL-2 コマンドの一覧とオプションは `dg --help` が正本。主な群は次のとおり

| 群        | コマンド                                                                                 | Phase |
| --------- | ---------------------------------------------------------------------------------------- | ----- |
| 用意      | `init`、`sync`、`validate`、`lint`、`config`                                             | 1     |
| Project   | `project create / list / show / archive`                                                 | 1     |
| Ticket    | `ticket create / list / show / update / move / delete / import / claim / unclaim`        | 1     |
| Iteration | `iteration create / list / show / add / remove / start / close`（`sprint` はエイリアス） | 1     |
| Workflow  | `workflow list / show / validate`                                                        | 1     |
| 画面      | `serve`、`open`                                                                          | 1     |
| 手順      | `guide <topic>`                                                                          | 1     |
| Plan      | `plan create / approve / show / close`                                                   | 2     |
| Run       | `run start / finish / list`、`metrics show`                                              | 3     |

- CL-3 書き込みを伴うコマンドは、`commit.mode` に従って deguboard ブランチにコミットする。`ticket create`・`ticket import`・`ticket claim` は mode によらず即座にコミットして push する
- CL-4 `ticket import` は YAML / JSON の下書き（配列）を 1 コミットで取り込む。下書きの中の仮キーを `depends_on` から参照できる
- CL-5 `dg guide <topic>` は、エージェント向けの手順を `config.yaml` の値を埋めて出す。手順の正本は CLI に同梱した Markdown（`packages/cli/src/guide-*.md`）
- CL-6 CLI はビジネスロジックを持たず、Core のコマンド定義（`packages/core/src/commands/`）を写す

### 6.2 状態遷移と照合

- ST-1 `status` はチケットに保存する。変えるのは `ticket move`・`claim`・`unclaim`、UI の操作、照合だけ
- ST-2 遷移は Workflow の `transitions` で検査する。表にない遷移、`requires` を満たさない遷移は拒否する
- ST-3 `claim` は todo（category）のチケットに `claimed_by`・`branch` を記録して active の Status に進める。依存が done でなければ拒否する
- ST-4 照合は `dg sync` と、サーバー・拡張の定期実行で行う。チケットの `branch` について Git から事実を集め、`reconcile` 規則を上から評価し、今より category が先のときだけ書き換える
- ST-5 後退を指す事実（消えたブランチ・閉じた PR）は書き換えず警告する。取れなかった事実は不明とし、前進の判定では偽と読む
- ST-6 PR の事実は `gh` が使えるときだけ取る。`gh` がなくても照合は Git の事実だけで成り立つ
- ST-7 `unclaim` は自分の claim か記録のない claim だけを外す。応答のない claim は `--force` で外す。生存監視はしない

### 6.3 Git 同期と排他

- SY-1 `dg init` は deguboard ブランチを作るか取り込み、専用 worktree を用意し、`default` プロジェクトとテンプレートのワークフローを置く
- SY-2 書き込みの単位は「取り込み → 変更 → 検証 → コミット →（`push.mode: auto` なら）push」。push が拒否されたら取り込み直して再送する。送れなければコミットを残し、次の同期で再送する
- SY-3 claim と作成は push の成功をもって取得とする。拒否されたらローカルのコミットを捨てて取り込み直し、判定し直す
- SY-4 同期で競合したら、rebase を中止してローカルのコミットを残し、`dg sync` が競合を報告する。frontmatter のフィールド単位のマージドライバは Phase 2
- SY-5 同一マシンでの Run の二重起動は `deguboard-local/locks/<ticket>` で防ぐ。チーム間の排他には使わない
- SY-6 リモートがなくても、同期を除くすべての操作が動く

### 6.4 画面（Web UI・VS Code 拡張）

Web UI は `dg serve` が配信し、VS Code 拡張は同じ React アプリを Webview に載せる。表示と操作は両方で同じ（[ADR-006](adr/ADR-006-ui-and-writes.md)）。

- UI-1 プロジェクトの切り替え
- UI-2 カンバン：列は Workflow の `statuses` に追従する。チケットをドラッグ＆ドロップすると `ticket move` と同じ検査を通して Status が変わり、拒否されたら理由を出して戻す
- UI-3 バックログ：done 以外のチケットを優先度と並び順で出し、番号・タイトル・ラベルで検索、Status・優先度・Iteration・ラベルで絞り込む
- UI-4 チケット詳細：本文（概要・受け入れ条件）、属性、依存先と依存元、作業ブランチ、Run の一覧（Phase 3）。属性と本文を編集できる
- UI-5 Iteration：一覧と、選んだ Iteration のチケット。チケットの追加・除外、開始・終了
- UI-6 未 push のコミットと、取り込んでいないリモートの更新があることを印で知らせる。再読み込みで `dg sync` と同じ同期を行う
- UI-7 画面からの書き込みは Core の同じコマンドを通り、`commit.mode` に従ってコミットする
- UI-8 `dg serve` は既定で `127.0.0.1` にバインドする。認証は持たない
- UI-9 Run の実行状況と実績の画面は Phase 3

画面の並び順・色・文言は Webview のコード（`packages/web/src/`）とテストが正本。

### 6.5 エージェント連携

- AG-1 エージェントは `dg … --json` を Bash から呼び、データのファイルを直接編集しない
- AG-2 Claude Code 向けに、`dg guide <topic>` を読む薄い Skill を配る（`dg skill install`、Phase 2）。起票・計画・作業・完了の各トピックを用意する
- AG-3 エージェントは要件の整理が終わったら、必要に応じてチケット化を提案し、承認を得て `ticket import` で起票する。分解・依存の整理・Iteration への割り当ても提案して承認を得る（Phase 2）
- AG-4 MCP サーバーは Core のコマンド定義から生成する薄い層として提供する（Phase 2）。CLI と同じ操作ができる
- AG-5 Agent Adapter が、エージェントの起動方法・使用量の取得・権限・作業ディレクトリの差を吸収する。Core は特定の AI 製品を知らない（Phase 2〜3）
- AG-6 ソフトウェア開発向けの Action（worktree の作成、ブランチ、テスト実行、PR 作成、マージ）は登録済みの Action として提供し、Core の汎用部分に組み込まない（Phase 3）
- AG-7 任意のシェルコマンドの Action は `actions.shell: true` のときだけ使え、実行前に確認する（Phase 3）

### 6.6 作業の実績（Phase 3）

- MT-1 `dg run start / finish` で Run を記録し、Adapter が使用量を取り込む。エージェントの自己申告の数字は書かない
- MT-2 `metrics.read_transcripts` が true のマシンでは、Claude Code の会話記録から使用量を補う。`DEGUBOARD_NO_TRANSCRIPTS=1` のマシンでは読まない
- MT-3 Run・Ticket・Iteration・Project・Agent/Model の単位で集計して出す。集計値は保存しない
- MT-4 Git に入る記録は、数とリポジトリからの相対パスだけ。会話の中身・コマンドの文字列・リポジトリの外のパスは写さない

### 6.7 ワークフロー実行（Phase 3〜4）

- EX-1 deguboard はエージェントを起動しない。チケットの処理はエージェント側の Skill が `dg` を呼んで進める
- EX-2 終了していない Run は `dg run list --open` で見え、`finish --result interrupted` で閉じる
- EX-3 依存に従う並列実行・自動レビュー・修正ループ・品質ゲート・自動マージは、Skill 側の手順として提供し、`dg ticket list --ready` と Plan の順序に従う（Phase 4）
- EX-4 人の承認が要る遷移（Workflow の `by: [human]`）は、エージェントからは行えない

## 7. 非機能要件

- NF-1 外部の専用サーバーなしで動く。リモートがなければオフラインでもタスク管理ができる
- NF-2 CLI・HTTP・VS Code 拡張は同じ Core のコマンド定義を使い、ビジネスロジックを重複実装しない
- NF-3 データ形式は人と AI の両方が読める（Markdown・YAML・JSON）
- NF-4 更新は検証と原子的な書き込みを行い、ファイルを壊さない
- NF-5 同時更新の競合を検出して報告する
- NF-6 Workflow の表にない状態遷移を作れない
- NF-7 Run の停止・失敗から、状態を壊さずに復旧できる
- NF-8 サーバーは既定で localhost にバインドする
- NF-9 Workflow に書かれた任意のコマンドを無条件に実行しない
- NF-10 Git 管理するログと実績に秘密情報を含めない
- NF-11 `core` は VS Code API・HTTP・React に依存しない。依存の向きは [ADR-007](adr/ADR-007-architecture.md)

## 8. 対象外

次のものは範囲に含めない。必要になったら ADR を書き換えてから本書に足す。

- deguboard がエージェントを起動・監視すること、ツール側のスケジューラ（[ADR-004](adr/ADR-004-agents-and-state.md)）
- Milestone（Iteration で表す。[ADR-003](adr/ADR-003-status-and-workflow.md)）
- 推定費用の記録（[ADR-005](adr/ADR-005-work-metrics.md)）
- Workflow の条件に利用者のスクリプトを使うこと
- 複数 PC 間の排他（claim の push で足りる）
- Webhook によるリアルタイム同期、外部への通知
- 権限管理などのチーム運用の機能
- Windows
