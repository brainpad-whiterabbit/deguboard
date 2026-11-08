# ADR-027 人の画面は VS Code 拡張にし、画面から書くのはチケット詳細と設定だけで、ほかはエージェントに頼む

- ステータス：承認
- 更新日：2026-11-08

## 背景

カンバン・バックログ・詳細を人が見て直す画面について、画面の構成と配り方を [ADR-006](ADR-006-ui-and-writes.md) が、画面から書く範囲とエージェントへの依頼を [ADR-010](ADR-010-ui-writes-and-agent-requests.md) が、入口を VS Code 拡張に絞ることを [ADR-023](ADR-023-screen-entry-vscode.md) が決めた。ADR-010 は ADR-006 の書き込みの範囲を反転し、ADR-023 は ADR-006 と ADR-010 のブラウザの部分を失効させたので、今の判断を知るのに 3 本を照らす必要があった。ADR-006 の採らなかった案と理由には、失効の印のないままブラウザを入口とする記述も残った。[ADR-001](ADR-001-doc-strategy.md) の基準で、今の判断と理由だけをこの 1 本にまとめ直す。

## 決定

### 人の画面の入口は VS Code 拡張にし、ブラウザは開発用にする

- 人が使う画面は VS Code 拡張（サイドバーとエディタのパネル）だけにする。エージェントは CLI（`dg`）と MCP（`dg mcp`）から使う
- `dg serve` は利用者の入口にせず、開発用（配置の確認・録画・Playwright MCP での確認）に残す。既定で `127.0.0.1` にバインドし、認証は持たない（UI-8）
- Run の画面は置かない。Run はチケット詳細の Run の節で、実績の集計は `dg metrics show` で見る

### 画面は 1 つの React アプリを `CommandClient` で Core につなぐ

- 画面は 1 つの React アプリ（`packages/web`）で作り、サイドバーとエディタのパネルの Webview に載せる。サイドバーを主画面にし、パネルには詳細だけを開く（UI-12）
- アプリは `CommandClient` という 1 つのインターフェースだけを通じて Core を呼ぶ。Webview では拡張ホストが `postMessage` を受けて Core を直接呼び、拡張はサーバーを起動しない
- 画面の外への働きかけ（遷移・コピー・ウィンドウやエディタを開く・ターミナルへの送信）も `postMessage` に core が決めた形で通し、拡張ホストが行う
- テーマは VS Code の CSS 変数を基準にする

### `dg` は npm で配り、拡張は `dg` を同梱しない

- `dg` は npm で配る。cli が依存する `core` と `server` も同じ版で公開し、画面のビルド結果は cli のパッケージに同梱する
- 拡張は `core` と `web` だけを同梱し、画面の閲覧と操作は `dg` なしで動く。`dg` は PATH から引き、ないときと版のメジャーが同梱の `core` と違うときは知らせる（UI-11）

### 画面から直接書くのはチケット詳細と設定画面と同期だけにする

- チケット詳細ではタイトル・本文・Status・属性と受け入れ条件の印を直せる。設定画面はチームの `config.yaml` と個人の上書きを書く。同期（UI-6）は Git の事実に合わせるだけなので残す
- ほかの書き込み（ドラッグでの移動、Iteration・Epic の作成・開始・閉じる・再開とチケットの足し外し、Plan の承認と閉じる）は画面に置かず、エージェントに頼む
- 書き込みは CLI と同じ Core のコマンド（`core/commands`）と検査を通り、画面だけの近道を作らない。画面からの操作の主体は常に human（[ADR-004](ADR-004-agents-and-state.md)）

### 設定はチームのファイルと個人の上書きで持ち、VS Code の settings.json を使わない

- 設定はチームで共有する `config.yaml` を基本にし、人ごとに違ってよい項目だけを Git に入らない `deguboard-local/config.yaml` で上書きできる。読むのは Core で、CLI・拡張・`dg serve` は同じ値を見る
- エージェントに許す操作のうち記録と PR に関わる項目は、チーム専用にする

### 画面の操作のコミットはまとめる

