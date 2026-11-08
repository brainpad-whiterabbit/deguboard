# deguboard 要件定義書

今の仕様の正本。利用者（人・エージェント）に約束する振る舞いとデータの形だけを書く。細部（CLI オプション、集計の規則、画面の並びや文言）はヘルプ・コード・テストが正本で、各節から案内する。判断の理由は [ADR 一覧](adr/README.md)から引く。書く範囲は [ADR-001](adr/ADR-001-doc-strategy.md)。

要件の ID（`TK-1` など）はコードとテストから参照する。ID とアンカーの扱いは ADR-001。まだ実装していない項目には「予定（`<Epic の ID>`）」を添える。予定は時期の約束ではない。

要件の ID の接頭辞：`AG`・`CL`・`DT`・`EP`・`EX`・`IT`・`MT`・`NF`・`PL`・`RN`・`ST`・`SY`・`TK`・`UI`・`WF`。節を消しても接頭辞は一覧から消さない。新しい接頭辞はこの一覧に足す。

## 1. 目的

deguboard は、Git で管理するチケットとユーザー定義のワークフローを組み合わせた、Local-first で AI エージェント対応のタスク管理ツールである。

- 人は「何を作るか」「どの順で進めるか」「成果物を承認するか」を決める
- AI エージェント（Claude Code・Codex など）は、普段どおりの対話の中でチケットの起票・計画・実行・レビュー・完了を進める。エージェントは人が動かし、deguboard は起動も監視もしない（[ADR-028](adr/ADR-028-agents-and-state.md)）
- データは Git リポジトリ内のテキストファイルで管理し、外部 SaaS・DB・常駐サーバーを必須としない
- ソフトウェア開発・コンサルティング・調査・資料作成など、業務の違いはワークフロー定義で表し、Core に組み込まない

## 2. 想定利用者と前提

