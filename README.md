# deguboard

deguboard は、Git で管理するチケットとユーザー定義のワークフローを組み合わせた、Local-first で AI エージェント対応のタスク管理ツール。CLI は `dg`。

チケット・イテレーション・ワークフローの定義は、リポジトリの orphan ブランチ `deguboard` に Markdown と YAML で置く。コードと同じく Git で共有するので、別のサービスを用意しなくてもチームで同じカンバンを見られ、変更の履歴も残る。Claude Code や Codex などの AI エージェントは `dg` を呼んでチケットを起票・計画・実行し、人は何を作るか・どの順で進めるか・成果物を承認するかを決める。

> **開発中**。最初の版（CLI・Web UI・VS Code 拡張でのチケット管理。Epic `e1`）、Claude Code 連携（Skill・MCP・Plan。Epic `e2`）、Run の記録と集計（Epic `e3`）を実装した。残る予定は並列実行や自動レビュー（Epic `e4`）。npm と Marketplace への最初の公開を準備中。それまで、拡張は VSIX（`mise run vsix`）で入れる。

## 何ができるか（予定を含む）

| できること                                                                                                                                                                                                           | 状態                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `dg` でチケット・エピック・プロジェクト・イテレーション・ワークフローを管理し、変更を `deguboard` ブランチにコミットする                                                                                             | できる                                            |
| ブラウザ（`dg serve`）と VS Code 拡張の同じ画面で、カンバン・バックログ・履歴・Run のタブと、チケット・エピック・イテレーションの詳細を見て操作する                                                                  | できる                                            |
| ワークフロー（遷移の条件・照合規則・追加フィールド・表示名）を業務ごとに YAML で定義する                                                                                                                             | できる                                            |
| Claude Code との会話からチケットを起票し、分解・依存・進める順（Plan）の承認・イテレーション計画を進める（Skill と MCP）                                                                                             | できる                                            |
| AI の実行を Run として記録し、トークン使用量と結果を Run・チケット・エピック・イテレーション・プロジェクト・エージェント・モデルの単位で集計する                                                                     | できる（使用量の取り込みは Claude Code と Codex） |
| `dg guide all` の手順に `--auto` を付けて（Claude Code では `/dgall --auto`）、戻せる判断を自動で選び、`auto.merge` が true なら検査・受け入れ条件・別エージェントの見直し・衝突なしを確かめて PR を自動でマージする | できる                                            |
| 依存に従う並列実行、PR を出す前の自動レビューと上限付きの修正ループ、品質ゲートの共通化                                                                                                                              | 予定 `e4`                                         |

予定の中身と進みは、このリポジトリの Epic（`dg epic list`、`dg epic show <ID>`）が正本。

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
dg skill install              # Claude Code の Skill（/dgimport・/dgplan・/dgwork など）を .claude/skills/ に書く（--personal で ~/.claude/skills）
```

チームの 2 人目からは、リポジトリを clone して `dg init` を実行する。リモートにある `deguboard` ブランチを取り込むので、同じチケットが見える。

VS Code では、拡張を入れて（今は VSIX から。`mise run vsix` → `code --install-extension packages/vscode/deguboard-vscode.vsix`）Activity Bar の deguboard のアイコンを押すとサイドバーにカンバンが開く。チケットを押すと詳細がエディタ領域に開く。拡張は `dg` なしで動き、`dg` が PATH にないときは案内を出す。

### Run の記録と集計

Run は 1 回の AI の作業の記録で、エージェントがチケットの工程（step）の始めと終わりに `dg run start` / `dg run finish` を呼んで残す。Skill と `dg guide work` の手順がこれを呼ぶので、人がするのは使用量を取り込む許可と、結果を見ることだけ。

```sh
dg config set metrics.read_transcripts true   # finish が会話記録から使用量を取り込む（既定は false。config はチームで共有する）
export DEGUBOARD_NO_TRANSCRIPTS=1             # このマシンでは会話記録を読ませないとき
dg run list --running                         # 実行中の Run。閉じ損ねたものは dg run finish <ID> --result interrupted
dg metrics show --iteration s1 --by ticket    # 絞り込み（--ticket・--epic・--agent など）と単位ごとの集計
```

使用量を取り込めるのは今は Claude Code（`--agent claude-code`）と Codex（`--agent codex`）の Run だけで、取れなかった値は 0 と数えず欠けた数として出る。画面では、Run のタブで実行中の Run・単位を選んだ実績・完了した Run を、チケット詳細の Run の節でそのチケットの Run を見る。記録の形・Git に入れる範囲・集計の約束は[要件定義書](docs/requirements.md)の「5.9 Run」と「6.6 作業の実績」。

### MCP で使う

`dg mcp` は stdio の MCP サーバーで、`dg` のコマンドを `ticket_create` のような名前のツールとして出す。主体は常に `<ユーザ>/agent`。Bash のない Claude Desktop などから、会話でチケットを起票・閲覧し、状態を進めるための入口。

Claude Desktop では `claude_desktop_config.json` に登録する。Desktop はリポジトリの外で、シェルの PATH を引き継がずに起動する。`-C` で対象のリポジトリを指し、`command` は node の絶対パスにして、`dg` の実体（`bin/dg.js`）を引数に渡す。mise の shim はプロジェクトの外では node の版を決められず、`dg` も `#!/usr/bin/env node` なので、どちらも PATH 頼みでは動かない。node のパスはリポジトリで `mise which node`（か `which node`）で、`dg.js` は `realpath "$(which dg)"` で調べる。

```json
{
  "mcpServers": {
    "deguboard": {
      "command": "/path/to/node",
      "args": ["/path/to/deguboard/packages/cli/bin/dg.js", "-C", "/path/to/repo", "mcp"]
    }
  }
}
```

Claude Code では Bash で `dg … --json` を呼べ、Skill と `dg guide` もそれを前提にするので、登録しなくてよい（ツールのスキーマは会話の文脈を使う）。

チケットの流れ（起票 → claim → 作業 → PR → 照合で done）とコマンドの一覧は `dg --help` と `dg guide work`、仕様は[要件定義書](docs/requirements.md)。

## ライセンス

[MIT](LICENSE)。配布物に束ねた依存のライセンスは、ビルドで出る `THIRD_PARTY_LICENSES.md`（npm の `deguboard` の `web/` と VSIX の `dist/`）にまとめる。
