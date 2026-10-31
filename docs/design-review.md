# Aru 仕様の検討

対象：貼り付けられた「Aru — Git-native AI Workflow & Task Management」の仕様。
目的：実装に入る前に、曖昧な点・設計上の重要な判断・アーキテクチャ案・Phase 1 の計画を示し、合意を取る。

比較材料として、先行プロジェクト KanbanForge の ADR に残る「やってみて廃止した判断」だけを参照する。コードや運用規約は引き継がない。

---

## 0. 結論

方向性は妥当で、Phase 1 はこの仕様のまま着手できる。ただし、仕様の前提に **先行プロジェクトで一度作って廃止した設計が 3 つ含まれている**。ここを決めてから進めたい。

| # | 仕様の前提 | 先行の経験 | 提案 |
|---|---|---|---|
| A | `.aru/` を作業ツリー直下に置く（5.3） | 作業 worktree ごとにチケットのコピーができて乖離する。保護ブランチに状態変更を直接 push できない。そのため専用の orphan ブランチに置いた（ADR-001） | チケットの置き場を **作業ブランチから分離**する。方式は §3.2 |
| B | 拡張/ツール側が Agent Runner でエージェントを起動・監視する（3.5, Phase 3） | ヘッドレス起動も統合ターミナル起動も安定せず、実行パイプライン・runs/・ローカルロックごと削除した（ADR-053）。実務は「人が動かすエージェントが CLI でチケットを操作する」形に落ち着いた | Phase 3 の Runner は **受動型（エージェント自身が `aru run start/finish` を呼ぶ）から始める**。能動的スケジューラは Phase 4 に送る。§3.3 |
| C | Status と Stage を独立した 2 軸にし、遷移・条件・アクションを YAML で宣言（3.2） | ステータスのカスタマイズは「category（todo/active/review/done）＋上から評価する事実ベースの規則」まで設計したが、利用者スクリプトの実行は全員のマシンで走るため採らなかった（ADR-058, 要件 8 章） | MVP は **Status 1 軸＋category**。Stage は Phase 3 で Run の `step` として導入。遷移条件は組み込みの事実とその否定だけ。§3.1 |

---

## 1. 先行プロジェクトから引き継ぐ教訓

| 教訓 | 出典 | Aru への反映 |
|---|---|---|
| チケットのデータはコードブランチと分離する。全チケット 1 ファイル方式は競合が集中する | ADR-001 | 1 チケット 1 ファイル。置き場は作業ブランチの外 |
| 連番 ID は並行起票で衝突する。ハッシュ短縮 ID を正とし、人間向けの連番は別に持つ | ADR-002/011 | `id: t-7q3k`（正）＋ `number: 12`（表示用、同期時に採番）。`TICKET-0001` 形式はやめる |
| エージェントはファイルを直接編集せず CLI（`--json`）経由。採番・検証・排他が抜け落ちない | ADR-053 | 同じ。MCP は CLI と同じ Core 関数を呼ぶ薄い層にする |
| MCP より CLI を優先。MCP はスキーマが常に文脈を使う | ADR-053 | Aru は MCP を要件に含めるので作るが、**コマンド定義を 1 か所に置き、CLI と MCP の両方をそこから生成**する |
| 排他は「claim を push できたか」で決める（Git を CAS として使う）。ローカルロックは持たない | ADR-058 | チーム間の排他は claim の push。ローカルロックは **同一マシンでの Run の二重起動防止だけ**に限定し、Git 管理外に置く |
| 状態遷移は「事実から導いた状態に前進させるだけ」。後退は警告にとどめる | ADR-058 | 照合（reconcile）を Core に持ち、ワークフロー定義の `rules` で表現 |
| 手順の正本は CLI に同梱し（`kf guide`）、Skill はそれを読む薄いファイルにする | ADR-056 | `aru guide <topic>` を用意し、Claude Code / Codex 向け Skill は数行にする。エージェント非依存の要件 3.4 と整合 |
| 作業実績は AI の自己申告でなく会話記録・PR から実測し、取れないものは `null` にする。費用の単価は持たない | ADR-057 | 要件 3.6 と一致。Aru は「推定費用」を要件に含めるので、単価表を設定に置き `estimated: true` を明示 |
| 会話記録は個人データ。読む許可はリポジトリの外に置く | ADR-057 | `~/.config/aru/consent.json` 相当 |
| 計画（実行計画）を立てて承認してから作業に入る。計画は第一級のエンティティ | ADR-054 | Aru のデータモデルに **Plan が無い**。Run と Iteration の間に Plan（または Iteration に内包）が要る。§3.3 |
| 計画（Plan）のファイルには進捗を書かず、チケットの状態から都度求める。書くのは作成・承認・終了の時だけ | ADR-054 | Plan と Run の進捗は派生値にして、push の衝突を減らす |
| 同一マシンのプロセス間の排他は未実装のまま残った課題 | ADR-058（t235） | Aru の「ローカル実行ロック」がちょうどこの穴を埋める。Git 管理外の lock ファイルで持つ |
| claim は並列に行わない。1 チケットは 1 計画にしか入らない | ADR-054 | Core の不変条件として検査する |
| 会話記録からの集計は、サブエージェントの usage 欠落と並列時の親セッションの二重計上という限界がある | 要件 6.12.16 | Adapter が自分で起動する場合は `claude -p --output-format stream-json` の usage を一次情報にし、会話記録は受動型 Run の補完に使う |
| 自動マージの前は「実装したのとは別のサブエージェント」がレビューする | ADR-055 | Phase 4 の自動レビューの前提にする |
| 起票は下書き（YAML/JSON、ファイル内の仮キーで depends_on を参照）を 1 コミットで取り込む | ADR-040 | `aru task import` を Phase 1 の CLI に含める（Phase 2 の会話からの起票の土台） |
| UI は planning を書き換えず、CLI か指示文を写す入口に徹した | ADR-060 | Aru は D&D でのステータス変更を要件にしている（3.7）。**意図的に違う判断**として、UI の書き込みも Core の遷移検証を通す |