- **利用者**：個人、および同じ Git リポジトリを共有する小規模チーム
- **実行環境**：Linux / macOS。Node.js 24 以上。`dg` は npm で入れる（公開までは README の手順でビルドする）。画面は VS Code 1.123 以上（デスクトップ）の拡張だけ。`dg serve` は開発用（配置の確認とスクリーンショット）で、利用者の入口ではない（[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）
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

- **ソフトウェア開発**：エージェントが要件をチケットに分解し、Epic に束ね、依存を付けて Iteration に入れる。チケットごとに claim して作業ブランチで実装し、PR を作る。別のエージェントか人がレビューし、マージされると照合で done になる。Run に使用量が残る
- **コンサルティング**：調査・分析・資料作成・レビューの工程を Workflow の step として定義し、同じ仕組みでチケットを進める。PR はなく、成果物のブランチがマージされると done になる

## 5. データ要件

項目の全体と型は Zod のスキーマ（`packages/core/src/model/`）が正本。ここには配置、必須の項目、振る舞いに効く項目の意味と項目どうしの決まりだけを書く。

### 5.1 配置

- データは orphan ブランチ `deguboard` に置き、`<git-common-dir>/deguboard/` に専用 worktree として checkout する。読み書きはすべてここで行い、作業ブランチにはデータを置かない（[ADR-002](adr/ADR-002-storage-and-id.md)）
- Git 管理外のもの（ローカルロック、実行中の Run の記録、マージドライバの属性ファイル、個人の設定 `config.yaml`（5.10））は `<git-common-dir>/deguboard-local/` に置く

```
config.yaml
.gitattributes              # マージドライバを当てるパス（SY-4）
projects/<slug>.yaml
tickets/t12.md              # 1 チケット 1 ファイル。ファイル名は ID そのまま
tickets/deleted/t9.md       # 墓標。番号を再利用しない
epics/e3.md
iterations/s3.yaml
plans/p7.yaml
workflows/<id>.yaml
runs/r20261031-041500-3fa2.json  # Run の完了時の集計だけ。ID は開始日時と乱数
```

- DT-1 書き込みは一時ファイルへ書いてから rename する。読み込みは Zod のスキーマで検証し、読めないファイルは止めずに `dg validate` と画面で報告する
- DT-2 スキーマにない項目は読み書きで残す（版の違う `dg` が消さない）

### 5.2 ID と番号

- DT-3 ID は接頭辞＋連番（`t12`・`e3`・`s3`・`p7`）。ファイル名は ID そのままでゼロ埋めしない。番号はリポジトリ全体で一意で、CLI と UI は番号で並べる
- DT-4 採番は「既存と墓標の最大 + 1」。作成は fetch → 採番 → commit → push を 1 単位とし、push が拒否されたら採番し直す
- DT-5 push できないときは `provisional: true`（仮番号）を付けてローカルに commit し、push が済んだ `dg sync` で外す。仮番号がリモートの番号と衝突したら、`dg sync` が次の空き番号に振り直して push する（範囲は `packages/core/src/git/renumber.ts`）。ほかの競合は報告する（SY-4）
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
depends_on: [t9]
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
- TK-3 本文は Markdown。`## 概要` と `## 受け入れ条件`（`- [ ]` のチェックリスト）を推奨し、`create` / `import` が雛形を作り、受け入れ条件は `ticket check` が番号で印を付ける。節の欠けや状態の食い違い、実装と手直しの Run の抜け（RN-5・RN-6。細部は ADR-029）は `dg lint` が指摘する（項目は `dg lint --help`）
- TK-4 Workflow の `fields` で定義した任意フィールドを frontmatter に持てる
- TK-5 受け入れ条件のチェックは、作業した人かエージェントが確認できたときに付ける。deguboard は自動で付けず、照合で done にしたチケットに未チェックが残れば `sync` が警告する（遷移は止めない。[ADR-003](adr/ADR-003-status-and-workflow.md)）
- TK-6 `epic` は同じ Project の Epic の ID。閉じた Epic には付けられない
- TK-7 `created_by`（起票者）と `assignee`（担当者）は主体の ID。`created_by` の既定は操作した主体で、エージェントが人の指示・承認で起票するときはユーザ本人を指定する。`assignee` は `claim` と `update` で付ける。旧名 `claimed_by` は `assignee` と読む
- TK-8 `priority` は `low`・`medium`（既定）・`high`。値ごとの判断基準は Core が既定を持ち、`config.yaml`（5.10）で書き換えられる

### 5.5 Epic（`epics/e3.md`）

目的ごとにチケットを束ねる単位。Iteration（期間）・Plan（実行順）とは別の軸で、Iteration をまたぐ。Ticket と同じく frontmatter と Markdown の本文を持ち、`status` は `open` / `closed`。

- EP-1 必須は `id`・`project`・`title`・`status`・`created_at`・`updated_at`。閉じたときに `closed_at` を書く。本文は Markdown で、`## 概要` を推奨する
- EP-2 所属はチケットの `epic` で表し、Epic 側にチケットの一覧は持たない。入れるのは同じ Project のチケットだけ。Epic は入れ子にしない
- EP-3 進捗は保存しない。done の件数と abandoned を除く件数をチケットから都度求める。`epic show` と `iteration show` は同じ形の `progress` を返す
- EP-4 閉じる・再開するのは既定で誰でも行える（人に限るなら `actor.human_only`、5.10）。done・abandoned 以外のチケットが残るときは、強制の指定がなければ閉じない。閉じた Epic にはチケットを足せない（TK-6）
- EP-5 Epic の状態はチケットの遷移を縛らない。Epic に削除はない（閉じて残す）

### 5.6 Iteration（`iterations/s3.yaml`）

- IT-1 `status` は `planned` / `active` / `closed` で、期間を `start`・`end` に持つ。閉じたときに `closed_at` と完了・持ち越しの件数（`completed`・`carried_over`）を書く（日付の書き換えは `iteration start / close --help`）。閉じる・再開するのは既定で誰でも行える（EP-4 と同じ）。active は Project に 1 つに保つ
- IT-2 所属はチケットの `iteration` で表し、Iteration 側にチケットの一覧は持たない。入れるのは同じ Project のチケットだけで、閉じた Iteration には入れられない。並びは優先度と番号の順で、閉じるときに done・abandoned 以外のチケットの `iteration` を外す。進捗は都度求める（EP-3）。`iteration show` は次の操作 `next` と中のチケットを含む Plan `plans` を返し、画面はこれを読む（形は `packages/core/src/commands/iteration.ts`）

### 5.7 Plan（`plans/p7.yaml`）

- PL-1 入れるチケット `tickets`、計画内だけの待ち `after`（チケットの依存とは別）、チケットごとの範囲・方針・難しさの段階 `details.<ticket>.{scope, approach, tier}` を持つ。`tier` は `light` / `standard` / `heavy` で、モデル名は書かない（対応は 5.10 の `models.*`）
- PL-2 進捗は Plan に書かない。チケットの状態から都度求める。Plan を書くのは作成・承認・終了のときだけ
- PL-3 1 つのチケットは同時に 1 つの開いた（`closed_at` のない）Plan にしか入らない。done・abandoned のチケット、存在しないチケット、Plan と別の Project のチケットは入れられない。`after` と `details` は Plan に入れたチケットだけを指す。`after` の循環と、`after` と `depends_on` をまたぐ循環は Plan を作るときに拒否し、後からできたものは lint が指摘する（たどり方は `packages/core/src/storage/wait-cycle.ts`）
- PL-4 `plan create` は承認待ち（`pending_approval: true`）で作る。`plan approve` は `approved_by`・`approved_at` を書いて `pending_approval` を外す。`plan close` は `closed_at` を書き、終わっていないチケットが残れば警告する。閉じた Plan は承認も閉じ直しもできない。承認と終了は既定で誰でも行える（EP-4 と同じ）
- PL-5 Plan の状態は保存せず、`pending_approval` と `closed_at` から求める（pending・approved・closed）。`plan list` と `plan show` は `status` に返し、画面はこれを読む
- PL-6 `plan list` と `plan show` は着手できるかを求めて返す。`waiting` はチケットごとの待ちの相手（終わっていない `after` と `depends_on`）、`ready` は todo で待ちのないもの、`next` は次に進めるもの。画面と手順はこれを読み、求め直さない（求め方は `packages/core/src/commands/plan.ts`）

### 5.8 Workflow（`workflows/<id>.yaml`）

```yaml
id: software-development
name: Software Development
labels: # 任意。表示名だけを変える
  review: レビュー
transitions: # 任意。制約を足す遷移だけ書く（WF-1）
  - { from: todo, to: in_progress, requires: [deps_done] } # AND
  - { from: review, to: done, by: [human] } # [] で禁止
reconcile: # 上から評価する（ST-4）
  - { when: [pr_merged], status: done }
  - { when: [branch_merged], status: done }
  - { when: [pr_open, "!pr_draft"], status: review }
  - { when: [branch_exists], status: in_progress }
fields:
  - { id: estimate, type: number, label: 見積 }
steps: # 任意（WF-5）
  - { id: implement, label: Implement, opens_on: claim } # RN-5
  - { id: fix, label: Fix, opens_on: reclaim } # RN-5
  - { id: merge, label: Merge, actions: [merge_pr], approval: true }
```

- WF-1 Status は全ワークフロー共通の 5 つ（3. 用語）で、増やせない。前進の順は todo → in_progress → review → done で、`abandoned` は前進の軸の外の終端。既定ではどの遷移も誰でも条件なしで行え、ワークフローは `transitions` で `by`（行える主体）と `requires`（条件）の制約を足すだけ（[ADR-003](adr/ADR-003-status-and-workflow.md)）
- WF-2 `requires` と `reconcile.when` に書けるのは組み込みの事実（`deps_done`、`branch_exists`、`branch_pushed`、`branch_merged`、`pr_open`、`pr_draft`、`pr_merged`）とその否定（`!pr_draft`）だけ。`deps_done` は `depends_on` のすべてが done か abandoned のとき真（別の Project の依存先も見る）。利用者のスクリプトは実行しない
- WF-3 存在しない Status・未知の条件と Action・重複などの誤りは、読み込み時と `dg workflow validate` で指摘する（検査の項目は `packages/core/src/workflow/validate.ts`）
- WF-4 `software-development`・`consulting`・`general` のテンプレートを同梱し、`dg init` が 3 つとも置く（既にある Workflow は書き換えない）。`default` プロジェクトの Workflow はそのどれかを選べ、既定は `general`
- WF-5 `steps` は Run の step の語彙（項目は上の例。`opens_on` は RN-5）で、`run start` は語彙にない step を拒否する（`steps` がなければ縛らない）。手続きは YAML に書かず、既定の手続きは Core が（予定 e15。EX-3）、各手のやり方は `dg guide` が持つ
- WF-6 `dg workflow set` は Workflow を 1 つ作るか置き換え、WF-3 の誤りがあれば何も書かず、前と後を返す（細部は `dg workflow set --help`）

### 5.9 Run（`runs/`）

- RN-1 1 Run 1 ファイル。チケット・step・エージェント・モデル・時刻・結果（`success` / `failure` / `interrupted`）・使用量・ツールの回数・やり直しの理由・セッション ID と、見直しの Run なら見直しの結果を持つ。会話記録のパスは Adapter の置き場所の下だけ受け付け、Git に入れない（RN-3）。項目は `packages/core/src/model/run.ts`、値の決め方は `dg run start --help`
- RN-2 取れなかった値は `null`。推定した値は `estimated: true` を付ける。費用は持たない（[ADR-029](adr/ADR-029-work-metrics.md)）
- RN-3 Git に入れるのは完了時の集計だけで、チケットには書き足さない。実行中の記録・会話記録のパス・保留の見直しの結果とやり直しの理由・フックの入力の有無は、このマシンの `deguboard-local/` に置く（`packages/core/src/run/record.ts`）。会話記録のパスは終了の時刻から 30 日残し、`dg run prune-transcripts` が消す（細部は `dg run prune-transcripts --help`）
- RN-4 閉じた Run で書き換えるのは、`run refresh`（MT-5）が取り直すモデル名と使用量と、結果のない閉じた見直しの Run（チケットの最新の Run のとき）に 1 回だけ書く見直しの結果だけ（結果の記録がないことで `failure` だった Run は `success` に直す。細部は `dg run review-result --help`）
- RN-5 agent の `ticket claim` は実装の Run（`opens_on: claim` の step、なければ `implement`）を開いて ID を返し、開けなくても claim は成功にする。もう一度の claim（ST-3）は手直しの Run（`opens_on: reclaim`、なければ `fix`）を開く。人の claim と `--no-run` では開かない（二重の起動は SY-5）。細部は `dg ticket claim --help`
- RN-6 実装の Run は PR の記録（照合を含む）と PR なしで終えた作業の前進で `success`。手直しの Run は次の Run の開始・前進・チケットの終了で `success`、別セッションの残りは `interrupted`。`unclaim`・`abandoned` の Run と、照合で戻った・取られたチケットの実装の Run は `failure`。照合は残りも閉じる。先に閉じられた Run は警告だけで、操作と照合を止めない。細部は各 `--help` とテスト
- RN-7 印 `deguboard: ticket=<id> step=<step>` で頼んだサブエージェントの Run は、フック（AG-9）が起動で開き、step を終えた事実で閉じ、事実がなければ止まって待っている印を付け、セッションの終わりに残りを閉じる。細部は `dg hook --help` とそのテスト、理由は [ADR-025](adr/ADR-025-runs-by-hooks.md)
- RN-8 `dg run retry-reason` は、実行中の手直しの Run の `retry_reasons` に直した指摘を書き足し、回数を理由の数にする。書く先がなければ保留し、フックが手直しの Run を閉じるときに結び付ける（細部は `dg run retry-reason --help`）

### 5.10 設定（`config.yaml`）

項目と意味・値・既定値・範囲（scope）はスキーマ（`packages/core/src/model/config.ts`）、`config.set` の値の扱いは `dg config set --help` が正本。エージェントや記録に関わるもの（`metrics.read_transcripts`・`actions.shell`・`auto.merge`）は既定で `false`。

- チームの `config.yaml` は deguboard ブランチで全員が共有し、人ごとに違ってよい項目（scope が `local`）だけは Git に入らない `deguboard-local/config.yaml`（5.1）で上書きできる（`dg config set --local`。コミットも push もしない）。値は「個人 > チーム > 既定」の順に読み、CLI・`dg serve`・VS Code 拡張は Core 経由で同じ値を使う。個人のファイルの無効な項目と値は無視して `dg validate` が警告する。`config show --fields` は空にすると既定に戻るか（`clears_to_default`）も返し、`config set` と設定画面はこれで空の扱いを決める（細部は `dg config show --help`、理由は [ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）

- `actor.human_only`：agent が呼ぶと `TRANSITION_REJECTED` で拒否するコマンド名の一覧。既定は空。config を読まない呼び出し（`dg hook` の PreToolUse。AG-10）は検査しない。チケットの遷移を人に限るのは Workflow の `by`（WF-1）
- `models.*`：Plan の段階（PL-1）に対応するモデル名。手順（`dg guide work`）がサブエージェントに渡す

## 6. 機能要件

### 6.1 `dg` CLI

- CL-1 すべてのコマンドに `--json` があり、エージェントはそれを読む。成功は `{ ok: true, data, warnings, write }`、失敗は `{ ok: false, error: { code, message, detail } }`。終了コードは 0（成功）/ 1（失敗。`validate`・`lint` は指摘があるとき）/ 2（使い方の誤り）。`error.code` の語彙は `packages/core/src/errors.ts` が正本
- CL-2 コマンドの一覧とオプションは `dg --help`（各コマンドは `dg <コマンド> --help`）が正本
- CL-3 書き込みを伴うコマンドは `commit.mode` に従ってコミットする。作成・`ticket claim`・`iteration start / reopen` は採番と排他のため即座にコミットして push する
- CL-4 `ticket import` は下書きの配列を 1 コミットで取り込み、取り込めない下書きがあれば起票せずに拒む（形と条件は `guide import`）
- CL-5 `dg guide <topic>` は、エージェント向けの各手のやり方を `config.yaml` の値を埋めて出す。段階・次の 1 手・修正ループの回数・品質ゲートの判定・brief は guide に書かず Core（`dg next`・`dg gate`・`dg brief`）が返す（予定 e15。EX-3）。トピックの一覧は `dg guide overview`（省略時）。やり方の正本は CLI に同梱した Markdown（`packages/cli/src/guide-*.md`）
- CL-6 CLI はロジックを持たず、Core のコマンド定義（`packages/core/src/commands/`）を写す
- CL-7 `history` は deguboard ブランチの git の履歴から、チケット・Epic・Iteration の起票と属性（Status・所属・担当者・PR）の変化を古い順に返す。データの形は変えず、差分から読む。浅い clone では欠けたことを返して失敗しない（返す項目は `packages/core/src/commands/history.ts`）

### 6.2 状態遷移と照合

- ST-1 `status` はチケットに保存する。変えるのは `ticket move`・`claim`・`unclaim`、UI の操作、照合だけ
- ST-2 遷移は Workflow の `transitions` の制約で検査する。`by` に含まれない主体の遷移と `requires` を満たさない遷移は拒否し、制約のない遷移は誰でも行える。同じ Status への move は拒否する
- ST-3 `claim` は todo のチケットの `assignee` を claim した主体にし、`branch` を記録して in_progress に進め、agent なら実装の Run を開く（RN-5）。todo 以外と使えないブランチ名（`BRANCH_IN_USE`）は拒否し、別のユーザの `assignee` は上書きして警告する。自分（同じユーザの人と AI）が claim 済みで `pr` のある in_progress・review のチケットのもう一度の claim は手直しの開始とみなし、チケットを変えずに Run だけ開く（RN-5）。ブランチの要らない作業とブランチ名の条件は `ticket claim --help`
- ST-4 照合は `dg sync` と、画面の同期（UI-6）で行う。`branch` のあるチケットについて Git から事実を集め、`reconcile` 規則を上から評価し、今より前進の順が先のときだけ書き換える。`branch` のないチケットと `done`・`abandoned` のチケットには触れない
- ST-5 後退を指す事実（消えたブランチ・マージされずに閉じた PR）は書き換えず警告する。取れなかった事実は不明とし、前進の判定では偽と読む。結果（`reconciled`）には根拠の条件（`when`）を含める。細部は `packages/core/src/git/facts.ts`・`workflow/reconcile.ts`、理由は [ADR-028](adr/ADR-028-agents-and-state.md)
- ST-6 PR の事実は `gh` が使えるときだけ取る（なくても照合は Git の事実で成り立つ）。ブランチ名で見つけた PR の番号を `pr` に記録し（記録済みは書き換えない）、実装の Run を閉じる（RN-6）。`branch_at` より前にマージされた PR は前の作業のものとして使わず警告する（細部は `packages/core/src/git/facts.ts`）
- ST-7 `unclaim` は in_progress のチケットの、自分（同じユーザの人と AI）の claim か記録のない claim だけを外して todo に戻し、`assignee`・`branch`・`branch_at`・`pr` を消す（前の作業の PR を次の claim に残さない。実装・手直しの Run は RN-6）。ほかの claim は強制の指定で外す。生存監視はしない
- ST-8 `abandoned` にすると claim を外し、Iteration の完了件数と Epic の進捗には数えない。todo に戻すときも claim と `pr` を外す（`abandoned` は `pr` を残す）。これらを人だけに限るなら Workflow の `by: [human]` で書く

### 6.3 Git 同期と排他

- SY-1 `dg init` は deguboard ブランチを作るか取り込み、専用 worktree を用意し、`default` プロジェクトとテンプレートのワークフローを置く
- SY-2 書き込みの単位は「取り込み → 変更 → 検証 → コミット →（`push.mode: auto` か即時の操作なら）push」。push が拒否されたら取り込み直して再送する。送れなければコミットを残し、次の同期で再送する
- SY-3 claim・作成・`iteration start / reopen` は push の成功をもって取得とする。拒否されたらローカルのコミットを捨てて取り込み直し、判定し直す
- SY-4 同期は rebase で取り込み、チケットと Epic の frontmatter はマージドライバがフィールド単位で 3-way マージする（規則は `packages/core/src/git/merge.ts`）。解けない競合は rebase を中止してコミットを残し、`dg sync` が報告する。その間は push・照合・作成・claim・`iteration start / reopen` が止まり、人が解消してから `dg sync` を回す（戻し方は `dg guide overview`）
- SY-5 同一マシンの書き込みは `deguboard-local/locks/` のロックで直列にし、同じチケットと step の Run の二重起動も防ぐ。チーム間の排他には使わない
- SY-6 リモートがなくても、同期を除くすべての操作が動く
- SY-7 データのリポジトリの dg の外の変更（dg のコマンドを通さない未コミットの変更、dg の印のないコミット、dg のコミットを捨てた・書き換えた履歴）を、dg がコマンドを実行するたびに見つける。書くコマンドは `OUTSIDE_CHANGES` で止め（データに書く前に、書き込みのロックの中でも確かめる。止めないフックもそのときは書かない）、読むだけのコマンドは警告し、どちらもどのファイル（とコミット）かと戻し方・取り込み方を示す。dg が作るコミットは印を持ち、dg 自身のまとめ待ちの変更と、同じマシンで並べて動く dg の書きかけは外の変更とみなさない。リモートから取り込んだコミットは見ない。`dg adopt` が `dg validate` と同じ検査を通してから今の状態を取り込み、捨てるのは人が deguboard worktree で行う。この版で初めて確かめるときは今の状態を基準にする。この版より前の dg が同じマシンで書いた変更（印のないコミット・基準にないまとめ待ちの変更）は外の変更に見えるので、版を揃えてから取り込む（[ADR-026](adr/ADR-026-guard-pr-and-data.md)。戻し方は `dg guide overview`）

### 6.4 画面（VS Code 拡張）

画面は VS Code 拡張だけで、拡張は React の画面を Webview に載せる（入口と Webview の作りは [ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）。`dg serve` は同じ画面を配信する開発用で、利用者は使わない。

- UI-1 プロジェクトの切り替え
- UI-2 カンバン：planned か active の Iteration 1 つ（既定は active）か「すべて」（planned・active の全部）のチケットを Status ごとの列に出し、Epic と担当者で絞れる
- UI-3 バックログ：done・abandoned 以外のチケットを Iteration ごとの区画に出し、検索と絞り込みができる
- UI-4 チケット詳細：本文・属性・依存・作業ブランチと worktree・PR・Run・経過（CL-7）を出す。属性と本文を編集でき、受け入れ条件の印を本文のチェックボックスで付け外しできる。細部は `dg ticket show --help`
- UI-5 Iteration：詳細の画面で期間・目標・進捗（EP-3）と中のチケット、状態に応じた次の操作（IT-2 の `next`）、中のチケットを含む Plan を出す。閉じた Iteration・Epic と終わったチケットは履歴の画面で見る
- UI-6 未 push のコミットと未取り込みのリモートの更新を印で知らせ、同期のボタンで `dg sync` と同じ同期をして読み直す
- UI-7 画面から書き込むのはチケット詳細と設定画面と同期だけで、ほかの変更は UI-15 で頼む。書き込みは Core の同じコマンドと検査を通り、拒否されたら理由を出して戻す（コミットは CL-3）
- UI-8 `dg serve` は既定で `127.0.0.1` にバインドする。認証は持たない
- UI-10 Epic：open の Epic の進捗（EP-3）を出し、Epic で絞れる。詳細の画面で中のチケットを出す
- UI-11 VS Code 拡張は `core` を同梱して `dg` なしで動き、`dg` が PATH にないときと版のメジャーが `core` と違うときは知らせる。拡張と画面の文言（設定の項目の説明と、既定のままの優先度の判断基準を含む）は VS Code の表示言語が日本語なら日本語、ほかは英語で出し、チケットの中身と指示は書いた言葉のまま出す。既定と同じ判断基準は英語の表示で訳を出し、訳の文を欄に打って離れたら既定の値（日本語）で保存する。core が返すエラー・警告の決まった文（設定の保存の拒否・Plan と Run の警告など）も表示言語で出し、訳のない文は core の文のまま出す。何を訳すかの細部は `packages/vscode/src/l10n.ts`・`packages/web/src/l10n.ts` とそのテスト
- UI-12 VS Code 拡張はサイドバーを主画面にし、エディタのパネルには詳細（チケット・Epic・Iteration・Plan）だけを出す。コード中の ID から要約と詳細を開け、コマンドで ID か題からも探せる。CLI やエージェントの書き込みを自動で映し、承認待ちの Plan と review のチケットを知らせ（通知は `notify.approvals` で切る）、`dg init` 前は始め方を出す。細部は `packages/vscode/package.json`・`src/extension.ts`
- UI-13 実行計画：カンバンの上に、選んだ範囲のチケットを含む Plan の進捗と次（PL-6）・依存グラフを出し、Plan の番号から Plan 詳細を開く。表示だけで書き込まない（出す項目は `plan show` と `packages/web/src/pages/plans.tsx`）
- UI-14 設定画面：「チーム」のタブは `config.yaml` の全項目（5.10）を、「自分」のタブは個人で上書きできる項目だけを出して付け外しし（外すのは `config unset --local`）、影響の大きい項目は保存前に確かめる。VS Code の settings.json は使わない（細部と理由は [ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）
- UI-15 エージェントに頼む：行・見出しなどから `dg ask` の依頼文を作ってコピーし、データには書き込まない。小窓は選んだ頼むことが何をするかの 1 文を札の下に出す（依頼文には入れない）。複数の行をまとめても、キーボードでも頼める。VS Code では開いているターミナルにも送れる。入口・送り方・キーの細部は [ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)
- UI-16 VS Code 拡張は、制限モードと仮想ワークスペースでは動かない（理由は `packages/vscode/package.json` の `capabilities`）

画面の並び・文言・印などの細部は `packages/web/src/`・`packages/vscode/src/` のコードとテストが正本。

### 6.5 エージェント連携

- AG-1 エージェントは `dg` を Bash から `--json` で呼び、データを直接編集しない。主体はフック（AG-9）が agent にし、フックがなければ `--actor agent` か `DEGUBOARD_ACTOR` で申告する（既定は human）。guide の手順は agent を名乗る（`skill.test.ts`。ID は TK-7 と `dg --help`、理由は [ADR-028](adr/ADR-028-agents-and-state.md)）
- AG-2 `dg skill install` は、段階ごとに `dg guide <topic>` を読む薄い Claude Code の Skill（`dg<トピック>`）を配る。Skill は任意で、スクリプトもツールの許可も持たない。名前・説明は guide の frontmatter、冒頭の 1 文は `SKILL_SUMMARY`（`packages/core/src/commands/ask.ts`）が正本（`packages/cli/src/skill.ts` とそのテスト）
- AG-3 チケット化（`ticket import`）と、分解・Epic への束ね・依存・Iteration への割り当ては、エージェントが提案して人の承認を得てから行う（手順は `dg guide import`）
- AG-4 MCP サーバー（`dg mcp`。stdio）は Bash のないクライアントの入口で、ツールを Core のコマンド定義から生成する。CLI と同じ操作ができ（`init` と CLI だけの `guide`・`skill`・`serve`・`open` を除く）、結果は `--json` と同じ形（CL-1）で、主体は常に agent。細部は `packages/cli/src/mcp.ts` とそのテスト
- AG-5 AI 製品ごとの差（使用量の取得・dg を呼んだエージェントの判定・フックの入力と設定）は Agent Adapter が吸収し、実装は Core の `agents/adapters/` に閉じる（対応する製品はそこのコード）。エージェントの起動と権限は扱わない（EX-1、[ADR-007](adr/ADR-007-architecture.md)）
- AG-6 ソフトウェア開発向けの Action（worktree・PR 作成・マージなど）は Core の `actions` に置き、汎用部分は依存しない。`dg` のコマンドにせず、公開するのは名前の一覧（`ACTION_NAMES`）だけ（[ADR-007](adr/ADR-007-architecture.md)）
- AG-7 任意のシェルの Action は `actions.shell: true` のときだけ使え、毎回確認を経る
- AG-8 `ask` は対象（複数可）・頼むこと・指示・形式から、エージェントに貼る依頼文を返す読み取りだけのコマンドで、人に限られた操作なら人が打つ `dg` のコマンドを返す。`ask-menu` は画面の場所ごとの候補を返す。候補・おすすめ・文の形は `dg ask --help` と `packages/core/src/commands/ask.ts`・そのテストが正本
- AG-9 `dg hooks install` は harness（今は Claude Code）の設定に `dg hook` を呼ぶフックを重ねずに書き、`uninstall` は dg のフックだけを外し（手で足したフックは残す）、`check` が確かめる。フックは主体を agent にする（Run の開け閉めは RN-7）。細部は `dg hook --help` とそのテスト、理由は [ADR-025](adr/ADR-025-runs-by-hooks.md)
- AG-10 フック（AG-9）は、データの直接の書き換えと dg を経由しない PR の ready・マージを、字句を読まずに語の有無で粗く拒み、dg の読み書きのコマンドと `dg pr ready`・`dg pr merge`（EX-3）へ案内する。応答の終わりに dg の外の変更（SY-7）があれば、止まらずに続けさせて伝える。細部は `dg hook --help` とそのテスト、理由は [ADR-026](adr/ADR-026-guard-pr-and-data.md)

### 6.6 作業の実績

- MT-1 Run の使用量とツールの回数は Adapter が取り込む。エージェントの自己申告の数字は書かない
- MT-2 `metrics.read_transcripts` が true なら、Run を閉じる操作が Adapter で会話記録から使用量とツールの回数を補う。Run の記録のパスかセッションの記録がこのマシンになければ、推測に落とさず null で残して警告する。`DEGUBOARD_NO_TRANSCRIPTS` が空でも `0` でもないマシンでは読まない（探し方は `packages/core/src/agents/agents.test.ts`）
- MT-3 `metrics show` は Run を絞り込んで集計する（軸は `dg metrics show --help`）。null は足さず欠けた数を出す。集計値は保存しない
- MT-4 Adapter が会話記録から Run に写すのは数とモデル名だけで、会話の中身・コマンドの文字列・ファイルのパスは写さない（Git に入るのは RN-1 のセッション ID まで）。`error` と `retry_reasons` は渡した文をそのまま記録するので、`error` には秘密を、`retry_reasons` には秘密・コマンドの文字列・パスを書かない
- MT-5 `run refresh` は閉じた Run のモデル名と使用量を、finish と同じ方法と MT-2 の許可で会話記録から取り直し、取れた値だけを書き換えて、取れなかった値は残して警告する。実行中の Run は拒み、RN-3 の期間を過ぎた Run は読まずに今の値を残して警告する（細部は `dg run refresh --help`）

### 6.7 ワークフロー実行

- EX-1 deguboard はエージェントを起動しない。エージェントが `dg` を呼んで進める
- EX-2 終了していない Run は一覧で見え、`interrupted` として閉じられる
- EX-3 チケットを段階（claimed → implemented → reviewed(n) → fixed(n) → ready → merged）に続けて進める既定の手続きは Core が持つ（段階と次の 1 手は `dg next`、修正ループの回数と品質ゲートは `dg gate`、サブエージェントに渡す文（brief）は `dg brief`。細部は各 `--help`）。段階は Run（実装・見直し・手直しとその結果、止まって待っている印）・PR・作業ブランチの事実・Plan の待ちから都度求めて保存せず、`ticket show` の `stage` と `dg next <ticket>` が同じ求め方で返す。`dg next` は次の 1 手（implement・review・fix・ready・wait_merge・wait_deps・wait_human・done）と、開く step・呼ぶコマンド・人に聞くことを、implement・review・fix の手ではサブエージェントに渡す文（brief）と合わせてデータで返す読み取りだけのコマンドで、修正ループの上限を超えたチケット、一番新しい手直しが failure か interrupted で閉じたチケット、止まって待っている Run のあるチケットは wait_human になる（段階の名前と手の種類の正本は `dg next --help`）。着手できるチケットは PL-6 か `ticket list --ready` に従う。エージェントが PR を ready にする・マージする正しい道は `dg pr ready <ticket>`・`dg pr merge <ticket>` で、`dg gate` を満たすときだけ gh を呼び、満たさなければ gh を呼ばずに満たさない条件と理由を `GATE_FAILED` で返す。満たさないまま進める例外（見直し役を起動できない・上限を超える・版上げの PR・人が回数を指示した）は人が gh を打つ（AG-10、[ADR-026](adr/ADR-026-guard-pr-and-data.md)。細部は `dg pr --help`）。`--auto` は戻せる判断を自動で選ぶ（Plan の承認を含む。`approved_by` は agent）。マージは、`dg guide all --auto` で `auto.merge` が true のとき、品質ゲートを通った PR だけ自動でマージする。そのほかのマージは人を待つ（リリースの PR は `auto.merge` があっても常に人が承認する）。やめる（abandoned・done の取り消し）は常に人が決めるので、Core は人を待つ手を返す。各手のやり方は guide（`dg guide all`・`work`・`review` など）が書く。`dg gate` が判定する品質ゲートの条件は `dg gate --help` が正本。e15 が実装されるまでは、各手のやり方と `dg gate` が判定しない条件（検査など）は guide（`all`・`parallel`・`review`）が正本（[ADR-011](adr/ADR-011-procedure-in-code.md)）
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

次のものは範囲に含めない。必要になったら判断を ADR で決めてから本書に足す。

- deguboard がエージェントを起動・監視すること、ツール側のスケジューラ（[ADR-028](adr/ADR-028-agents-and-state.md)・[ADR-011](adr/ADR-011-procedure-in-code.md)）
- Milestone（Iteration で表す。[ADR-009](adr/ADR-009-epic-and-iteration.md)）
- Epic の入れ子と、チケットの親子関係（サブタスク）。束ねるのは Epic の 1 段だけ（[ADR-009](adr/ADR-009-epic-and-iteration.md)）
- 推定費用の記録（[ADR-029](adr/ADR-029-work-metrics.md)）
- Workflow の条件に利用者のスクリプトを使うこと
- 複数 PC 間の排他（claim の push で足りる）
- Webhook によるリアルタイム同期、外部への通知
- 権限管理などのチーム運用の機能
- Windows
