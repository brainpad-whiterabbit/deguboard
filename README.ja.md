# deguboard

[English](README.md) | 日本語

AI エージェントに仕事を任せるための、Git リポジトリの中で動くカンバンです。仕事を小さなチケットに分けてエージェントに渡し、依存に沿って並列に進め、その働きを測って改善できます。

> **開発中です**。npm と Marketplace にはまだ公開していません。今は clone してビルドした `dg` と VSIX を使います（「[公開前に使い始める](#公開前に使い始める)」）。

## 特長

- **任せる仕事を小さくそろえる**：1 回に渡す作業を小さなチケットにそろえ、受け入れ条件で確かめます。
- **依存に沿って並列に進める**：依存から進める順を計画し、待ちのないチケットは同時に進めます。
- **エージェントの働きを測る**：所要時間・トークン・結果をチケット・工程・モデルごとに集計し、ボトルネックを探せます。
- **エージェントを選ばない**：Claude Code・Codex・Copilot CLI など、シェルを使えるエージェントなら `dg` コマンドで使えます。
- **サービスがいらない**：データはリポジトリの専用ブランチに置き、push すればチームで同じボードを見られます。
- **VS Code の中で完結**：カンバン・バックログ・履歴をサイドバーで見て、そこからエージェントに頼めます。

## 導入

必要なもの：Linux か macOS、Git 2.30 以上、Node.js 24 以上。PR の状態をチケットに映すときは GitHub CLI（`gh`）も使います。

1. **拡張を入れる**：拡張機能ビューで「deguboard」を検索してインストールします。公開前は [GitHub Releases](https://github.com/brainpad-whiterabbit/deguboard/releases) の `deguboard-vscode.vsix` を `code --install-extension deguboard-vscode.vsix` で入れます。
2. **`dg` を入れる**：`npm i -g deguboard` で入れます。公開前は「[公開前に使い始める](#公開前に使い始める)」のとおりビルドします。
3. **リポジトリで準備する**：管理したいリポジトリで一度だけ実行します。

   ```sh
   cd <管理したいリポジトリ>
   dg init
   ```

4. **エージェントに手順を渡す**：Claude Code では `/dgall` などのコマンドを入れます。

   ```sh
   dg skill install
   dg hooks install
   ```

   `dg hooks install` は Claude Code のフックを入れ、セッションをエージェントとして扱い、最初の行に `deguboard: ticket=<id> step=<step>` と書いて頼んだサブエージェントを Run として記録します。フックは、`dg` を通さない PR の ready・マージと、`.git/deguboard/` への直接の書き込みも拒みます。ほかのエージェントでは準備は要らず、「`dg guide` を読んでから `dg` で進めて」と頼みます。

5. **ボードを開く**：Activity Bar の deguboard のアイコンを押します。

チームの 2 人目からは、clone して `dg init` を実行すれば同じボードが見えます。

## 使い方

### ボードを開く

Activity Bar の deguboard のアイコンでカンバンが開きます。上のタブでバックログと履歴に切り替えます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/open-board.gif" alt="ボードを開く" width="560">

### ID かタイトルから詳細へ移動する

コマンドパレットの「deguboard: チケットへ移動」か `Ctrl+K Ctrl+Alt+G`（macOS は `⌘K ⌘⌥G`）で、チケット・Iteration・Epic・Plan を ID かタイトルで絞り込んで詳細を開きます。

### キーボードで操作する

サイドバーの行（カンバン・バックログ・履歴）はマウスなしで操作できます。Tab で一覧に入ると、移れる行は今の 1 行だけで、Tab を 1 回押すと一覧を抜けます。

| キー               | 動き                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| ↑ ↓ ・ Home ・ End | 行を移る（今の行にフォーカスの枠が出ます）                                                     |
| Enter              | 今の行の詳細をエディタのパネルに開く                                                           |
| Space              | 今の行を選ぶ・外す（続けて足すと複数選べます）                                                 |
| a                  | 選んだ行（選んでいなければ今の行）に「エージェントに頼む」の一覧を開く。Shift+F10 でも開きます |

どれも VS Code の既定のキー割り当てとぶつかりません。

### 雑な指示からチケットを起票する

思いついたままの一言を `/dgimport`（Claude Code の場合）を付けて頼むと、エージェントがコードを調べ、受け入れ条件と依存の付いたチケットの案を出します。承認するとバックログに並びます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/import.gif" alt="雑な指示からチケットを起票する" width="560">

### エージェントに頼む

行の吹き出しを押して頼むことを選び、コピーした依頼文をエージェントに貼ります。Claude Code 以外には形式を「文章」にします。開いているターミナルを選んで「送る」こともできます。1 行は Enter を押さずに入力へ入ります。複数行は VS Code の貼り付けで入れ、確認が出たら貼り付けるかを選んでください。入力が貼り付けに対応しないと、行ごとに実行されることがあります。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/ask-agent.gif" alt="エージェントに頼む" width="560">

### 最後まで任せる

作りたいものを `/dgall --auto`（Claude Code の場合）を付けて頼むと、エージェントが起票・計画・実装を続けて進めます。リリース、チケットの削除・abandoned・閉じる、`auto.merge` が false のときの PR のマージなど承認が要るところでは止まって人に聞きます。どの判断を止めずに進めるかは config の `auto.decisions` で選べます。ボードでは進み具合を見守れ、計画の帯を押すと依存をグラフで見られます。ほかのエージェントには「`dg guide all` を読んで、`--auto` で最後まで進めて」と頼みます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/run-all.gif" alt="最後まで任せる" width="560">

### ボトルネックを調べる

履歴で終わった Iteration の吹き出しから「振り返る」を頼むと、エージェントが実績（工程ごとの所要時間・トークン・差し戻し）を集計し、詰まった所と次に直すことをまとめます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/retro.gif" alt="ボトルネックを調べる" width="560">

トークンも集計するには、会話記録から使用量を取り込む設定を有効にします（Claude Code・Codex・Copilot CLI に対応）。

```sh
dg config set metrics.read_transcripts true
```

設定はチームで共有されます。自分のマシンだけ止めるときは `DEGUBOARD_NO_TRANSCRIPTS=1` を設定します。

### 承認待ちに気づく

承認待ちの Plan と review のチケットがあると、サイドバーのタイトルが「DEGUBOARD: 承認待ち 3」のように件数つきになり（なければ「DEGUBOARD」）、増えたときは通知が出て「開く」でその詳細が開きます。Activity Bar のアイコンの数字は別物で、未 push のコミットと未取り込みのリモートの更新の合計です。

通知は設定画面（歯車）の「通知」で切れます（件数の表示は残ります）。チームの設定のまま自分だけ切るときは、設定画面の「自分」のタブか `--local` を使います（Git に入らない個人の設定。`dg config set --help`）。

```sh
dg config set notify.approvals false --local
```

## セキュリティとプライバシー

- 拡張はテレメトリを送らず、HTTP サーバーも起動しません。通信は `git` のリモートへの接続と、`gh` の GitHub への接続だけです。
- データは `.git/deguboard/` に置き、`.git` の外には書きません。
- 拡張が呼ぶコマンドは `git`・`gh`・`dg --version` だけで、どれもシェルを通しません（同期の rebase で git がマージドライバを `sh -c` で動かすのは git の仕様です）。
- git の設定が任意のコマンドを実行させ得るため、信頼したフォルダーでだけ動きます（制限モードと仮想ワークスペースでは動きません）。
- `dg skill install` が書く Skill は `dg guide` を読ませる文面だけで、スクリプトもツールの許可も持ちません。`--dry-run` で中身を見られます。
- `dg hooks install` が書くフックは `dg hook <イベント>` を呼ぶだけで、Run を記録し、`~/.claude/projects/` の下の会話記録を読みます。実行の前に、`dg` を通さない `gh pr ready`・`gh pr merge`（`gh api` での同じ操作も）、`.git/deguboard/` の下に書くファイル編集のツール、`.git/deguboard` の語を含む Bash のコマンドも拒みます。そのときは `dg` のコマンドを使います。`--dry-run` で設定を見られ、`dg hooks uninstall` で外せます。
- 脆弱性の報告先は [SECURITY.md](SECURITY.md) にあります。

## ほかの使い方

### 公開前に使い始める

[mise](https://mise.jdx.dev/) を入れて clone し、ビルドした `dg` を PATH に通します。リポジトリの外では node 24 も PATH に要ります（mise なら `mise use -g node@24`）。

```sh
git clone https://github.com/brainpad-whiterabbit/deguboard.git && cd deguboard
mise trust && mise install    # node・pnpm を mise.toml の版で入れる
mise run install              # 依存を入れ、dg と拡張をビルドし、VSIX を VS Code に入れる
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/dg.js" ~/.local/bin/dg   # ~/.local/bin が PATH になければ足す。更新は git pull のあと mise run install
```

VSIX を手で入れるときは、`mise run vsix` の後に `code --install-extension packages/vscode/deguboard-vscode.vsix` を実行します。

### CLI で使う

VS Code がなくても、同じ操作を `dg` コマンドで行えます。

```sh
dg ticket create "ログインの検証" --summary "入力の検査" --acceptance "空のとき拒否する"
dg ticket list                # --json で機械向け
```

Skill を入れずに、`dg ask --format text` で作った文章をエージェントに貼っても同じことを頼めます。

### Claude Desktop から使う（MCP）

`dg mcp` は stdio の MCP サーバーで、`dg` のコマンドを `ticket_create` のような名前のツールとして出します。Claude Desktop は PATH を引き継がずにリポジトリの外で起動するので、`claude_desktop_config.json` では `command` に node の絶対パス（`mise which node`）、引数に `dg.js` の実体（`realpath "$(which dg)"`）と `-C <対象のリポジトリ>` を渡します。Claude Code は Bash で `dg` を呼べるので登録は要りません。

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

## ドキュメント

- [要件定義書](docs/requirements.md)：今の仕様の正本
- [ADR](docs/adr/README.md)：設計判断の背景と理由
- [開発ガイド](docs/development.md)：このリポジトリで開発する人向け
- [SECURITY.md](SECURITY.md)：脆弱性の報告先と修正の対象の版
- `dg --help` と `dg guide <topic>`：コマンドの一覧と、エージェント向けの手順の正本（CLI に同梱）

## ライセンス

[MIT](LICENSE)。配布物に束ねた依存のライセンスは、ビルドで出る `THIRD_PARTY_LICENSES.md`（npm の `deguboard` の `web/` と VSIX の `dist/`）にまとめています。