---

## 2. 仕様の曖昧点・矛盾

1. **Task と Ticket の呼び分け**：4 章は Task、CLI とディレクトリは ticket。どちらかに統一する（提案：ファイル・CLI も `task`）。
2. **Project の単位**：1 リポジトリ = 1 プロジェクトか、1 リポジトリに複数か。MVP は 1:1 とし、Project はファイルではなく `config.yaml` の属性にする。
3. **Milestone**：MVP から外す（Iteration で代替できる）。
4. **コミットのタイミング**（3.8）：「設定可能」だけでは実装できない。`commit.mode: each | batch | manual` を提案。`each` は 1 操作 1 コミット（CLI・エージェント向け）、`batch` は UI 操作を一定時間まとめる、`manual` は `aru commit`。push は `push.mode: auto | manual`。
5. **Web UI と VS Code 拡張の両方を Phase 1 に含めるか**：Phase 1 は Web UI だけにし、VS Code 拡張は同じ React アプリを Webview で載せる薄いものとして Phase 4 に置く（仕様の Phase 4 と一致）。
6. **「任意のコマンドを無条件に実行しない」（6 章）と Workflow Action（3.5）の両立**：Action は Core に登録済みのもの（`run_tests`, `create_pr` など）だけを名前で指定でき、任意シェルは `shell` アクションを設定で明示的に許可した場合だけ、さらに実行前に確認する。
7. **Agent Adapter が吸収すべき差異**：起動方法（`claude -p` / `codex exec`）、使用量の取得（stream-json の `usage` / 会話記録 / Codex のログ）、権限設定、作業ディレクトリ。これを Adapter インターフェースとして先に型だけ決める。
8. **同時編集の競合検出**（6 章）：Git の行単位マージでは frontmatter の隣接行でも競合する。frontmatter はフィールド単位、本文は全体で 3-way マージするマージドライバが要る（Phase 1 では「競合を検出して報告」まで、ドライバは Phase 2）。
9. **Run 実行中の UI 表示**：Run の詳細ログは Git 管理外なので、Web UI がローカルの `.aru/local/runs/` を読む経路が要る。`aru serve` が担う。

---

## 3. 優先して決める 3 点への回答

### 3.1 Task と Workflow のデータモデル

**方針**：汎用性は「ステータスの集合と category」で確保し、Stage と条件分岐の表現力は MVP では持たない。

```yaml
# .aru/workflows/software-development.yaml
id: software-development
name: Software Development
statuses:                      # 並びがカンバンの列の順と「前進」の基準
  - { id: todo,        label: TODO,        category: todo }
  - { id: in_progress, label: In Progress, category: active }
  - { id: review,      label: Review,      category: review }
  - { id: done,        label: Done,        category: done }
transitions:                   # 表にない遷移は拒否する
  - { from: todo,        to: in_progress, by: [human, agent], requires: [deps_done] }
  - { from: in_progress, to: review,      by: [human, agent, reconcile] }
  - { from: review,      to: in_progress, by: [human] }            # 差し戻し
  - { from: review,      to: done,        by: [human, reconcile], requires: [pr_merged] }
reconcile:                     # 事実から導く（前進のみ）。条件は組み込みの事実とその否定だけ
  - { when: [pr_merged],              status: done }
  - { when: [pr_open, "!pr_draft"],   status: review }
  - { when: [branch_exists],          status: in_progress }
fields:                        # チケットに追加する任意フィールド（UI の表示項目が追従）
  - { id: estimate, type: number, label: 見積 }
```

