# deguboard 要件定義書

今の仕様の正本。利用者（人・エージェント）に約束する振る舞いとデータの形だけを書く。細部（CLI オプション、集計の規則、画面の並びや文言）はヘルプ・コード・テストが正本で、各節から案内する。判断の理由は [ADR 一覧](adr/README.md)から引く。書く範囲は [ADR-001](adr/ADR-001-doc-strategy.md)。

要件の ID（`TK-1` など）はコードとテストから参照する。文を縮めても ID と見出しのアンカーは変えず、消した ID は再利用しない。まだ実装していない節・項目には「予定（`<Epic の ID>`）」と実装する Epic の ID を添える（`dg epic show <ID>`）。予定は時期の約束ではない。

## 1. 目的

deguboard は、Git で管理するチケットとユーザー定義のワークフローを組み合わせた、Local-first で AI エージェント対応のタスク管理ツールである。

- 人は「何を作るか」「どの順で進めるか」「成果物を承認するか」を決める
- AI エージェント（Claude Code・Codex など）は、普段どおりの対話の中でチケットの起票・計画・実行・レビュー・完了を進める。エージェントは人が動かし、deguboard は起動も監視もしない（[ADR-004](adr/ADR-004-agents-and-state.md)）
- データは Git リポジトリ内のテキストファイルで管理し、外部 SaaS・DB・常駐サーバーを必須としない
- ソフトウェア開発・コンサルティング・調査・資料作成など、業務の違いはワークフロー定義で表し、Core に組み込まない

## 2. 想定利用者と前提

- **利用者**：個人、および同じ Git リポジトリを共有する小規模チーム
- **実行環境**：Linux / macOS。Node.js 24 以上。`dg` は npm で入れる（公開までは README の手順でビルドする）。ブラウザ、または VS Code 1.123 以上（デスクトップ）
- **必須ツール**：git 2.30 以上。GitHub CLI（`gh`）は PR の事実を照合に使うときだけ
- **リポジトリ**：Git リポジトリ。リモートは任意（なければ同期なしで動く）。`git.base_branch` を作業ブランチの元と「マージ済み」の判定に使う
- **エージェント**：`dg` を Bash から呼べるものなら何でも。Skill は Claude Code 向けに配る

## 3. 用語

- **Project**：チケットを束ねる単位。1 リポジトリに複数置ける
- **Ticket**：最小の作業単位。`t12`
- **Epic**：目的ごとにチケットを束ねる単位。Iteration をまたぐ。`e3`
- **Iteration**：期間の計画（スプリント）。`s3`。`sprint` はエイリアス
- **Plan**：チケットをどの順で進めるかと承認の記録。`p7`
- **Workflow**：遷移の条件・照合規則・追加フィールド・表示名の定義
- **Status**：チケットの進捗。全ワークフロー共通の `todo` / `in_progress` / `review` / `done` / `abandoned` の 5 つ
- **Run**：1 回の AI 実行の記録。`step`（工程）を持つ
- **claim**：チケットに着手する操作。push の成功で排他を得る
- **主体の ID**：ユーザ名＋種別の 1 文字列。`eiki`（人）か `eiki/agent`（eiki の AI）。ホスト名は含めない
- **起票者**：チケットの起票を指示・承認したユーザか、人の確認を経ずに起票した AI。`created_by`
- **担当者**：チケットを進めるユーザか AI。`assignee`。claim で付く
- **照合（reconcile）**：作業ブランチの事実からチケットの状態を前進させること
- **deguboard worktree**：orphan ブランチ `deguboard` を checkout した `<git-common-dir>/deguboard/`

## 4. ユースケース

- **ソフトウェア開発**：エージェントが要件を整理してチケットに分解し、Epic に束ね、依存を付けて Iteration に入れる。チケットごとに作業ブランチと worktree を作って claim し、実装・テスト・PR を作る。別のエージェントか人がレビューし、マージされると照合で done になる。Run に使用量が残る
- **コンサルティング**：調査・分析・資料作成・レビューの工程を Workflow の step として定義し、同じ仕組みでチケットを進める。PR はなく、成果物のブランチがマージされると done になる

## 5. データ要件

### 5.1 配置

- データは orphan ブランチ `deguboard` に置き、`<git-common-dir>/deguboard/` に専用 worktree として checkout する。読み書きはすべてここで行い、作業ブランチにはデータを置かない（[ADR-002](adr/ADR-002-storage-and-id.md)）
- Git 管理外のもの（ローカルロック、実行中の Run の記録、マージドライバの属性ファイル）は `<git-common-dir>/deguboard-local/` に置く

