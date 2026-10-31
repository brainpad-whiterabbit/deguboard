# deguboard

deguboard は、Git で管理するチケットとユーザー定義のワークフローを組み合わせた、Local-first で AI エージェント対応のタスク管理ツール。CLI は `dg`。

チケット・イテレーション・ワークフローの定義は、リポジトリの orphan ブランチ `deguboard` に Markdown と YAML で置く。コードと同じく Git で共有するので、別のサービスを用意しなくてもチームで同じカンバンを見られ、変更の履歴も残る。Claude Code や Codex などの AI エージェントは `dg` を呼んでチケットを起票・計画・実行し、人は何を作るか・どの順で進めるか・成果物を承認するかを決める。

> **開発中**。最初の版（CLI・Web UI・VS Code 拡張でのチケット管理。Epic `e1`）を実装している。CLI・API・ブラウザの画面・VS Code 拡張はある。npm と Marketplace への最初の公開を準備中で、拡張は VSIX（`mise run vsix`）で入れる。

## 何ができるか（予定を含む）

| できること                                                                                                                    | 状態      |
| ----------------------------------------------------------------------------------------------------------------------------- | --------- |
| `dg` でチケット・エピック・プロジェクト・イテレーション・ワークフローを管理し、変更を `deguboard` ブランチにコミットする      | できる    |
| ブラウザ（`dg serve`）と VS Code 拡張の同じ画面で、カンバン・バックログ・チケット詳細・エピック・イテレーションを見て操作する | できる    |
| ワークフロー（遷移の条件・照合規則・追加フィールド・表示名）を業務ごとに YAML で定義する                                      | できる    |
| Claude Code との会話からチケットを起票し、分解・依存・イテレーション計画を進める（Skill と MCP）                              | 予定 `e2` |
| AI の実行を Run として記録し、トークン使用量と結果をチケット・イテレーション・プロジェクトで集計する                          | 予定 `e3` |
| 依存に従う並列実行、自動レビュー、修正ループ、品質ゲート                                                                      | 予定 `e4` |

予定の中身と進みは、このリポジトリの Epic（`dg epic list`、`dg epic show e2`）が正本。

deguboard はエージェントを起動も監視もしない。チケットの状態は、作業ブランチの Git 上の事実（ある・push 済み・マージ済み）から前に進む。

## ドキュメント

- [要件定義書](docs/requirements.md)：今の仕様の正本
- [ADR](docs/adr/README.md)：設計判断の背景と理由
- [開発ガイド](docs/development.md)：このリポジトリで開発する人向け
- `dg guide <topic>`：エージェント向けの手順の正本（CLI に同梱）

## 使い始める

前提は Linux / macOS、git 2.30 以上、Node.js 24 以上。GitHub CLI（`gh`）は PR の状態をチケットに反映したいときだけ要る。

```sh
npm i -g deguboard            # mise なら mise use -g npm:deguboard
cd <管理したいリポジトリ>
dg init                       # orphan ブランチ deguboard と worktree .git/deguboard/ を作り、リモートがあれば push する
dg ticket create "ログインの検証" --summary "入力の検査" --acceptance "空のとき拒否する"
dg ticket list                # 表で出る。--json で機械向け
dg serve --open               # 127.0.0.1:7474 でカンバンを開く
dg guide overview             # エージェント向けの手順。Claude Code には「dg guide を読んでから dg で進めて」と頼む
```

VS Code では、拡張を入れて（今は VSIX から。`mise run vsix` → `code --install-extension packages/vscode/deguboard-vscode.vsix`）コマンドパレットの「deguboard: 画面を開く」。拡張は `dg` なしで動き、`dg` が PATH にないときは案内を出す。

チケットの流れ（起票 → claim → 作業 → PR → 照合で done）とコマンドの一覧は `dg --help` と `dg guide work`、仕様は[要件定義書](docs/requirements.md)。