- `commit.mode` でコミットの単位を、`push.mode` で push の時期を選び、既定はまとめてコミットする `batch` にする
- claim・作成・Iteration の開始と再開は、mode によらず即座にコミットして push する（排他と採番。[ADR-002](ADR-002-storage-and-id.md)・[ADR-004](ADR-004-agents-and-state.md)）

### ほかの変更はエージェントへの依頼文を作り、コピーか開いているターミナルへの送り込みで渡す

- 画面は、対象（複数可）と頼むことと指示から依頼文を作ってコピーするか、すでに開いているターミナルの入力へ Enter を押さずに送るだけで、データには書き込まない。ターミナルもエージェントも起動しない（EX-1）
- 依頼文は Core の読み取りだけのコマンド（`ask`）が作り、CLI・HTTP・Webview から同じ結果を返す。依頼文に入れる対象は ID だけにする
- 形式は Skill の呼び出しと、Skill を使わないエージェント向けの文章だけの 2 つにする。文章だけの形は、Skill と同じ手順で進むよう `dg guide <topic>` を読ませる
- 人に限った操作（`actor.human_only` と Workflow の `by`）に当たる頼むことは、依頼文の代わりに人が打つ `dg` のコマンドを出す
- 定型の文は画面の表示言語で組み、指示とチケットの中身は書いた言葉のままにする

### 頼む入口は行・見出し・詳細のタイトルの吹き出しにする

- 頼む入口は、画面の行・見出し・詳細のタイトルの吹き出しに置く。候補とおすすめは Core（`ask-menu`）が対象と場所から決め、画面では組み立て直さない
- 右クリックのメニューには頼む入口を置かない

### 細部の正本

画面の並び・文言・タブ・札・キーの割り当て、依頼文の文の組み立てと形式の既定、ターミナルへの送り方、設定画面の書き分けと保存前の確かめ、各項目の範囲（scope）は、次のコードとテストが正本で、「なぜ」はそのコメントとテスト名にある。

- 入口と構成：`packages/vscode/src/extension.ts`・`webview.ts`・`dg.ts`・`packages/web/src/main.tsx`・`host.tsx`・`client/webview.ts`・`client/http.ts`・`styles.css`・`packages/core/src/commands/client.ts`・`local.ts`・`packages/cli/src/serve.ts`
- 書き込みの範囲と設定：`packages/web/src/write-commands.test.ts`・`pages/ticket.tsx`・`components/ticket-props-panel.tsx`・`pages/config.tsx`・`packages/core/src/model/config.ts`・`packages/core/src/git/write.ts`
- 依頼と入口：`packages/core/src/commands/ask.ts`（`ask`・`ask-menu`・`SKILL_SUMMARY`）・`packages/web/src/components/ask-menu.tsx`・`ask-composer.tsx`・`row-nav.tsx`・`packages/vscode/src/terminals.ts`・`context-menu.ts`
- テスト：`packages/core/src/commands/ask.test.ts`・`client.test.ts`・`local.test.ts`・`packages/web/src/app.test.tsx`・`pages/config.test.tsx`・`components/ask-menu.test.tsx`・`ask-composer.test.tsx`・`packages/vscode/src/terminals.test.ts`・`context-menu.test.ts`・`dg.test.ts`・`test/layout/`

### 置き換えるもの

- ADR-006・ADR-010・ADR-023 の全体

## 理由