```
config.yaml
.gitattributes              # マージドライバを当てるパス（SY-4）
projects/<slug>.yaml
tickets/t12.md              # 1 チケット 1 ファイル。ファイル名は ID そのまま
tickets/deleted/t9.md       # 墓標。番号を再利用しない
epics/e3.md                 # 目的ごとの束ね。Iteration をまたぐ
iterations/s3.yaml
plans/p7.yaml
workflows/<id>.yaml
runs/r20261031-041500-3fa2.json  # Run の完了時の集計だけ。ID は開始日時と乱数
```

- DT-1 書き込みは一時ファイルへ書いてから rename する。読み込みは Zod のスキーマで検証し、読めないファイルは止めずに `dg validate` と画面で報告する
- DT-2 スキーマにない項目は読み書きで残す（版の違う `dg` が消さない）

### 5.2 ID と番号

- DT-3 ID は接頭辞＋連番（`t12`・`e3`・`s3`・`p7`）。ファイル名は ID そのまま（`t12.md`）で、ゼロ埋めしない。番号はリポジトリ全体で一意。ファイル名の辞書順は番号順にならないが、CLI と UI は番号で並べる
- DT-4 採番は「既存と墓標の最大 + 1」。作成は fetch → 採番 → commit → push を 1 単位とし、push が拒否されたら採番し直す
- DT-5 push できないときは `provisional: true` を付けてローカルに commit し、`dg ticket list` は仮番号に印を出す。push が済んだ `dg sync` で印を外す。仮番号がリモートの番号と衝突していたら、`dg sync` が番号・ファイル名・未 push のコミット内の参照（他チケットの `depends_on`、Plan、コミットの題）を次の空き番号に振り直してから push する。仮番号以外の競合は振り直さず報告する（SY-4）
- DT-6 CLI と UI は `t12` でも `12` でも受け付ける

### 5.3 Project（`projects/<slug>.yaml`）

`id`（slug）、`name`、`description`、`workflow`（既定のワークフロー）、`status`（`active` / `archived`）。`dg init` は `default` を作る。`archived` の Project にはチケットを作れない。

### 5.4 Ticket（`tickets/t12.md`）

```markdown
---
id: t12
project: webapp
title: ログイン画面のバリデーション
status: in_progress
priority: medium # low | medium | high
labels: [frontend]
iteration: s3
epic: e3
depends_on: [t9]
workflow: software-development
created_by: eiki # 起票者。eiki（人）か eiki/agent（eiki の AI）
assignee: eiki/agent # 担当者。claim で付く
branch: feature/t12-login-validation
branch_at: 2026-10-31T04:30:00Z # branch を記録した時刻。claim と branch の更新で付く
pr: 42 # 任意。照合がブランチ名で PR を見つけたら補う
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
- TK-3 本文は Markdown。`## 概要` と `## 受け入れ条件`（`- [ ]` のチェックリスト）を推奨し、`create` / `import` は `summary` と `acceptance` から雛形を作る。受け入れ条件の項目は `ticket show` が番号つきで出し、`ticket check` が番号で印を付け外しする。`dg lint` が節の欠けと項目のない受け入れ条件、Epic・Plan とチケットの状態の食い違いを指摘し、`lint.require_iteration`（5.10）が true なら Iteration に入らずに todo・abandoned 以外に進んだチケット（閉じた Epic の done は除く）も指摘する
- TK-4 Workflow の `fields` で定義した任意フィールドを frontmatter に持てる
- TK-5 受け入れ条件のチェックは、作業した人かエージェントが PR や成果物で確認できたときに付ける。deguboard が自動で付けることはなく、照合で done に進めたチケットに未チェックが残れば `sync` が警告する（遷移は止めない。[ADR-003](adr/ADR-003-status-and-workflow.md)）
- TK-6 `epic` は同じ Project の Epic の ID。閉じた Epic には付けられない
- TK-7 `created_by`（起票者）と `assignee`（担当者）は主体の ID（`<ユーザ>` か `<ユーザ>/agent`）。`created_by` は作成時に書き、既定は操作した主体で、エージェントが人の指示・承認で起票するときはユーザ本人を指定する。`assignee` は `claim` が claim した主体で上書きし、`update` でも付け外しできる。旧名 `claimed_by` は `assignee` と読む

### 5.5 Epic（`epics/e3.md`）

目的ごとにチケットを束ねる単位。Iteration（期間）・Plan（実行順）とは別の軸で、Iteration をまたぐ。

```markdown
---
id: e3
project: webapp
title: ログイン機能の刷新
status: open # open | closed
labels: [frontend]
created_at: 2026-10-31T04:00:00Z
updated_at: 2026-10-31T05:10:00Z
closed_at: 2026-11-20T09:00:00Z # closed のときだけ
---

## 概要

…
```