- **category** を持つことで、UI と CLI はステータス名でなく category で動く（「active の列」「done になった件数」）。これが汎用性の要。
- **Stage** は MVP では入れない。Phase 3 で Workflow に `steps:`（planning / implementation / review …）を足し、Run が `step` を持つ形にする。Status（チケットの進捗）と Step（Run が何をしたか）を分ければ、2 軸の遷移表が積にならない。
- **Task**（Markdown + YAML frontmatter）：

```markdown
---
id: t-7q3k
number: 12
title: ログイン画面のバリデーション
status: in_progress
priority: medium           # low | medium | high
labels: [frontend]
iteration: s-3a1f
depends_on: [t-0bae]
workflow: software-development
claimed_by: eiki@laptop    # 排他の記録
branch: feature/t-7q3k-login-validation
pr: 42
runs: [r-9c2d]
created_at: 2026-10-31T04:00:00Z
updated_at: 2026-10-31T05:10:00Z
---
## 概要
…
## 受け入れ条件
- [ ] …
```

保存形式の比較（3.1 で求められているもの）：

| | Markdown + frontmatter | YAML 単独 | JSON 単独 |
|---|---|---|---|
| 人間が読み書き | ◎ | ○ | △ |
| 長文（要件・受け入れ条件） | ◎ | △（ブロックスカラー） | × |
| 検証（Zod） | ○ frontmatter 部分 | ○ | ◎ |
| Git diff・マージ | ○（本文は行単位） | ○ | △（末尾カンマ等） |

→ Task は Markdown + frontmatter、Iteration・Workflow・config は YAML、Run は JSON（機械が書くだけ）とする。

### 3.2 Git Worktree とチケット管理ファイルの関係

問題：`.aru/` を main の作業ツリーに置くと、`git worktree add` した各ブランチに `.aru/` のスナップショットが入り、worktree 内のエージェントが更新すると feature ブランチにチケットの変更が混ざる。PR にノイズが入り、main と乖離する。

| 案 | 利点 | 欠点 |
|---|---|---|
| **(A) 専用 orphan ブランチ `aru` を `<git-common-dir>/aru/` に worktree として checkout し、全 worktree から同じ場所を読み書きする**（先行で実証済み） | 保護ブランチと衝突しない。どの worktree からも `git rev-parse --git-common-dir` で同じ場所。コードの PR にチケット差分が混ざらない | GitHub でコードと並べて見えない。ブランチの概念が 1 つ増える。`aru init` に初期化が要る |
| (B) main の `.aru/` に置き、作業 worktree では sparse-checkout で除外し、書き込みは main の checkout に向ける | リポジトリを開けばチケットが見える | main が保護ブランチだと状態変更を直接 push できない。main の checkout が無い環境（worktree だけ clone）で壊れる |
| (C) main の `.aru/` に置き、各 worktree が自分の `.aru/` を書く | 実装が一番単純 | 乖離・競合が常態化する。採らない |

**提案：(A)**。Local-first・Git-native の要件を満たしつつ、問題 2 の答えは「チケット状態の更新は常に共有の aru worktree で行い、作業 worktree は触らない」になる。ブランチ名・配置は `config.yaml` で変えられるようにして、小規模な個人利用で (B) を選べる余地は残す。

排他：
- **チーム間**：`claim`（status・claimed_by・branch のコミット）の push が成功したら取得。拒否されたら取り込み直して判定し直す。
- **同一マシン**：Run の二重起動を `.aru-local/locks/<task-id>` で防ぐ（Git 管理外）。これが仕様 3.8 の「ローカル実行ロック」。
- 複数 PC 間はチーム間の claim で十分なので、将来拡張の対象から外せる。

### 3.3 Workflow Engine と AI Skills の責務分担

仕様末尾の方針（状態遷移・実行記録・承認・排他はプログラム、要件整理・分解・実装方針・レビュー判断は AI）に賛成。具体化すると：

