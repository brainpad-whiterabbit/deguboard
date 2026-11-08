# ADR-007 アーキテクチャ

- ステータス：承認
- 更新日：2026-11-05

## 背景

CLI・MCP・HTTP・VS Code 拡張という複数の入口から同じ機能を提供し、Claude Code や Codex などの AI 製品に依存せず、ユーザー定義のワークフローを第一級に扱う。元の構想は 10 パッケージ（core / workflow / agents / actions / metrics / cli / mcp / server / web / vscode）だったが、MVP で最初から分けると抽象化が先行する。どう分け、依存をどう向けるかを決める。

## 決定

### 3 つの層

| 層   | 責務                                                                                                     | パッケージ                                                        |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Core | ドメインモデル、スキーマ、ストレージ、Git 操作、ワークフローの検証と遷移、照合、Run の記録、コマンド定義 | `core`                                                            |
| 入口 | Core のコマンドを外に出す。ビジネスロジックを持たない                                                    | `cli`（MCP の `dg mcp` を含む）、`server`、`vscode`（拡張ホスト） |
| UI   | 画面。入口とは `CommandClient` でだけ話す                                                                | `web`（React。VS Code の Webview にも載る）                       |

### 依存の向き

- `core` は何にも依存しない（VS Code API・HTTP・React を知らない。HTTP の node モジュールも読まない）
- `server`・`vscode` は `core` だけに依存する。`cli` は `dg serve` と `dg mcp` のために `server` にも依存する
- `web` は `core` の型と `CommandClient` のインターフェースだけに依存する（`import type` だけ。Vite が node のモジュールを束ねないため）。テストの例外は `web/src/test-helpers.ts` と各テストのコメントが正本
- 逆向きの依存は作らない。検出は `.oxlintrc.json` の `no-restricted-imports`（禁じる import の正本）

### `core/commands` が 3 つの入口の正本

- すべての操作を「名前・Zod の入力スキーマ・実装関数」の組として `core/commands` に定義する
- CLI のサブコマンドとヘルプ、HTTP のエンドポイント、Webview のメッセージ、MCP のツール定義は、この定義から生成する。入口にロジックを書かない
- MCP（`dg mcp`）は `cli` に置き、同じコマンド定義を主体 agent で写す（範囲は AG-4）
- 例外は AG-4 の CLI だけの操作で、`core/commands` に置かず `cli` に置く
- UI は `CommandClient`（コマンド名と入力を渡して結果を受け取る 1 つのインターフェース）を通じて呼ぶ
- 文脈の管理はプロセス内の `CommandClient` として core に 1 つ置き、`server` は HTTP に、`vscode` は Webview の postMessage に写す

### Core の中の境界

Core の中は責務ごとのモジュールに分け、最初からパッケージには分けない。各モジュールの役割は [development.md の「パッケージ」](../development.md#パッケージ)。

- Run の集計は独立のモジュールにせず、純粋関数を表示のたびに呼ぶ（ADR-005）
- `agents` は Agent Adapter のインターフェースと製品ごとの実装で、製品ごとの差を吸収する。起動方法・権限は置かない（deguboard は起動しない。EX-1）。汎用部分は `agents/index.ts` だけを通す
- モジュールが肥大化したら、そのときにパッケージへ切り出す

### Action の呼び方

- Action は `core/actions` に置き、検証・設定の検査・確認・実行の順を 1 か所で守る（組の形は `actions/define.ts`）
- Core の汎用部分は actions に依存しない（AG-6。検出は `.oxlintrc.json`）
- Workflow の `steps` は Action を名前（文字列）で持ち、名前の検証は入口が名前の一覧を渡して行う（ADR-003）
- `dg` のコマンド・MCP のツール・画面には出さず、core の公開も `ACTION_NAMES` だけにする。エージェントは `dg guide` の手順に従って git・gh・テストを自分で呼ぶ（EX-1）
- `run_tests` は `actions.test` に書いた引数配列だけを確認なしで実行する。config.yaml は Git で共有されるので、deguboard ブランチに push できる人はここに任意のコマンドを書ける。その権限をシェルの許可と同等とみなす前提に立つ。`shell` は `actions.shell` が true で、呼び出し側の確認が通ったときだけ実行する（AG-7）
- worktree・ブランチの操作は guide の手順と同じ形にし、core は worktree もブランチも作らない（claim は `branch` を記録する。ST-3）

### 索引はメモリ上に持つ

- DB は使わない。起動時にファイルを走査してメモリ上に索引を作り、再走査して更新する。core はファイルを監視しない（VS Code 拡張はデータのファイルの変化を見張って画面を読み直す。UI-12）
- 再走査はファイルごとの印を前回と比べ、変わったファイルだけを読み直す（細部は `core/storage/store.ts`）

## 理由

- 入口が増えても `core/commands` を 1 回書けば済む。CLI と UI と MCP で振る舞いがずれない
- 依存を一方向にすれば、Core を単体でテストでき、VS Code や HTTP の都合が Core に入らない
- 最初から 10 パッケージに分けると、境界をまたぐ型と設定が増え、変更のたびに複数パッケージを触る。モジュールの境界を先に決めておけば、切り出しは後からできる
- Adapter と Action を Core の境界として先に型だけ決めるのは、最初のデータモデル（Run・Workflow の `steps`）がそれに依存するため
- Action をライブラリに留めるのは、deguboard がエージェントを起動しない（EX-1）ので、今 Action を実行する主体がいないため。コマンドにすると `core/commands` が actions に依存し（AG-6）、エージェントが Bash で直接打てる git・gh を包む層が増えるだけになる。確認の手段（`confirm`）を呼び出し側に任せれば、CLI の対話・画面のダイアログ・承認の step のどれでも同じ検査を通る
- 数千件までのチケットなら、ファイル走査とメモリ索引で十分に速い
- 時刻の刻みは粗く inode も使い回されるので、同じ刻みの中で同じ大きさに書き直されると印が変わらない。更新が新しいファイルを覚えなければ、この書き直しを見落とさない

## 採らなかった案

- **構想どおり 10 パッケージ**：抽象化が先行し、MVP の変更コストが上がる
- **MCP サーバーを独立パッケージにする**：コマンド定義から作る薄い層で、`dg` に同梱すれば CLI と同じ版で動く
- **Workflow エンジンを別パッケージにする**：Core の遷移検査と照合が Workflow に依存し、境界をまたぐ呼び出しが増える
- **入口ごとにロジックを書く**：CLI と UI で振る舞いがずれる
- **`dg action list / run` のコマンドにする**：`core/commands` が actions に依存し、エージェントに同じ操作の道が 2 つできる
- **テスト実行を任意のコマンドの入力で受ける**：`actions.shell` を通らない任意の実行になる
- **SQLite の索引**：ネイティブ依存と DB ファイルの管理が増える
- **データ worktree の git の状態で読み直しを判定する**：git の子プロセスの分だけ遅く、コミット前の書き込みや手での編集を見落とす