- EP-1 必須は `id`・`project`・`title`・`status`・`created_at`・`updated_at`。`status` は `open` / `closed` で、閉じたときに `closed_at` を書く。本文は Markdown で、`## 概要` を推奨し `dg lint` が欠けを指摘する
- EP-2 所属はチケットの `epic` で表し、Epic 側にチケットの一覧は持たない。入れるのは同じ Project のチケットだけ。Epic は入れ子にしない
- EP-3 進捗は保存しない。done の件数と abandoned を除く件数をチケットから都度求める
- EP-4 閉じる・再開するのは既定で誰でも行える（人に限るなら `actor.human_only`、5.10）。done・abandoned 以外のチケットが残るときは閉じるのを拒否し、強制の指定で閉じられる（残ったチケットの `epic` はそのまま）。閉じた Epic にはチケットを足せない（TK-6）
- EP-5 Epic の状態はチケットの遷移を縛らない。Epic に削除はない（閉じて残す）

### 5.6 Iteration（`iterations/s3.yaml`）

- IT-1 `id`、`project`、`name`、`goal`、`start`、`end`、`status`（`planned` / `active` / `closed`）を持つ。閉じるのは既定で誰でも行え（人に限るなら `actor.human_only`、5.10）、閉じたときに `closed_at` と完了・持ち越しの件数（`completed`・`carried_over`）を書く。`reopen` は active に戻して `closed_at` と件数を消し、外した持ち越しのチケットは戻さない。active は Project に 1 つに保つ。`start`・`reopen` はほかに active があれば拒否し、同時の操作や直接の編集で 2 つになれば `lint` が指摘する。`name`・`goal`・`start`・`end` は `update` で後から直せ、閉じた Iteration でも直せる
- IT-2 所属はチケットの `iteration` で表し、Iteration 側にチケットの一覧は持たない（Epic と同じ）。入れるのは同じ Project のチケットだけで、閉じた Iteration には入れられない。Iteration 内の並びは優先度と番号で、閉じるときに done・abandoned 以外のチケットの `iteration` を外す

### 5.7 Plan（`plans/p7.yaml`）

- PL-1 `id`、`project`、`tickets`、`after`（計画内だけの待ち。チケットの依存とは別）、`pending_approval`、`approved_by`、`approved_at`、`details.<ticket>.{scope, approach}`、`closed_at` を持つ
- PL-2 進捗は Plan に書かない。チケットの状態から都度求める。Plan を書くのは作成・承認・終了のときだけ
- PL-3 1 つのチケットは同時に 1 つの開いた（`closed_at` のない）Plan にしか入らない。done・abandoned のチケット、存在しないチケット、Plan と別の Project のチケットは入れられない。`after` と `details` は Plan に入れたチケットだけを指し、`after` は循環できない
- PL-4 `plan create` は承認待ち（`pending_approval: true`）で作り、採番のため即座にコミットして push する。`plan approve` は承認待ちの Plan に `approved_by`（操作した主体）と `approved_at` を書いて `pending_approval` を外す。`plan close` は `closed_at` を書き、終わっていないチケットが残れば警告する。閉じた Plan は承認も閉じ直しもできない。承認と終了は既定で誰でも行える（人に限るなら `actor.human_only`、5.10）
- PL-5 Plan の状態は保存せず、`pending_approval` と `closed_at` から求める（pending・approved・closed）。`plan list` は状態と進捗を出し、`ticket show` はチケットが入っている開いた Plan を出す
- PL-6 `plan list` と `plan show` は着手できるかを求める。`waiting`（`plan show` は `items[].waiting`）はチケットごとの待ちの相手（終わっていない `after` が先、`depends_on` が後。消したチケットへの `after` は待たない）、`ready` は todo で待ちのないもの、`next` は次（Plan の順で先の `ready`、なければ先頭の todo と待ちの相手）。閉じた Plan の `ready`・`next` は空。画面と手順はこれを読み、求め直さない

### 5.8 Workflow（`workflows/<id>.yaml`）

```yaml
id: software-development
name: Software Development
labels: # 任意。Status の表示名だけを変える
  review: コードレビュー
transitions: # 任意。制約を足す遷移だけ書く（WF-1）
  - { from: todo, to: in_progress, requires: [deps_done] } # 条件を足す（AND。OR は書けない）
  - { from: review, to: done, by: [human] } # 主体を絞る。[] でその遷移を禁止
reconcile: # 上から評価し、前進するときだけ書き換える
  - { when: [pr_merged], status: done } # squash マージは branch_merged で取れないので PR を先に見る
  - { when: [branch_merged], status: done }
  - { when: [pr_open, "!pr_draft"], status: review }
  - { when: [branch_exists], status: in_progress }
fields:
  - { id: estimate, type: number, label: 見積 }
steps: # 任意。Run の step の語彙（WF-5）
  - { id: merge, label: Merge, actions: [merge_pr], approval: true }
```