| プログラム（Core）が保証する | AI（Skill / Agent）に委ねる |
|---|---|
| ID 採番、スキーマ検証、原子的書き込み | 要件の整理、チケットへの分解、依存関係の提案 |
| 遷移表にない状態変更の拒否、`requires` の検査 | 実装方針、コードの変更、テストの追加 |
| claim の排他、Run の記録（開始・終了・usage・結果） | レビューの判断（ただし「レビュー済み」という事実の記録は Core） |
| 承認待ちの記録と、承認なしに次へ進めないこと | 承認を求める文面、選択肢の提示 |
| 照合（ブランチ・PR の事実 → 状態の前進） | PR の作成文、修正ループの中身 |
| 登録済み Action の実行と結果の記録 | Action を呼ぶ順番の判断（Workflow の step は推奨順であって強制ではない） |
| 手順書（`aru guide <topic>`）の提供 | 手順書の解釈と実行 |

ここから導かれる **Workflow YAML の性格**：手続き（if-then の実行フロー）を書くものではなく、「状態の集合・許される遷移・各 step で誰が何を承認するか・使える Action」を書く**制約と語彙の定義**にする。手続きは `aru guide` のテキストとして持ち、AI が読む。これにより、エンジンを厳格にしすぎて対話が硬直する問題と、全部 AI 任せで再現性が落ちる問題の両方を避ける。

**Agent Runner の段階化**（結論 B）：
- Phase 3 前半（受動型）：エージェントが自分で `aru run start t-7q3k --step implementation` / `aru run finish r-9c2d --result success` を呼ぶ。Core は Run を記録し、Adapter が使用量を取り込む。人が Claude Code を動かしている普通の対話がそのまま Run として残る。
- Phase 3 後半：`aru run t-7q3k` が Adapter 経由でエージェントをヘッドレス起動し、同じ `run start/finish` を内部で呼ぶ。失敗・停止からの復旧は「Run の状態を `interrupted` にして再開可能にする」だけに留める。
- Phase 4：依存に従う並列実行・修正ループ。

**Plan エンティティの追加**：「どのチケットをどの順で（直列/並列/グラフ）進めるか」と承認状態を持つ。Iteration はスコープ、Plan は実行順、Run は実績、と分ける。Phase 2 のスプリント計画支援で必要になる。

---

## 4. アーキテクチャ案

仕様の 10 パッケージ案は論理分割として正しいが、MVP では 4 つに畳む。

```
packages/
├── core/      # ドメイン・Zod スキーマ・ストレージ・Git 操作・Workflow 検証と遷移・照合・Run 記録
│   └── src/
│       ├── model/      task, iteration, plan, workflow, run, config
│       ├── storage/    frontmatter / yaml / json の読み書き、原子的書き込み、インデックス
│       ├── git/        aru worktree の用意、commit/push、claim、競合検出
│       ├── workflow/   定義の検証、遷移の検査、reconcile
│       ├── actions/    登録済み Action（Phase 3）
│       ├── agents/     Adapter インターフェースと Claude / Codex 実装（Phase 2-3）
│       ├── metrics/    Run の集計（Phase 3）
│       └── commands/   ★ CLI・MCP・HTTP が共有するコマンド定義（名前・引数スキーマ・実装）
├── cli/       # commands/ を commander に写すだけ
├── server/    # commands/ を HTTP に写す＋ web の静的配信。localhost にバインド
└── web/       # React。VS Code Webview でも使えるよう window 依存を薄く
```

- **`core/commands` が要**：CLI・MCP（Phase 2）・HTTP の 3 つの入口が、同じコマンド定義（Zod の入力スキーマ＋実装関数）を使う。MCP のツール定義と CLI のヘルプを同じ定義から生成すれば、「ビジネスロジックを重複実装しない」が構造で保証される。
- `workflow/` `agents/` `metrics/` は core 内のモジュールで始め、肥大化したら切り出す。
- `vscode/` と `mcp/` は Phase 2/4 で追加。どちらも薄い。
- 依存：TypeScript / Node 22 / pnpm workspace / Zod / commander / gray-matter（frontmatter）/ yaml / Hono または Fastify（server）/ Vite + React（web）/ Vitest。SQLite は使わず、起動時にファイルを走査してメモリ上に索引を持つ（数千件まで問題ない）。

---

## 5. ディレクトリ構成（保存）

