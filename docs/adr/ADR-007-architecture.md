# ADR-007 アーキテクチャ

- ステータス：承認
- 更新日：2026-11-01

## 背景

CLI・MCP・HTTP・VS Code 拡張という複数の入口から同じ機能を提供し、Claude Code や Codex などの AI 製品に依存せず、ユーザー定義のワークフローを第一級に扱う。元の構想は 10 パッケージ（core / workflow / agents / actions / metrics / cli / mcp / server / web / vscode）だったが、MVP で最初から分けると抽象化が先行する。どう分け、依存をどう向けるかを決める。

## 決定

### 3 つの層

| 層   | 責務                                                                                                     | パッケージ                                          |
| ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Core | ドメインモデル、スキーマ、ストレージ、Git 操作、ワークフローの検証と遷移、照合、Run の記録、コマンド定義 | `core`                                              |
| 入口 | Core のコマンドを外に出す。ビジネスロジックを持たない                                                    | `cli`、`server`、`vscode`（拡張ホスト）、後に `mcp` |
| UI   | 画面。入口とは `CommandClient` でだけ話す                                                                | `web`（React。VS Code の Webview にも載る）         |

### パッケージと依存の向き

```
packages/
├── core/     ドメイン・storage・git・workflow・run/metrics・commands
├── cli/      dg。commands を commander に写す
├── server/   commands を HTTP に写し、web を配信する
├── web/      React。CommandClient の HTTP 実装
└── vscode/   拡張ホスト。commands を直接呼び、Webview に web を載せる
```

- `core` は何にも依存しない（VS Code API・HTTP・React を知らない）
- `server`・`vscode` は `core` だけに依存する。`cli` は `dg serve` のために `server` にも依存する
- `web` は `core` の型と `CommandClient` のインターフェースだけに依存する
- 逆向きの依存は作らない。`.oxlintrc.json` の `overrides` がパッケージごとに `no-restricted-imports` で検出する（core は `@deguboard/*`・`vscode`・`react`・他パッケージへの相対パスを、server と vscode は `@deguboard/core` 以外を、cli は core と server 以外を、web は core 以外と core の型以外の import を禁止）

### `core/commands` が 3 つの入口の正本

- すべての操作を「名前・Zod の入力スキーマ・実装関数」の組として `core/commands` に定義する
- CLI のサブコマンドとヘルプ、HTTP のエンドポイント、Webview のメッセージ、将来の MCP のツール定義は、この定義から生成する。入口にロジックを書かない
- UI は `CommandClient`（コマンド名と入力を渡して結果を受け取る 1 つのインターフェース）を通じて呼ぶ
- 文脈の管理（開く・再走査・直列化・名前でコマンドを引く）はプロセス内の `CommandClient`（`core/commands/local.ts`）として core に 1 つ置き、`server` は HTTP に、`vscode` は Webview の postMessage に写す

### Core の中の境界

Core の中は責務ごとのモジュールに分け、最初からパッケージには分けない。

- `model`：Project・Ticket・Epic・Iteration・Plan・Workflow・Run・config のスキーマと採番
- `storage`：frontmatter / YAML / JSON の読み書き、原子的書き込み、起動時走査とメモリ上の索引
- `git`：deguboard worktree の用意、commit / push、claim の CAS、照合に使う事実の収集、競合の検出
- `workflow`：定義の検証、遷移の検査、`reconcile` の評価
- `run`・`metrics`：Run の記録と集計
- `agents`：Agent Adapter のインターフェースと Claude Code / Codex の実装。起動方法・使用量の取得・作業ディレクトリの差を吸収する
- `actions`：登録済みの Action（`run_tests`・`create_pr` など）。任意のシェルは設定で明示的に許可したときだけ、実行前に確認する

`run`・`agents`・`actions`・`metrics` は要るようになったときに置く（それまでは Run の型だけ）。モジュールが肥大化したら、そのときにパッケージへ切り出す。

### 索引はメモリ上に持つ

- DB は使わない。起動時にファイルを走査してメモリ上に索引を作り、取り込み（sync）の後とリクエストごとに再走査して更新する。core はファイルを監視しない（VS Code 拡張はデータのファイルの変化を見張って画面を読み直す。UI-12）

## 理由

- 入口が増えても `core/commands` を 1 回書けば済む。CLI と UI と MCP で振る舞いがずれない
- 依存を一方向にすれば、Core を単体でテストでき、VS Code や HTTP の都合が Core に入らない
- 最初から 10 パッケージに分けると、境界をまたぐ型と設定が増え、変更のたびに複数パッケージを触る。モジュールの境界を先に決めておけば、切り出しは後からできる
- Adapter と Action を Core の境界として先に型だけ決めるのは、最初のデータモデル（Run・Workflow の `steps`）がそれに依存するため
- 数千件までのチケットなら、ファイル走査とメモリ索引で十分に速い

## 採らなかった案

- **構想どおり 10 パッケージ**：抽象化が先行し、MVP の変更コストが上がる
- **MCP サーバーを独立パッケージで先に作る**：CLI で同じことができ、スキーマが文脈を消費する。`core/commands` から生成する薄い層として後から足す
- **Workflow エンジンを別パッケージにする**：Core の遷移検査と照合が Workflow に依存し、境界をまたぐ呼び出しが増える。Core の中のモジュールで十分
- **入口ごとにロジックを書く**：CLI と UI で振る舞いがずれる
- **SQLite の索引**：ネイティブ依存と DB ファイルの管理が増える