- WF-1 Status は全ワークフロー共通の 5 つ（`todo` / `in_progress` / `review` / `done` / `abandoned`）。前進の順は todo → in_progress → review → done で、`abandoned` は前進の軸の外の終端。既定では 5 つの間のどの遷移も、human / agent / reconcile の誰でも条件なしで行える。ワークフローは `transitions` で from → to ごとに `by`（行える主体。`[]` で禁止）と `requires`（条件）の制約を足すだけで、Status は増やせない（[ADR-003](adr/ADR-003-status-and-workflow.md)）
- WF-2 `requires` と `reconcile.when` に書けるのは組み込みの事実（`deps_done`、`branch_exists`、`branch_pushed`、`branch_merged`、`pr_open`、`pr_draft`、`pr_merged`）とその否定（`!pr_draft`）だけ。`deps_done` は `depends_on` のすべてが done か abandoned のとき真（やめたチケットは待たない。別の Project の依存先も見る）。`ticket list` と `ticket show` はチケットごとの `deps_done` を出す。利用者のスクリプトは実行しない
- WF-3 存在しない Status を指す項目、未知の条件・Action、同じ遷移・step の重複は読み込み時と `dg workflow validate` で指摘する
- WF-4 `software-development`・`consulting`・`general` のテンプレートを同梱し、`dg init` が 3 つとも置く（既にある Workflow は書き換えない）。`default` プロジェクトの Workflow はそのどれかを選べ、既定は `general`
- WF-5 `steps` は Run の step の語彙で、項目は `id`・`label`・`actions`（Action の名前）・`approval`（承認の要否）。`run start` は語彙にない step を拒否する（`steps` がなければ縛らない）。手続きは `dg guide` が持つ
- WF-6 `dg workflow set` は Workflow を 1 つ作るか置き換える。定義か同梱のテンプレートのどちらか一方を受け、読み込み時に索引から外れる誤り（WF-3。未知の Action は警告だけ）があるか定義の `id` が違えば何も書かない。1 回の書き込み（SY-2）で書き、前と後を出す

### 5.9 Run（`runs/`）

- RN-1 1 Run 1 ファイル。`id`、`ticket`、`step`、`agent`、`model`、`started_at`、`finished_at`、`result`（`success` / `failure` / `interrupted`）、`error`、`retries`、`retry_reasons`（やり直しの理由の配列）、`usage`（input / output / cache_read / cache_write のトークン）。`ticket list` は各行に `run_agent`（実行中の Run の `agent`、なければ最後の Run の `agent`、Run がなければ `null`）を出す
- RN-2 取れなかった値は `null`。推定した値は `estimated: true` を付ける。費用は持たない（[ADR-005](adr/ADR-005-work-metrics.md)）
- RN-3 Git に入れるのは完了時の集計だけ。実行中の記録は `deguboard-local/runs/` に置く。チケットには書き足さない

### 5.10 設定（`config.yaml`）

項目は `default_project`、`git.remote`・`git.base_branch`、`worktree.root`、`commit.mode`（既定 `batch`）、`push.mode`（既定 `auto`）、`metrics.read_transcripts`（既定 `false`）、`actions.shell`（AG-7、既定 `false`）・`actions.test`、`actor.human_only`、`auto.merge`（既定 `false`）、`lint.require_iteration`（既定 `false`）。

`actor.human_only` は `epic.close` のようなコマンド名の一覧で、入れたコマンドを agent が呼ぶと `TRANSITION_REJECTED` で拒否する。既定は空で、すべての操作をエージェントにも許す。チケットの遷移を人に限るのは Workflow の `by`（WF-1）で、この項目では扱わない。

`lint.require_iteration` を true にすると、`dg guide` が claim の前に Iteration に入れるよう案内し、`dg lint` が入れずに進んだチケットを指摘する。

各項目の意味・値・既定値はスキーマ（`packages/core/src/model/config.ts`）が正本。利用者ごとの上書きは設けない。

## 6. 機能要件

### 6.1 `dg` CLI