- e13 で対象をソフトウェア開発に絞り、VS Code を使わない利用者のためにブラウザを残す理由がなくなった。人の画面を 1 つにすれば、ブラウザと VS Code の作りの差と、利用者向けの画面の保守が 1 つになる
- `dg serve` を開発用に残せば、配置の確認・録画・MCP での確認の経路を失わない。localhost に閉じれば、認証なしでも他のマシンから触れない
- 画面を 1 つのアプリにして transport だけを `CommandClient` で差し替えれば、機能の追加と修正が 1 回で済み、Webview と HTTP の違いは画面に漏れない。拡張ホストは Core を直接呼べるので、サーバーを立てる理由がない
- サイドバーはエディタで何を開いていても見え、幅が狭いので一覧に向く。詳細は本文と属性を並べるのでエディタ領域の幅が要る
- `dg` の実体が 1 つなら版ずれが起きず、VS Code を使わないエージェントにも同じ `dg` が届く。拡張が `dg` に依存しなければ、エージェントを使わない利用者も拡張を入れるだけで閲覧とチケット詳細の編集ができる
- 起票・割り当て・計画・作業・片付けは Skill の手順に点検・承認・照合がある。画面から Iteration・Epic・Status を直接変えるとその外で状態が変わり、Plan の帯や照合と食い違う。書き込みの入口がチケット詳細とエージェントに絞られれば（設定と同期を除く）、変わった場所を追いやすい
- チケット詳細の編集は、開いた 1 件を確かめながらの小さな直しで、手順を通すほどではない。設定はチームのデータではなく道具の設定。書き込みを Core に通せば、CLI と同じ保証が効く
- VS Code の settings.json に置くと CLI とエージェントに届かず、同じ項目の値が入口で食い違う。上書きがないと、worktree の置き場所・使えるモデル・通知のように人ごとに違う値をチームのファイルで取り合う
- 画面の操作は頻繁で小さく、1 操作 1 コミットでは履歴が埋まる。排他と採番に関わる操作だけ即座にする
- コピーと開いているターミナルへの送り込みだけなら、エージェントの製品（Claude Code・Codex・MCP のクライアント）に依存せず、起動を扱わない方針（EX-1）を保てる。人に限った操作は依頼しても拒否されるので、人が打つコマンドを出す
- ID だけなら依頼文が短く、題や本文の古い写しが残らない。エージェントは `dg` で読める。英語の画面から日本語の定型の文が渡らないよう、表示言語で組む
- 吹き出しは VS Code のツリーの行の操作ボタンと同じ出し方で、右クリックのメニューは文言が拡張の定義に固定されて対象に合わせられない

## 採らなかった案

- **ブラウザの画面を利用者の入口に残し、両方を提供する**：VS Code を使わない業務はなくなり、残すと作りの差と二重の保守が続く
- **`dg serve` を削除する**：配置の確認・録画・Playwright MCP での確認が止まる
- **サイドバーとパネル（か Web と VS Code）で別の画面を作る**：機能のずれと二重の保守が起きる
- **詳細もサイドバーの中で開く**：狭い幅に本文と属性を押し込み、一覧に戻る操作も増える
- **一覧の画面をパネルに出すコマンドを持つ**：一覧が 2 つ並んでも見るものが重なるだけ
- **VS Code 拡張もローカルサーバー経由にする**：ポートの衝突と起動順の問題が増える
- **拡張が `core` を同梱せず、`dg` を子プロセスで呼ぶ**：`dg` がないと画面が動かなくなる
- **VSIX に `dg` を同梱して PATH に足す**：PATH の注入は統合ターミナルにしか効かず、Claude Code の拡張が起動する `claude` に届かない
- **個人の設定を VS Code の settings.json に置く**：CLI とエージェントに届かず、入口で値が食い違う
- **画面の操作ごとに即コミットする**：履歴が埋まり、push の衝突も増える
- **画面から書き込めるまま、依頼文も足す**：手順の外の変更が残り、書き込みの入口が増える
- **チケット詳細も表示だけにする**：1 件の小さな直しまで手順を通すと手間が大きい
- **ドラッグを残し、落とすと依頼文を作る**：動かしたのにカードが元に戻るので分かりにくい
- **コピーの後に Claude Code やターミナルを起動して送り込む**：特定の製品に依存し、エージェントとターミナルの起動に踏み込む（EX-1）
- **依頼文に題・本文・Status を含める**：長くなり、古い本文が写る
- **Skill の形にも説明の文と対象の一覧（ID・題・Status・Iteration）を添える**：貼る文が長く、人が読み返す前に Skill の手順と食い違う
- **Run の画面を VS Code に作る**：Run は詳細と `dg metrics show` で足りる
