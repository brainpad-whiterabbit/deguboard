# ADR-007 アーキテクチャ

- ステータス：承認
- 更新日：2026-11-01

## 背景

CLI・MCP・HTTP・VS Code 拡張という複数の入口から同じ機能を提供し、Claude Code や Codex などの AI 製品に依存せず、ユーザー定義のワークフローを第一級に扱う。元の構想は 10 パッケージ（core / workflow / agents / actions / metrics / cli / mcp / server / web / vscode）だったが、MVP で最初から分けると抽象化が先行する。どう分け、依存をどう向けるかを決める。

## 決定

### 3 つの層

| 層   | 責務                                                                                                     | パッケージ                                                        |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Core | ドメインモデル、スキーマ、ストレージ、Git 操作、ワークフローの検証と遷移、照合、Run の記録、コマンド定義 | `core`                                                            |
| 入口 | Core のコマンドを外に出す。ビジネスロジックを持たない                                                    | `cli`（MCP の `dg mcp` を含む）、`server`、`vscode`（拡張ホスト） |
| UI   | 画面。入口とは `CommandClient` でだけ話す                                                                | `web`（React。VS Code の Webview にも載る）                       |

### パッケージと依存の向き

```
packages/
├── core/     ドメイン・storage・git・workflow・run/metrics・commands・actions
├── cli/      dg。commands を commander と MCP のツール（dg mcp）に写す
├── server/   commands を HTTP に写し、web を配信する
├── web/      React。CommandClient の HTTP 実装
└── vscode/   拡張ホスト。commands を直接呼び、Webview に web を載せる
```

- `core` は何にも依存しない（VS Code API・HTTP・React を知らない）
- `server`・`vscode` は `core` だけに依存する。`cli` は `dg serve` と `dg mcp`（ツールの入力スキーマを `describeCommands` で作る）のために `server` にも依存する
- `web` は `core` の型と `CommandClient` のインターフェースだけに依存する
- 逆向きの依存は作らない。`.oxlintrc.json` の `overrides` がパッケージごとに `no-restricted-imports` で検出する（core は `@deguboard/*`・`vscode`・`react`・他パッケージへの相対パスを、server と vscode は `@deguboard/core` 以外を、cli は core と server 以外を、web は core 以外と core の型以外の import を禁止）

### `core/commands` が 3 つの入口の正本

- すべての操作を「名前・Zod の入力スキーマ・実装関数」の組として `core/commands` に定義する
- CLI のサブコマンドとヘルプ、HTTP のエンドポイント、Webview のメッセージ、MCP のツール定義は、この定義から生成する。入口にロジックを書かない
- MCP（`dg mcp`）は `cli` に置き、`createLocalClient` を主体 agent で開いて stdio に写す。ツールの名前は `ticket.create` の `.` を `_` にしたもの、入力スキーマは Zod から作る JSON Schema（`server` の `describeCommands` と同じ）。CLI だけの `guide`・`serve`・`open` と、初期化前に動く `init` はツールにしない
- UI は `CommandClient`（コマンド名と入力を渡して結果を受け取る 1 つのインターフェース）を通じて呼ぶ
- 文脈の管理（開く・再走査・直列化・名前でコマンドを引く）はプロセス内の `CommandClient`（`core/commands/local.ts`）として core に 1 つ置き、`server` は HTTP に、`vscode` は Webview の postMessage に写す

### Core の中の境界

Core の中は責務ごとのモジュールに分け、最初からパッケージには分けない。

- `model`：Project・Ticket・Epic・Iteration・Plan・Workflow・Run・config のスキーマと採番
- `storage`：frontmatter / YAML / JSON の読み書き、原子的書き込み、起動時走査とメモリ上の索引
- `git`：deguboard worktree の用意、commit / push、claim の CAS、照合に使う事実の収集、競合の検出
- `workflow`：定義の検証、遷移の検査、`reconcile` の評価
- `run`・`metrics`：Run の記録と集計
- `agents`：Agent Adapter のインターフェースと製品ごとの実装（Claude Code。Codex は予定）。使用量の取得と作業ディレクトリの差を吸収する
- `actions`：登録済みの Action（`create_worktree`・`create_branch`・`run_tests`・`create_pr`・`merge_pr`、許したときだけの `shell`）。下の「Action の呼び方」

`agents` に起動方法・権限は置かない（deguboard は起動しない。EX-1）。汎用部分は `agents/index.ts` だけを通し、`agents/adapters/` を import しない（`.oxlintrc.json`）。モジュールが肥大化したら、そのときにパッケージへ切り出す。