- CL-1 すべてのコマンドに `--json` があり、エージェントはそれを読む。成功は `{ ok: true, data, warnings, write }`、失敗は `{ ok: false, error: { code, message, detail } }`。終了コードは 0（成功）/ 1（失敗。`validate`・`lint` は指摘があるとき）/ 2（使い方の誤り）。`error.code` の語彙は `packages/core/src/errors.ts` が正本
- CL-2 コマンドの一覧とオプションは `dg --help` が正本。群は用意（`init`・`sync`・`commit`・`validate`・`lint`・`config`・`whoami`）、`project`、`ticket`、`iteration`（`sprint` はエイリアス）、`epic`、`workflow`、`plan`、`history`、`run` と `metrics`、画面と MCP（`serve`・`open`・`mcp`）、手順（`guide`・`skill install`）
- CL-3 書き込みを伴うコマンドは、`commit.mode` に従って deguboard ブランチにコミットする。作成（`init`、`project / ticket / epic / iteration / plan create`、`ticket import`）・`ticket claim`・`iteration start / reopen` は `commit.mode`・`push.mode` によらず即座にコミットして push する（採番と排他のため）
- CL-4 `ticket import` は YAML / JSON の下書き（配列）を 1 コミットで取り込む。下書きの中の仮キーを `depends_on` から参照でき、`epic` に既存の Epic を書ける
- CL-5 `dg guide <topic>` は、エージェント向けの手順を `config.yaml` の値を埋めて出す。トピックの一覧は `dg guide overview`（省略時）。手順の正本は CLI に同梱した Markdown（`packages/cli/src/guide-*.md`）
- CL-6 CLI はビジネスロジックを持たず、Core のコマンド定義（`packages/core/src/commands/`）を写す
- CL-7 `history` は deguboard ブランチの git の履歴から、チケット・Epic・Iteration の起票と、`status`・`iteration`・`epic`・`assignee`・`pr` の変化を、時刻・コミット・作者・コミットの 1 行目とともに古い順に返す。データの形は変えず、差分から読む。Epic・Iteration で絞ると、一度でも入っていたチケット（持ち越しで外されたものを含む）の経過も返す。浅い clone では欠けたこと（`shallow`・`incomplete`）を返して失敗しない

### 6.2 状態遷移と照合

- ST-1 `status` はチケットに保存する。変えるのは `ticket move`・`claim`・`unclaim`、UI の操作、照合だけ
- ST-2 遷移は Workflow の `transitions` の制約で検査する。`by` に含まれない主体の遷移と `requires` を満たさない遷移は拒否し、制約のない遷移は誰でも行える。同じ Status への move は拒否する
- ST-3 `claim` は todo のチケットの `assignee` を claim した主体にし、`branch` を記録して in_progress に進める。PR も作業ブランチも要らない作業は、ブランチなしの指定で `branch` を記録しない。todo 以外は拒否する。終わっていない別のチケットが記録している名前と、前の作業でマージ済みのまま残った同じ名前のブランチ（先端が base の真の祖先）は `BRANCH_IN_USE` で拒否し、`update` で `branch` を変えるときも同じ。別のユーザが `assignee` だったときは上書きして警告する。依存先が終わるまで着手を止めたいときは Workflow で todo → in_progress に `requires: [deps_done]`（WF-2）を書く
- ST-4 照合は `dg sync` と、画面の同期（UI-6・UI-12）で行う。`branch` のあるチケットについて Git から事実を集め（`branch` のないチケットは照合せず、状態は `ticket move` で進める）、`reconcile` 規則を上から評価し、今より前進の順が先のときだけ書き換える。`done` と `abandoned` のチケットには触れない。done に進めたチケットに未チェックの受け入れ条件が残れば警告する
- ST-5 後退を指す事実（消えたブランチ・マージされずに閉じた PR）は書き換えず警告する。`gh` が PR はないと答えたときは、閉じた PR として警告しない。ただし同じ照合で done に進むときは、マージ後に消したブランチなので警告しない。取れなかった事実は不明とし、前進の判定では偽と読む。`branch_merged` は先端が base の真の祖先のとき真だが、in_progress で push していないブランチは commit のない切ったばかりのブランチとみなして偽にする（理由は [ADR-004](adr/ADR-004-agents-and-state.md)）。照合の結果（`reconciled`）には根拠の規則の条件（`when`）を含める
- ST-6 PR の事実は `gh` が使えるときだけ取る。`gh` がなくても照合は Git の事実だけで成り立つ。`pr` のないチケットの PR をブランチ名で見つけたら、状態が進まなくても番号を `pr` に記録する。記録済みの `pr` は書き換えない。ブランチ名で見つけた PR が `branch_at`（ない古いチケットは `created_at`）より前にマージされていたら、同じ名前を使い回した前の作業の PR とみなし、PR はないと読んで警告する。`pr` を記録していれば比べない
- ST-7 `unclaim` は in_progress のチケットの、自分（同じユーザの人と AI）の claim か記録のない claim だけを外して todo に戻し、`assignee`・`branch`・`branch_at` を消す。応答のない claim は強制の指定で外す。生存監視はしない
- ST-8 `abandoned` にすると claim を外し、Iteration の完了件数と Epic の進捗には数えない。todo に戻す（再開・done の取り消し）ときも `assignee`・`branch`・`branch_at` を消す。これらを人だけに限るなら Workflow の `by: [human]` で書く