```
# aru ブランチ（orphan）。<git-common-dir>/aru/ に worktree として checkout
aru/
├── config.yaml              # project 名、既定の workflow、git.base_branch、worktree.root、commit/push mode、cost 単価
├── tasks/
│   └── t-7q3k.md
├── iterations/
│   └── s-3a1f.yaml          # name, goal, start/end, status, tasks の順序
├── plans/                   # Phase 2
│   └── p-4k2a.yaml
├── workflows/
│   ├── software-development.yaml
│   ├── consulting.yaml
│   └── general.yaml
└── runs/                    # Phase 3。完了時の集計だけ（JSON、1 Run 1 ファイル）
    └── r-9c2d.json

# Git 管理外（作業リポジトリの .git の中、または XDG）
<git-common-dir>/aru-local/
├── locks/t-7q3k
├── runs/r-9c2d/            # 実行中の詳細ログ
└── index.json              # キャッシュ
~/.config/aru/consent.json  # 会話記録を読む許可
```

テンプレート（software-development / consulting / general）は `core` に同梱し、`aru init --template consulting` で `workflows/` にコピーする。

---

## 6. CLI（Phase 1 の範囲）

```
aru init [--template <name>] [--branch aru]
aru task create --title … [--status] [--priority] [--labels] [--depends-on] [--iteration] [--body-file -]
aru task list [--status] [--category] [--iteration] [--label] [--json]
aru task show <id> [--json]
aru task update <id> [--title] [--priority] [--labels] [--depends-on] [--body-file]
aru task move <id> --status <status>          # 遷移表で検査する
aru task delete <id>
aru task import <file|->                     # 下書き（YAML/JSON）を 1 コミットで取り込む。仮キーで depends_on を参照できる
aru iteration create|list|show|add|remove|start|close
aru workflow list|show|validate
aru sync                                       # fetch/rebase/push。競合は報告
aru validate                                   # 全ファイルのスキーマ・参照・遷移表の検査
aru serve [--port 7777] / aru open
aru guide <topic>
```

仕様の `aru ticket` は `aru task` に、`aru sprint` は `aru iteration` に寄せる（`sprint` はエイリアスで残す）。全コマンドに `--json`。ID は `t-7q3k` と `12`（number）の両方を受け付ける。

---

## 7. Phase 1 実装計画（チケット分解案）

依存の順。各項目が 1 PR 程度。

1. **リポジトリ基盤**：pnpm workspace、tsconfig、Vitest、lint/format、CI。`packages/core` の空実装
2. **スキーマ**：Task / Iteration / Workflow / Config の Zod スキーマと型。ID 生成（短縮ハッシュ）と number 採番の規則
3. **ストレージ**：frontmatter / YAML の読み書き、原子的書き込み（tmp → rename）、起動時走査とメモリ索引
4. **Workflow モジュール**：定義の検証（存在しないステータス・category 欠け・未知の条件）、遷移の検査、3 テンプレート
5. **Git 層**：`aru init`（orphan ブランチと専用 worktree）、commit mode、`sync`、競合の検出と報告。テストは一時ディレクトリの bare リモートで
6. **commands 層**：Task CRUD / move / import / iteration / workflow / validate を Zod 入力つきの関数として定義
7. **CLI**：commands を commander に写す。`--json`。`aru guide` の雛形
8. **server**：commands を HTTP に写す。localhost 固定。web の静的配信。`.aru-local` の読み取り
9. **web**：カンバン（列は workflow の statuses に追従、D&D で `move`）、バックログ、タスク詳細、イテレーション一覧
10. **E2E**：`aru init` → CLI で作成 → Web で移動 → `git log` に反映、までを通すテスト
11. **ドキュメント**：README、`aru guide` の各トピック、ADR 置き場

Phase 1 の完了条件（仕様どおり）：CLI と Web UI の両方からタスクを管理でき、変更が aru ブランチにコミットされる。

---

## 8. 合意したい判断事項

| # | 判断 | 提案 |
|---|---|---|
| D1 | チケットの置き場 | orphan ブランチ `aru` ＋ 専用 worktree（§3.2 案 A） |
| D2 | ID | 短縮ハッシュを正、number は表示用 |
| D3 | Status / Stage | MVP は Status 1 軸＋category。Stage は Phase 3 で Run の step に |
| D4 | Workflow YAML の性格 | 手続きでなく制約と語彙。手順は `aru guide` |
| D5 | Agent Runner | 受動型（エージェントが run start/finish を呼ぶ）から。能動起動は Phase 3 後半以降 |
| D6 | UI の書き込み | 許可する。ただし Core の遷移検査を通し、commit mode は `batch` を既定に |
| D7 | Phase 1 の UI | Web UI のみ。VS Code 拡張は Phase 4 |
| D8 | Plan エンティティ | 追加する（Phase 2） |
| D9 | 呼称 | Task / Iteration に統一（ticket / sprint はエイリアス） |
| D10 | Milestone | MVP から外す |