### Action の呼び方

- Action は「名前・Zod の入力スキーマ・設定による可否・確認の要否・実行関数」の組で、`core/actions` に置く。呼び出し側は `listActions(config)` で一覧と使えるかを見て、`runAction(ctx, name, input)` で実行する。`runAction` が入力の検証 → 設定の検査 → 確認 → 実行の順を 1 か所で守る
- `actions` は `git`（`run` と `repo` の型）・`model/config`・`errors` を使い、逆向き（commands・storage・workflow・model・git から actions）の import は `.oxlintrc.json` が禁じる。Workflow に `steps` を足すときは、Action を名前（文字列）で持たせ、名前の検証は actions の一覧を外から渡して行う
- `dg` のコマンド・MCP のツール・画面には出さない。エージェントは `dg guide` の手順に従って git・gh・テストを自分で呼ぶ（EX-1）
- git に渡すブランチ名は `git check-ref-format --branch` 相当で検査して先頭の `-` を拒み、位置引数の前に `--` を置く。オプションの注入（`--upload-pack=<コマンド>` など）で `actions.shell` を回り込ませないため
- `run_tests` は `actions.test` に書いた引数配列だけを確認なしで実行する。config.yaml は Git で共有されるので、deguboard ブランチに push できる人はここに任意のコマンドを書ける。その権限をシェルの許可と同等とみなす前提に立つ。`shell` は `actions.shell` が false なら `REJECTED`、true でも呼び出し側の `confirm` が true を返したときだけ `sh -c` で実行し、`confirm` がなければ拒否する
- worktree・ブランチの操作は guide の手順（`git worktree add --no-track -b … <remote>/<base>`）と同じ形にする。claim は `branch` を記録するだけで Git を触らないので、共有する実装はない

### 索引はメモリ上に持つ

- DB は使わない。起動時にファイルを走査してメモリ上に索引を作り、取り込み（sync）の後とリクエストごとに再走査して更新する。core はファイルを監視しない（VS Code 拡張はデータのファイルの変化を見張って画面を読み直す。UI-12）

## 理由

- 入口が増えても `core/commands` を 1 回書けば済む。CLI と UI と MCP で振る舞いがずれない
- 依存を一方向にすれば、Core を単体でテストでき、VS Code や HTTP の都合が Core に入らない
- 最初から 10 パッケージに分けると、境界をまたぐ型と設定が増え、変更のたびに複数パッケージを触る。モジュールの境界を先に決めておけば、切り出しは後からできる
- Adapter と Action を Core の境界として先に型だけ決めるのは、最初のデータモデル（Run・Workflow の `steps`）がそれに依存するため
- Action をライブラリに留めるのは、deguboard がエージェントを起動しない（EX-1）ので、今 Action を実行する主体がいないため。コマンドにすると `core/commands` が actions に依存し（AG-6）、エージェントが Bash で直接打てる git・gh を包む層が増えるだけになる。確認の手段（`confirm`）を呼び出し側に任せれば、CLI の対話・画面のダイアログ・承認の step のどれでも同じ検査を通る
- 数千件までのチケットなら、ファイル走査とメモリ索引で十分に速い

## 採らなかった案

- **構想どおり 10 パッケージ**：抽象化が先行し、MVP の変更コストが上がる
- **MCP サーバーを独立パッケージにする**：コマンド定義から機械的に作る薄い層で、独立させても中身が増えない。`dg` に同梱すれば入れるものが 1 つで済み、CLI と同じ版で動く。ツールのスキーマは文脈を消費するので、CLI（Bash）で足りる利用者は登録しなくてよい
- **Workflow エンジンを別パッケージにする**：Core の遷移検査と照合が Workflow に依存し、境界をまたぐ呼び出しが増える。Core の中のモジュールで十分
- **入口ごとにロジックを書く**：CLI と UI で振る舞いがずれる
- **`dg action list / run` のコマンドにする**：`core/commands` が actions に依存し、エージェントに同じ操作の道が 2 つできる。Action を実行する主体（Run の実行）ができたときに、そこから呼ぶ
- **テスト実行を任意のコマンドの入力で受ける**：入力にコマンドを書けると、`actions.shell` を通らない任意の実行になる。コマンドは config に書いたものに限る
- **SQLite の索引**：ネイティブ依存と DB ファイルの管理が増える
