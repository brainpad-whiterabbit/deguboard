# deguboard

AI エージェントに仕事を任せるための、Git リポジトリの中で動くカンバンです。仕事を小さなチケットに分けてエージェントに渡し、依存に沿って並列に進め、その働きを測って改善できます。Claude Code・Codex・GitHub Copilot など、コマンドを実行できるエージェントならどれでも使えます。

> **開発中です**。npm と Marketplace にはまだ公開していません。今は clone してビルドした `dg` と VSIX を使います（「[公開前に使い始める](https://github.com/brainpad-whiterabbit/deguboard#公開前に使い始める)」）。実装済みの範囲とこれからの機能は、このリポジトリの Epic（`dg epic list`）が正本です。

## 特長

- **任せる仕事を小さくそろえる**：仕事をチケットに分けるので、エージェントに渡す 1 回の作業が小さく、同じくらいの大きさにそろいます。チケットごとに受け入れ条件を確かめるので、品質を保てます。
- **依存に沿って並列に進める**：チケットの依存から進める順を計画し、待ちのないチケットは同時に進めます。品質を落とさずに、速く仕上がります。
- **エージェントの働きを測る**：作業のたびに所要時間・トークン・結果を記録し、チケット・工程・モデルごとに集計します。どこで時間やトークンを使っているか、ボトルネックを調べられます。
- **エージェントを選ばない**：エージェントはコマンドラインツール `dg` でチケットを読み書きし、進め方の手順も `dg guide` から受け取ります。Claude Code・Codex・Copilot CLI など、シェルを使えるエージェントならどれでも使えます。チケットごとにエージェントを使い分けて、実績を比べることもできます。
- **サービスがいらない**：チケットも記録も同じリポジトリの専用ブランチに保存されます。push するだけで、チームで同じボードを見られます。
- **VS Code の中で完結**：カンバン・バックログ・履歴をサイドバーで見て、吹き出しから依頼文をコピーしてエージェントに頼めます。エージェントが書いた変更はすぐ画面に映ります。

## 導入

必要なもの：Linux か macOS、Git 2.30 以上、Node.js 24 以上。PR の状態をチケットに映すときは GitHub CLI（`gh`）も使います。

1. **拡張を入れる**：公開後は拡張機能ビューで「deguboard」を検索してインストールします。公開前は [GitHub Release](https://github.com/brainpad-whiterabbit/deguboard/releases) の `deguboard-vscode.vsix` を取得し、`code --install-extension deguboard-vscode.vsix` で入れます。
2. **コマンドラインツール `dg` を入れる**：エージェントは `dg` でチケットを読み書きします。公開後は npm で入れます（mise なら `mise use -g npm:deguboard`）。

   ```sh
   npm i -g deguboard
   ```

   公開前は、「[公開前に使い始める](https://github.com/brainpad-whiterabbit/deguboard#公開前に使い始める)」のとおり clone してビルドし、`dg` を PATH に通します。

3. **リポジトリで準備する**：管理したいリポジトリで一度だけ実行します。チケットを置くブランチができ、リモートがあれば push されます。

   ```sh
   cd <管理したいリポジトリ>
   dg init
   ```

4. **エージェントに手順を渡す**：Claude Code では、`/dgall` などのコマンドを使えるようにします。

   ```sh
   dg skill install
   ```

   Codex・Copilot CLI などほかのエージェントでは準備は要りません。「`dg guide` を読んでから `dg` で進めて」と頼みます。

5. **ボードを開く**：Activity Bar の deguboard のアイコンを押します。

チームの 2 人目からは、リポジトリを clone して `dg init` を実行すると同じボードが見えます。画面を見るだけなら `dg` がなくても動きます。

## 使い方

### ボードを開く

Activity Bar の deguboard のアイコンを押すと、サイドバーにカンバンが開きます。上のタブでバックログと履歴に切り替えます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/open-board.gif" alt="ボードを開く" width="560">

### 雑な指示からチケットを起票する

思いついたままの一言で頼むと、エージェントがコードを調べて、小さなチケットに分けた起票の案を出します。案には概要・受け入れ条件・優先度・依存が入り、承認するとバックログに並びます。Claude Code では `/dgimport` を付けて頼みます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/import.gif" alt="雑な指示からチケットを起票する" width="560">

### エージェントに頼む

行にマウスを載せて吹き出しを押し、頼むことを選びます。指示を書いてコピーし、エージェントの入力欄に貼ります。Claude Code 以外のエージェントには、形式を「文章」にしてコピーします。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/ask-agent.gif" alt="エージェントに頼む" width="560">

### 最後まで任せる

作りたいものを書いて `/dgall --auto`（Claude Code の場合）を付けて頼むと、エージェントがチケットを起票し、進める順を計画して、1 件ずつ仕上げます。ボードでは、チケットが Todo から In Progress へ進み、すべて Done になるまでを見守れます。計画の帯を押すと、どのチケットがどれを待っているかをグラフで見られます。ほかのエージェントでは「`dg guide all` を読んで、`--auto` で最後まで進めて」と頼みます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/run-all.gif" alt="最後まで任せる" width="560">

### ボトルネックを調べる

履歴で終わった Iteration の吹き出しから「振り返る」を選び、調べたいことを書いて頼みます。エージェントは記録した実績（工程ごとの所要時間・トークン・差し戻し）を集計し、どこが詰まっていたかと次に直すことを分析レポートにまとめます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/retro.gif" alt="ボトルネックを調べる" width="560">

トークンも集計するには、エージェントの会話記録から使用量を取り込む設定を有効にします（Claude Code・Codex・Copilot CLI に対応）。

```sh
dg config set metrics.read_transcripts true
```

この設定はチームで共有されます。自分のマシンでは会話記録を読ませないときは、環境変数 `DEGUBOARD_NO_TRANSCRIPTS=1` を設定します。

## セキュリティとプライバシー

- 拡張は外部のサーバーと通信せず、テレメトリ（利用状況の送信）もしません。画面のために HTTP サーバーも起動しません。
- データはリポジトリの `.git/deguboard/` に置きます。書くのは `.git` の中だけです。
- 拡張が外部のコマンドとして呼ぶのは `git` と、入っていれば PR の状態の照合に使う `gh`（GitHub CLI）です。`dg` は同梱せず、PATH にあれば版を確かめるために `dg --version` だけを呼びます。エージェントや CLI から使う `dg` は利用者が呼びます。拡張はどれも引数配列で直接実行し、シェルを通しません（同期の rebase で git が登録済みのマージドライバ（中身は `dg merge-driver`）を `sh -c` で動かすのは git の仕様です）。通信が起きるのは、`git` がリモートに接続するとき（fetch・push・ls-remote）と、`gh` が GitHub に接続するときだけです。
- 制限モード（信頼していないフォルダー）と仮想ワークスペースでは動きません。リポジトリの git の設定（`core.fsmonitor` など）が任意のコマンドを実行させ得るためです。フォルダーを信頼したときだけ使えます。
- `dg skill install` が書く Skill は `dg guide` を読ませる決まった文面だけで、スクリプトもツールの許可（`allowed-tools`）も持ちません。`--dry-run` で、書く前に書く先と中身を見られます。
- 脆弱性の報告先と修正の対象の版は [SECURITY.md](https://github.com/brainpad-whiterabbit/deguboard/blob/main/SECURITY.md) にあります。

## ほかの使い方

### 公開前に使い始める

[mise](https://mise.jdx.dev/) を入れて clone し、ビルドした `dg` を PATH に通します。リポジトリの外でも `dg` を使うには、node 24 がリポジトリの外でも PATH にある必要があります（mise なら `mise use -g node@24`）。

```sh
git clone https://github.com/brainpad-whiterabbit/deguboard.git && cd deguboard
mise trust && mise install    # node・pnpm を mise.toml の版で入れる
mise run install              # 依存を入れ、dg と拡張をビルドし、VSIX を VS Code に入れる
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/dg.js" ~/.local/bin/dg   # ~/.local/bin が PATH になければ足す。更新は git pull のあと mise run install
```

VSIX を手で入れるときは、`mise run vsix` の後に `code --install-extension packages/vscode/deguboard-vscode.vsix` を実行します。

### ブラウザと CLI で使う

VS Code がなくても、ブラウザで同じボードを見られます。ブラウザでは Run のタブで実行中・完了の Run と実績の集計も見られます。

```sh
dg serve --open               # 127.0.0.1:7474 でボードを開く
dg ticket create "ログインの検証" --summary "入力の検査" --acceptance "空のとき拒否する"
dg ticket list                # --json で機械向け
```

Skill を入れずに、`dg ask --format text` か画面の頼む小窓で作った文章をエージェントに貼っても同じことを頼めます。

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

- [要件定義書](docs/requirements.md)：今の仕様の正本。Run の記録と集計は「5.9 Run」と「6.6 作業の実績」、Plan の段階とモデルは PL-1 と 5.10
- [ADR](docs/adr/README.md)：設計判断の背景と理由
- [開発ガイド](docs/development.md)：このリポジトリで開発する人向け
- [SECURITY.md](SECURITY.md)：脆弱性の報告先と修正の対象の版
- `dg --help` と `dg guide <topic>`：コマンドの一覧と、エージェント向けの手順の正本（CLI に同梱）

## ライセンス

[MIT](LICENSE)。配布物に束ねた依存のライセンスは、ビルドで出る `THIRD_PARTY_LICENSES.md`（npm の `deguboard` の `web/` と VSIX の `dist/`）にまとめています。
