# deguboard

deguboard は、Git で管理するチケットとユーザー定義のワークフローを組み合わせた、Local-first で AI エージェント対応のタスク管理ツール。CLI は `dg`。

チケット・イテレーション・ワークフローの定義は、リポジトリの orphan ブランチ `deguboard` に Markdown と YAML で置く。コードと同じく Git で共有するので、別のサービスを用意しなくてもチームで同じカンバンを見られ、変更の履歴も残る。Claude Code や Codex などの AI エージェントは `dg` を呼んでチケットを起票・計画・実行し、人は何を作るか・どの順で進めるか・成果物を承認するかを決める。

> **開発中**。実装済みの範囲とこれから足す機能の進みは、このリポジトリの Epic（`dg epic list`、`dg epic show <ID>`）が正本。npm と Marketplace には**まだ公開していない**（準備中）。それまでは clone してビルドした `dg` と VSIX を使う（「[使い始める](#使い始める)」）。

## 何ができるか

- `dg` でチケット・エピック・プロジェクト・イテレーション・ワークフローを管理し、変更を `deguboard` ブランチにコミットする
- ブラウザ（`dg serve`）と VS Code 拡張の画面で、カンバン・バックログ・履歴・Run（ブラウザだけ）のタブと、チケット・エピック・イテレーションの詳細を見る。画面から書き込むのは、チケット詳細（タイトル・本文・Status・属性）と設定画面（ブラウザは上のバー、VS Code はタイトル行の歯車）と同期だけ
- ほかの変更はエージェントに頼む。画面の行・見出しと上のバー（VS Code はタイトル行）の吹き出しか、VS Code の右クリックで対象と頼むことを選び、指示を添えた依頼文をコピーしてエージェントに貼る。同じ依頼文は `dg ask` でも作れる。依頼文を作るだけで、データには書き込まない
- ワークフロー（遷移の条件・照合規則・追加フィールド・表示名）を業務ごとに YAML で定義し、`dg workflow show` で見て `dg workflow set` で書き換える
- Claude Code との会話からチケットを起票し、分解・依存・進める順（Plan）の承認・イテレーション計画を進める（Skill と MCP）。段階ごとにモデルを変えられる（「[Plan の段階とモデル](#plan-の段階とモデル)」）
- AI の実行を Run として記録し、トークン使用量と結果を Run・チケット・エピック・イテレーション・プロジェクト・エージェント・モデル・工程の単位で集計する（使用量の取り込みは Claude Code・Codex・Copilot CLI）
- `dg guide all` の手順に `--auto` を付けて（Claude Code では `/dgall --auto`）、戻せる判断を自動で選び、`auto.merge` が true なら検査・受け入れ条件・別エージェントの見直し・衝突なしを確かめて PR を自動でマージする
- `dg guide parallel` の手順（`all` と `work` から引く）で、Plan の待ちのない複数のチケットをサブエージェントで同時に進める
- `dg guide work` の手順で、PR を出す前に別のサブエージェントが見直し、指摘を上限付きの修正ループで直す。品質ゲートは `dg guide review` にまとめ、自動マージの前にも使う

deguboard はエージェントを起動も監視もしない。チケットの状態は、作業ブランチの Git 上の事実（ある・push 済み・マージ済み）から前に進む。

## ドキュメント

- [要件定義書](docs/requirements.md)：今の仕様の正本
- [ADR](docs/adr/README.md)：設計判断の背景と理由
- [開発ガイド](docs/development.md)：このリポジトリで開発する人向け
- `dg guide <topic>`：エージェント向けの手順の正本（CLI に同梱）

## 使い始める

前提は Linux / macOS、git 2.30 以上、Node.js 24 以上。GitHub CLI（`gh`）は PR の状態をチケットに反映したいときだけ要る。

npm に公開するまでは、[mise](https://mise.jdx.dev/) を入れて deguboard を clone し、ビルドした `dg` を PATH に通す。`dg` は `#!/usr/bin/env node` で動くので、リポジトリの外で `dg` を使うには node 24 がリポジトリの外でも PATH にあること（mise なら `mise use -g node@24`）。

```sh
git clone https://github.com/brainpad-whiterabbit/deguboard.git && cd deguboard
mise trust && mise install    # node・pnpm を mise.toml の版で入れる
mise run install              # 依存を入れ、dg と VS Code 拡張をビルドし、VSIX を VS Code に入れる（code CLI がないか答えなければ導入は飛ばす）
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/dg.js" ~/.local/bin/dg   # ~/.local/bin が PATH になければ足す。更新は git pull のあと mise run install
```

公開後は `npm i -g deguboard`（mise なら `mise use -g npm:deguboard`）で入れる。入れたら、管理したいリポジトリで始める。

```sh
cd <管理したいリポジトリ>
dg init                       # orphan ブランチ deguboard と worktree .git/deguboard/ を作り、リモートがあれば push する
dg ticket create "ログインの検証" --summary "入力の検査" --acceptance "空のとき拒否する"
dg ticket list                # 表で出る。--json で機械向け
dg serve --open               # 127.0.0.1:7474 でカンバンを開く
dg guide overview             # エージェント向けの手順。Claude Code には「dg guide を読んでから dg で進めて」と頼む
dg skill install              # Claude Code の Skill（/dgimport・/dgplan・/dgwork など）を .claude/skills/ に書く（--personal で ~/.claude/skills）
```

チームの 2 人目からは、リポジトリを clone して `dg init` を実行する。リモートにある `deguboard` ブランチを取り込むので、同じチケットが見える。

VS Code の拡張は、今は VSIX から入れる。上の `mise run install` が入れ、手で入れるなら `mise run vsix`（build も先に走る）の後に `code --install-extension packages/vscode/deguboard-vscode.vsix` を実行する。拡張を入れて Activity Bar の deguboard のアイコンを押すと、サイドバーにカンバンが開く。画面の見た目は[拡張の README](packages/vscode/README.md)、仕様は[要件定義書](docs/requirements.md)の UI-2・UI-7・UI-12〜15。拡張は `dg` なしで動き、`dg` が PATH にないときは案内を出す。

### Run の記録と集計

Run は 1 回の AI の作業の記録で、エージェントがチケットの工程（step）の始めと終わりに `dg run start` / `dg run finish` を呼んで残す。Skill と `dg guide work` の手順がこれを呼ぶので、人がするのは使用量を取り込む許可と、結果を見ることだけ。

```sh
dg config set metrics.read_transcripts true   # finish が会話記録から使用量を取り込む（既定は false。config はチームで共有し、既定の batch では dg sync で送る）
export DEGUBOARD_NO_TRANSCRIPTS=1             # このマシンでは会話記録を読ませないとき
dg run list --running                         # 実行中の Run。閉じ損ねたものは dg run finish <ID> --result interrupted
dg run list --iteration s1                    # その Iteration のチケットの Run
dg metrics show --iteration s1 --by ticket    # 絞り込み（--ticket・--epic・--step など）と単位ごとの集計
```

使用量を取り込めるのは今は Claude Code（`--agent claude-code`）・Codex（`--agent codex`）・Copilot CLI（`--agent copilot`）の Run だけで、取れなかった値は 0 と数えず欠けた数として出る。画面では、Run のタブで実行中・完了の Run と単位ごとの実績を、チケット詳細の Run の節と履歴の Iteration の行の「Run の集計」でそのチケット・Iteration の Run を見る（Run のタブと「Run の集計」はブラウザだけ）。記録の形・Git に入れる範囲・集計の約束は[要件定義書](docs/requirements.md)の「5.9 Run」と「6.6 作業の実績」。

### Plan の段階とモデル

Plan はチケットごとに段階 `--tier`（`light` / `standard` / `heavy`。省けば standard）を持つ。段階は設定の `models.light` / `models.standard` / `models.heavy` でモデルに対応し、`dg guide work` の手順がそのモデルのサブエージェントに実装を渡す（空なら親のモデルのまま）。段階の目安は `dg guide plan`、正本は[要件定義書](docs/requirements.md)の PL-1 と 5.10。

```sh
dg plan create t12 t13 --tier t12=light --tier t13=heavy   # チケットごとの段階。目安は dg guide plan
dg config set models.heavy <モデル名>                       # 段階ごとのモデル（light・standard も）。既定は空
```

### MCP で使う

`dg mcp` は stdio の MCP サーバーで、`dg` のコマンドを `ticket_create` のような名前のツールとして出す。主体は常に `<ユーザ>/agent`。主体名は `git config deguboard.user <名前>` で変えられ、`dg whoami` で確かめられる（優先順は `dg --help` の `--user`）。Bash のない Claude Desktop などから、会話でチケットを起票・閲覧し、状態を進めるための入口。

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