### 6.3 Git 同期と排他

- SY-1 `dg init` は deguboard ブランチを作るか取り込み、専用 worktree を用意し、`default` プロジェクトとテンプレートのワークフローを置く
- SY-2 書き込みの単位は「取り込み → 変更 → 検証 → コミット →（`push.mode: auto` か即時の操作なら）push」。push が拒否されたら取り込み直して再送する。送れなければコミットを残し、次の同期で再送する
- SY-3 claim・作成・`iteration start / reopen` は push の成功をもって取得とする。拒否されたらローカルのコミットを捨てて取り込み直し、判定し直す
- SY-4 同期は rebase で取り込み、チケットと Epic の frontmatter はマージドライバがフィールド単位で 3-way マージする（片側だけ変えたフィールドはその値、`updated_at` は新しい方）。`dg init` と `dg sync` がドライバを git config と deguboard ブランチの `.gitattributes` に登録する。同じフィールドを両側が違う値に変えたときと本文の同じ行の競合は、rebase を中止してローカルのコミットを残し、`dg sync` が競合を報告する。競合が残る間は push・照合・作成・claim・`iteration start / reopen` が止まる。人は deguboard worktree で `git rebase <remote>/deguboard` から解いて `git rebase --continue` するか、`git reset --hard <remote>/deguboard` でローカルのコミットを捨てて操作をやり直し、`dg sync` を回す
- SY-5 同一マシンの書き込みは `deguboard-local/locks/` のロックで直列にし、同じチケットと step の Run の二重起動も同じ場所のロックで防ぐ。チーム間の排他には使わない
- SY-6 リモートがなくても、同期を除くすべての操作が動く

### 6.4 画面（Web UI・VS Code 拡張）

Web UI は `dg serve` が配信し、VS Code 拡張は同じ React アプリを Webview に載せる。表示と操作は両方で同じ（[ADR-006](adr/ADR-006-ui-and-writes.md)）。

- UI-1 プロジェクトの切り替え
- UI-2 カンバン：選んだ Iteration（既定は active）のチケットを Status ごとの列に出す（表示名は Workflow の `labels`）。ドラッグ＆ドロップで Status を変え、`ticket move` と同じ検査で拒否されたら理由を出して戻す。Epic と担当者で絞れる。閉じた Iteration・Epic の終わったチケットは出さない。VS Code のサイドバーでは、Iteration を planned と active の札で切り替え、行に変化の点滅・実行中の Run の印・担当の印を出し、開いた Plan に入っていれば Plan の番号と、todo なら着手可・待ちの相手（PL-6 の `waiting`）・承認待ち（Plan が承認待ち）を出し、待ちと承認待ちの行は実行中の Run がなければタイトルを薄くする
- UI-3 バックログ：done・abandoned 以外のチケットを Iteration ごとの区画に分けて出し、検索と絞り込みができる。別の区画へのドラッグで Iteration を変え、`ticket update` と同じ検査で拒否されたら理由を出して戻す。VS Code のサイドバーでは、区画の見出しを Iteration の状態の色の帯と 2 段（番号・名前・件数／期間・目標）にし、開始・閉じるは詳細の画面で行う。Epic の欄は open の Epic があるときだけチップで出す。行には、開いた Plan に入っていればカンバンと同じ Plan の番号と着手可・待ちの相手・承認待ちを出す。担当者は名前の列を出さず、操作している人（`whoami`）とその agent のときは出さず、別の人のときだけカンバンと同じ担当の印（頭文字の丸。全名はツールチップ）を出す。検索欄の右端の漏斗（カンバンと同じ）で絞り込みの欄を開き、その下によく使う絞り込み（自分・作業中・high）のチップと、効いている条件を × で外せる札を出し、件数は絞り込みが効いているときだけ「n / m 件」で出す
- UI-4 チケット詳細：本文（概要・受け入れ条件）、属性、Epic、依存先と依存元、起票者と担当者、作業ブランチ、PR、Run の一覧、経過（CL-7）。PR はリモートの URL から PR のページへのリンクにする（直せなければ番号だけ）。属性と本文を編集できる
- UI-5 Iteration：作成・開始・閉じる、詳細の画面でチケットの追加・除外ができる。閉じた Iteration・Epic と終わったチケットは履歴の画面で見る（終えた日は CL-7 から求める）
- UI-6 未 push のコミットと、取り込んでいないリモートの更新があることを印で知らせる。同期のボタンで `dg sync` と同じ同期を行い、画面を読み直す。リモートがなければ照合と読み直しだけを行う
- UI-7 画面からの書き込みは Core の同じコマンドを通り、`commit.mode` に従ってコミットする
- UI-8 `dg serve` は既定で `127.0.0.1` にバインドする。認証は持たない
- UI-9 実行中・完了の Run と MT-3 の単位別集計
- UI-10 Epic：open の Epic の進捗（EP-3）を出し、Epic でチケットを絞れる。詳細の画面で Epic のチケットを Status ごとに出し、チケットの追加・除外、閉じる・再開ができる。VS Code では Status ごとの列（カンバン）にせず、未完了・完了・中止の段に分けた 1 本の一覧で出す
- UI-11 VS Code 拡張は `dg` を同梱せず、Webview のために `core` を同梱する。画面は `dg` なしで動き、`dg` が PATH にないときはインストールを案内する。`dg` の版と拡張の `core` の版のメジャーが違えば知らせる（[ADR-006](adr/ADR-006-ui-and-writes.md)）
- UI-12 VS Code 拡張はサイドバーのビューを主画面にして同じ画面を出し、エディタ領域のパネルにはサイドバーから開いた詳細（チケット・Iteration・Epic）だけを出す。パネルからの一覧の画面へのリンクは、サイドバーをその画面に切り替える。ビューのタイトル行に同期のボタン（UI-6）・設定の歯車（UI-14）と未 push・未取り込みの件数を出す。サイドバーのバックログの行の右クリックで「Iteration を移す」（閉じていない Iteration か「Iteration なし」から選び、ドラッグと同じ `ticket update`）・「詳細を開く」・「ID をコピー」を出す。データ worktree と実行中の Run の記録の変化を見張り、CLI やエージェントの書き込みを自動で画面に映す（[ADR-006](adr/ADR-006-ui-and-writes.md)）
- UI-13 実行計画：カンバン（UI-2）の上に、選んだ Iteration のチケットを含む Plan を出す。Plan ごとに番号・状態・進捗と、作業中のチケット・次に着手するチケット（PL-6 の `next`。手順と同じ）を出し、`after` の依存グラフ（ノードの待ちは `waiting`）を開閉できる。表示だけで書き込まない
- UI-14 設定画面：歯車（UI-12。ブラウザは上のバー）と画面内の戻るボタンで、設定画面と来る前の画面（なければカンバン）を切り替える。`config.yaml` の全項目（5.10）をまとまりごとに名前・キー・スキーマの説明・型に合う入力欄で出し、検索で絞れる。値を変えると `config.set` で保存し、拒否なら理由を出して戻す。既定から変えた項目に印と既定に戻す操作を出し、チーム全員に効くことを常に示す。`git.*`・`worktree.root`・`actions.*`・`actor.human_only` は保存前に確かめる。VS Code の settings.json は使わない

