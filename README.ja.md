# deguboard

[English](README.md) | 日本語

[Agentic-Agile](https://github.com/microsoft/agentic-agile-template/blob/main/MANIFESTO.md) を実践するための、Git リポジトリの中で動くカンバンボードです。人はエージェントのパートナーとして設計・見直し・承認を担い、エージェントは受け入れ条件の付いた小さなチケットを、依存に沿って並列に進めます。働きはすべて測るので、どこで詰まったかを見て進め方を改善できます。

deguboard は独立したプロジェクトで、Microsoft が作ったものでも、推薦・支援するものでもありません。

## 特長

- **仕様で任せる**：任せる作業を、曖昧な指示の代わりに受け入れ条件の付いた小さなチケットにして渡します。エージェントはチケットに沿って進め、結果は受け入れ条件で確かめます。
- **依存に沿って並列に進める**：依存から進める順を計画し、待ちのないチケットはエージェントがそれぞれの作業ブランチと worktree で同時に進めます。
- **ガバナンスを組み込む**：Plan は承認を待ってから進みます。PR は品質ゲート（`dg gate`）の条件が通ったときだけ ready・マージに進みます。条件はチケットの段で変わり、既定は `high`（独立した見直しを含むすべての条件）です。`low` は見直しを除き、`free` は PR が開いていることと衝突しないことだけを判定します。`actor.human_only` と Workflow の規則でコマンドと遷移を人に限れ、Claude Code のフックは `dg` を通さない PR の ready・マージと、データへの直接の書き込みを拒みます。
- **測って改善する**：所要時間・トークン・やり直し・見直しの指摘・結果をチケット・工程・モデルごとに `dg metrics` で集計し、振り返りでボトルネックと次に直すことを見つけます。

## 導入

必要なもの：Git 2.30 以上。PR の状態をチケットに映すときは GitHub CLI（`gh`）も要ります。deguboard は Linux と macOS で動きます。

1. **拡張を入れる**：[GitHub Releases](https://github.com/brainpad-whiterabbit/deguboard/releases) の `deguboard-vscode.vsix` を取得し、`code --install-extension deguboard-vscode.vsix` で入れます。その後、ウィンドウを再読み込みします。
2. **リポジトリで始める**：管理したいリポジトリを開き、Activity Bar の deguboard のアイコンを押して、始めの画面の **このリポジトリで始める** を押します。`dg init`・`dg skill install`（Claude Code の Skill。`/dgall` など）・`dg hooks install`（Claude Code のフック。git が追跡しない `.claude/settings.local.json` に書く）が順に実行されます。
3. **ターミナルを使う人だけ**：ターミナルから `dg` を自分で呼ぶなら、コマンドパレットの **dg コマンドを入れる**（Install dg command）を実行します。`~/.local/bin/dg` が張られます（PATH に `~/.local/bin` がなければ足します）。

シェルを使えるほかのエージェント（Codex・Copilot CLI など）は準備が要らず、「`dg guide` を読んでから `dg` で進めて」と頼みます。

データはリポジトリの専用ブランチに置くので、サービスは要りません。チームの 2 人目からは、拡張を入れて clone し、同じボタンを押せば同じボードが見えます。

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

マウスでは、Ctrl/⌘+クリックで行を足し外しし、Shift+クリックで前に押した行からの範囲を選びます（ふつうのクリックは詳細を開きます）。行の左端の帯を押すと、その行を足し外しし、帯をなぞると範囲を選びます。Esc で選択を外します。選んだ行の吹き出し（と `a`）は、選んだ全件にエージェントへ頼みます。チケットの行と Iteration・Epic の見出しを右クリックすると、「詳細を開く」「ID をコピー」を出します（エージェントに頼むのは吹き出しから）。

### 雑な指示からチケットを起票する

思いついたままの一言を `/dgimport`（Claude Code の場合）を付けて頼むと、エージェントがコードを調べ、受け入れ条件と依存の付いたチケットの案を出します。承認するとバックログに並びます。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/import.gif" alt="雑な指示からチケットを起票する" width="560">

### エージェントに頼む

行の吹き出しを押して頼むことを選び、コピーした依頼文をエージェントに貼ります。Claude Code 以外には形式を「文章」にします。開いているターミナルを選んで「送る」こともできます。1 行は Enter を押さずに入力へ入ります。複数行は VS Code の貼り付けで入れ、確認が出たら貼り付けるかを選んでください。入力が貼り付けに対応しないと、行ごとに実行されることがあります。

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/ask-agent.gif" alt="エージェントに頼む" width="560">

### 最後まで任せる

Iteration かチケットを `/dgall s3 --auto`（Claude Code の場合）のように付けて頼むと、エージェントが計画・実装を続けて進めます。`/dgall` は作りたいものを起票しないので、先に `/dgimport` でチケットにします。リリース（リリース PR のマージと公開）、チケットの削除・abandoned・done の取り消し、Epic・Iteration の閉じる・再開、`auto.merge` が false のとき、または品質ゲートを満たさない PR のマージ、Plan の待ち（after）と範囲の変更、`--force` を付けた操作、提案の選択肢がない判断、選択肢にできない回答が要るところでは止まって人に聞きます。ほかの判断は、config の `auto.decisions` に入っていれば提案の選択肢で進みます。ボードでは進み具合を見守れ、計画の帯を押すと依存をグラフで見られます。`--gate-high`・`--gate-low`・`--gate-free`（`/dgwork` も同じ引数を取ります）で、対象のチケットの品質ゲートの段を決めます（指定がなければ各チケットの段のまま）。ほかのエージェントには「`dg guide all` を読んで、`--auto` で最後まで進めて」と頼みます。

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

承認待ちの Plan と review のチケットがあると、サイドバーのタイトルが「DEGUBOARD: 承認待ち 3」のように件数つきになり（なければ「DEGUBOARD」）、増えたときは通知が出て「開く」でその詳細が開きます。Activity Bar のアイコンの数字は別物で、未 push のコミットと未取り込みのリモートの更新の合計です（数えるために、1 分に 1 回ほどリモートを fetch します）。

通知は設定画面（歯車）の「通知」で切れます（件数の表示は残ります）。チームの設定のまま自分だけ切るときは、設定画面の「自分」のタブか `--local` を使います（Git に入らない個人の設定。`dg config set --help`）。

```sh
dg config set notify.approvals false --local
```

### 同期の競合を解く

同じチケットの同じ項目を二人が違う値に変えると、`dg sync` は push の前で止まり、競合を知らせます。通知には競合した項目の remote と local の値が並び、「Take remote」「Take local」のボタンが出ます。押した側で `dg sync --resolve` を 1 回呼び、競合した項目だけがその側の値を採ります（ほかの変更と commit は残ります）。採った値と捨てた値は通知に出ます。ターミナルでは `dg sync --resolve remote` か `dg sync --resolve local` を実行します。解くまで push と照合は待ちます。status が同じ（Plan は両側に時刻がある）で `closed_at`・`started_at`・`approved_at` だけが違う競合は止まらず、dg が早い方の時刻を採って警告を出します。エージェント向けの手順は `dg guide overview` の「When sync stops」にあります。

## セキュリティとプライバシー

- 拡張はテレメトリを送らず、HTTP サーバーも起動しません。通信は `git` のリモートへの接続と、`gh` の GitHub への接続だけです。
- データは `.git/deguboard/` に置き、`.git` の外には書きません。
- 拡張が呼ぶコマンドは `git`・`gh`・`dg --version` だけで、どれもシェルを通しません（同期の rebase で git がマージドライバを `sh -c` で動かすのは git の仕様です）。
- git の設定が任意のコマンドを実行させ得るため、信頼したフォルダーでだけ動きます（制限モードと仮想ワークスペースでは動きません）。
- `dg skill install` が書く Skill は `dg guide` を読ませる文面だけで、スクリプトもツールの許可も持ちません。`--dry-run` で中身を見られます。
- `dg hooks install` が書くフックは `dg hook <イベント>` を呼ぶだけで、Run を記録し、`~/.claude/projects/` の下の会話記録を読みます。実行の前に、`dg` を通さない `gh pr ready`・`gh pr merge`（`gh api` での同じ操作も）、`.git/deguboard/` の下に書くファイル編集のツール、`.git/deguboard` の語を含む Bash のコマンドも拒みます。そのときは `dg` のコマンドを使います。`--dry-run` で設定を見られ、`dg hooks uninstall` で外せます。
- 脆弱性の報告先は [SECURITY.md](SECURITY.md) にあります。

## ほかの使い方

### 開発者として使い始める

deguboard 自体を開発する人向けです。[mise](https://mise.jdx.dev/) を入れて clone し、フックを入れます。フックは PATH に頼りません。`dg hooks install` が node と `dg.js` の絶対パスを書きます。

```sh
git clone https://github.com/brainpad-whiterabbit/deguboard.git && cd deguboard
mise trust && mise install    # node・pnpm を mise.toml の版で入れる
mise run install              # 依存を入れ、dg と拡張をビルドし、VSIX を VS Code に入れる
mise run dg -- hooks install  # .claude/settings.local.json に絶対パスでフックを書く（clone ごとに一度。node を上げたらやり直す）
mise run dg -- hooks check    # 新しいセッションで、フックが入っていて dg が受け取っていることを確かめる
mise run dg:link              # 任意：端末から dg を使うために ~/.local/bin/dg にリンクする（PATH の node が 24 以上であること。~/.local/bin が PATH になければ足す）。更新は git pull のあと mise run install
```

VSIX を手で入れるときは、`mise run vsix` の後に `code --install-extension packages/vscode/deguboard-vscode.vsix` を実行します。

### CLI で使う

ボードのほかに、同じ操作をターミナルの `dg` コマンドでも行えます（「導入」の 3 を参照）。

```sh
dg ticket create "ログインの検証" --summary "入力の検査" --acceptance "空のとき拒否する"
dg ticket list                # --json で機械向け
```

Skill を入れずに、`dg ask --format text` で作った文章をエージェントに貼っても同じことを頼めます。

### Claude Desktop から使う（MCP）

`dg mcp` は stdio の MCP サーバーで、`dg` のコマンドを `ticket_create` のような名前のツールとして出します。Claude Desktop は PATH を引き継がずにリポジトリの外で起動するので、`claude_desktop_config.json` では `command` に、拡張が入れる起動ファイル `~/.local/share/deguboard/dg`（node は起動ファイルが自分で探します）を指定し、引数に `-C <対象のリポジトリ>` と `mcp` を渡します。`command` には、その起動ファイルの絶対パスを、ホームディレクトリを省略せずに書きます（macOS は `/Users/<you>/...`、Linux は `/home/<you>/...`。JSON は `~` を展開しません）。Claude Code は Bash で `dg` を呼べるので登録は要りません。

```json
{
  "mcpServers": {
    "deguboard": {
      "command": "/Users/<you>/.local/share/deguboard/dg",
      "args": ["-C", "/path/to/repo", "mcp"]
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

[MIT](LICENSE)。配布物に束ねた依存のライセンスは、ビルドで出る `THIRD_PARTY_LICENSES.md`（VSIX の `dist/`）にまとめています。