画面の並び順・色・文言とサイドバーの細部は web のコード（`packages/web/src/`）とテストが正本。

### 6.5 エージェント連携

- AG-1 エージェントは PATH の `dg` を Bash から `dg … --json --actor agent` で呼び、データのファイルを直接編集しない。human と agent の区別は申告（`--actor` か環境変数 `DEGUBOARD_ACTOR`。既定は human）に基づき、Skill と `dg guide` の手順は必ず agent を名乗る。主体の ID はユーザ名（`--user`、環境変数 `DEGUBOARD_USER`、git config の `deguboard.user`、git の `user.name`、OS のユーザ名の順）と種別から `<ユーザ>`（human）か `<ユーザ>/agent`（agent）になり、`created_by` と `assignee` に記録される（TK-7）。`whoami` は操作している主体とユーザ名の出どころ、本人とみなす ID（`<ユーザ>` と `<ユーザ>/agent`）を返し、画面はこれで担当者が自分かを見分ける。権限管理ではない（対象外）
- AG-2 Claude Code 向けに、段階ごとに `dg guide <topic>` を読む薄い Skill（`dg<トピック>`。例 `/dgimport`）を `dg skill install` で配る。名前と説明は guide の frontmatter が正本。手を加えていない Skill は再実行で更新し、手を加えたものは強制の指定がなければ残す
- AG-3 エージェントは要件の整理が終わったら、必要に応じてチケット化を提案し、承認を得て `ticket import` で起票する。分解・Epic への束ね・依存の整理・Iteration への割り当ても提案して承認を得る
- AG-4 MCP サーバー（`dg mcp`。stdio）は、Bash のないクライアント（Claude Desktop など）から起票・閲覧・状態の更新をする入口として、Core のコマンド定義から生成する薄い層で提供する。CLI と同じ操作ができ（`init` と CLI だけの `guide`・`skill`・`serve`・`open` を除く）、ツールの結果は `--json` と同じ形（CL-1）で、主体は常に agent（`<ユーザ>/agent`）。対象のリポジトリは `-C` で指せる（クライアントがリポジトリの外で起動するため）
- AG-5 Agent Adapter が使用量の取得と作業ディレクトリの差を吸収し、製品ごとの実装は Core の `agents/adapters/` に閉じる。今は `claude-code` と `codex`。起動方法と権限は扱わない（EX-1、[ADR-007](adr/ADR-007-architecture.md)）
- AG-6 ソフトウェア開発向けの Action（worktree・ブランチ・テスト・PR 作成・マージ）は Core の `actions` に置き、汎用部分は依存しない。`dg` のコマンドにせず Core 内のライブラリに留め、公開するのは名前の一覧（`ACTION_NAMES`）だけ（[ADR-007](adr/ADR-007-architecture.md)）
- AG-7 任意のシェルの Action は `actions.shell: true` のときだけ使え、毎回確認を経る

### 6.6 作業の実績

- MT-1 Run の使用量は Adapter が取り込む。エージェントの自己申告の数字は書かない
- MT-2 `metrics.read_transcripts`（チームで共有する設定）が true なら、`run finish` が Adapter でエージェントの会話記録から使用量を補う。`DEGUBOARD_NO_TRANSCRIPTS` が空でも `0` でもないマシンでは true でも読まない
- MT-3 `metrics show` は Run・Ticket・Epic・Iteration・Project・Agent/Model・Step で絞り集計する。null は足さず欠けた数を出す。集計値は保存しない
- MT-4 Adapter が会話記録から Run に写すのは数とモデル名だけで、会話の中身・コマンドの文字列・パスは写さない。例外の `error` は `run finish --error` の理由をそのまま記録するので、秘密を書かない。`retry_reasons` は `--retry-reason` をそのまま記録するので、秘密・コマンドの文字列・パスを書かない

### 6.7 ワークフロー実行

- EX-1 deguboard はエージェントを起動しない。チケットの処理はエージェント側の Skill が `dg` を呼んで進める
- EX-2 終了していない Run は一覧で見え、`interrupted` として閉じられる
- EX-3 段階を続けて進める手順は Skill 側に置き、着手できるチケット（`ticket list` の `ready` での絞り込みか、各行の `deps_done`）と Plan の順序に従う。`dg guide all --auto` は戻せる判断を自動で選び、`auto.merge` が true なら条件を満たした PR をマージする。Plan の待ちのない複数のチケットはチケットごとのサブエージェントで同時に進め、1 件の失敗やマージ待ちでほかを止めない。品質ゲート（検査・受け入れ条件・別のサブエージェントの見直し・衝突なし）は PR を出す前とマージの前に通し、手直しの Run に直した指摘を `retry_reasons` で残す。修正の回数の上限を超えたら PR を draft のまま人に渡す。同時に進める上限・修正ループの回数・Run の分け方は guide（`parallel`・`review`・`all`）が正本
- EX-4 Workflow が `by: [human]` で人に限った遷移は、エージェントからは行えない

## 7. 非機能要件

- NF-1 外部の専用サーバーなしで動く。リモートがなければオフラインでもタスク管理ができる（SY-6）
- NF-2 CLI・HTTP・VS Code 拡張は同じ Core のコマンド定義を使い、ビジネスロジックを重複実装しない（CL-6）
- NF-3 データ形式は人と AI の両方が読める（Markdown・YAML・JSON）
- NF-4 更新は検証と原子的な書き込みを行い、ファイルを壊さない
- NF-5 同時更新の競合を検出して報告する
- NF-6 Workflow の `transitions` の制約に反する状態遷移を作れない
- NF-7 Run の停止・失敗から、状態を壊さずに復旧できる
- NF-8 サーバーは既定で localhost にバインドする（UI-8）
- NF-9 Workflow に書かれた任意のコマンドを無条件に実行しない
- NF-10 Git 管理するログと実績に秘密情報を含めない
- NF-11 `core` は VS Code API・HTTP・React に依存しない。依存の向きは [ADR-007](adr/ADR-007-architecture.md)

## 8. 対象外

次のものは範囲に含めない。必要になったら ADR を書き換えてから本書に足す。

- deguboard がエージェントを起動・監視すること、ツール側のスケジューラ（[ADR-004](adr/ADR-004-agents-and-state.md)）
- Milestone（Iteration で表す。[ADR-009](adr/ADR-009-epic-and-iteration.md)）
- Epic の入れ子と、チケットの親子関係（サブタスク）。束ねるのは Epic の 1 段だけ（[ADR-009](adr/ADR-009-epic-and-iteration.md)）
- 推定費用の記録（[ADR-005](adr/ADR-005-work-metrics.md)）
- Workflow の条件に利用者のスクリプトを使うこと
- 複数 PC 間の排他（claim の push で足りる）
- Webhook によるリアルタイム同期、外部への通知
- 権限管理などのチーム運用の機能
- Windows
