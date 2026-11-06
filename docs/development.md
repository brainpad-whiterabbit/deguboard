# 開発ガイド

このリポジトリで deguboard を開発する人向けの説明。毎回守る規約（コードの規約、コミット・PR・マージ）は [CLAUDE.md](../CLAUDE.md) にあり、ここには書き写さない。

## 開発の始め方

ツールと作業コマンドは [mise](https://mise.jdx.dev/) に統一している（[ADR-008](adr/ADR-008-tech-stack.md)）。

1. mise を入れる（[公式の手順](https://mise.jdx.dev/getting-started.html)）
2. リポジトリを clone して、その中で次を実行する

```sh
mise trust          # このリポジトリの mise.toml を信頼する
mise install        # node・pnpm を mise.toml の版で入れる
mise run install    # 依存を入れ、dist と VSIX をビルドし、VSIX を VS Code に入れる
```

3. タスクの一覧は `mise tasks` で見られる。タスクは pnpm scripts を呼ぶだけで、定義は [mise.toml](../mise.toml) と [package.json](../package.json)

## チケットと作業の流れ

このリポジトリのチケットは deguboard 自身で管理する（ドッグフーディング）。データは orphan ブランチ `deguboard`（worktree は `.git/deguboard/`）にあり、`dg` でだけ読み書きする。ロードマップは Epic にある（`dg epic list`）。

共通の流れ（起票 → claim → 作業 → PR → 照合 → 完了）は `dg` が出す手順が正本で、ここには書かない。

```sh
mise run dg -- guide work      # 1 枚のチケットを進める流れ
mise run dg -- guide done      # マージ後の後始末
```

このリポジトリに固有の決まり：

- `dg` は `mise run install`・`setup`・`build` のいずれかのあと `mise run dg -- <引数>` で動く。`core`・`server`・`cli` を変えた PR を取り込んだら、もう一度 `mise run build` する
- Claude が呼ぶときは `DEGUBOARD_ACTOR=agent`（CLAUDE.md）。人の操作は既定の human のまま
- worktree は `../deguboard.worktrees/<ブランチ名>` に置く（`dg` の `worktree.root` の既定と同じで、リポジトリの外なので `.gitignore` は要らない）。ブランチ名は `<種類>/<内容>`（例：`docs/branch-strategy`、`feat/ticket-create`、`fix/sync-warning`）。`mise trust` と `node_modules` は worktree ごとに要る。worktree では `mise run setup`（依存とビルドだけ）を使い、`mise run install` は使わない（作業中のブランチの拡張で VS Code の拡張を差し替えてしまう）

  ```sh
  git fetch origin
  git worktree add --no-track -b <ブランチ名> ../deguboard.worktrees/<ブランチ名> origin/main
  cd ../deguboard.worktrees/<ブランチ名> && mise trust && mise run setup
  ```

- PR は `gh pr create --base main` で出し、本文にチケットの ID（`t12`）を書く。このリポジトリの Workflow は software-development なので、PR が開けば `dg sync` が review に、squash マージされれば done に進める（`gh` が要る）
- 画面の見た目を変える PR は、変えた画面のスクリーンショットを本文に載せる。Playwright MCP で一時リポジトリの `dg serve` を開き（「`packages/web`」の節）、ライトとダークで撮る（`browser_emulate_media` の `colorScheme`）。サイドバーに効く変更は `?surface=sidebar` と幅 300px でも撮る。画像は orphan ブランチ `pr-screenshots` の `<チケット ID>/` に置く（作業ブランチに入れると squash で `main` に入る）

  ```sh
  git fetch origin pr-screenshots
  git worktree add --detach ../deguboard.worktrees/pr-screenshots origin/pr-screenshots
  cd ../deguboard.worktrees/pr-screenshots
  mkdir -p t12 && cp <撮った画像> t12/
  git add t12 && git commit -m "t12 のスクリーンショット（PR 用。コードは含まない）"
  git push origin HEAD:pr-screenshots && git rev-parse HEAD
  cd - && git worktree remove ../deguboard.worktrees/pr-screenshots
  ```

  本文には、出たコミット SHA を入れた `![カンバン（ライト）](https://github.com/brainpad-whiterabbit/deguboard/blob/<SHA>/t12/board-light.png?raw=true)` で貼る（SHA で固定し、`?raw=true` で private リポジトリでも出る）。`pr-screenshots` は消さない（PR の画像が切れる）

- マージは `main` の worktree から行う。worktree を先に消す（ブランチを checkout したままだと `gh` がローカルのブランチを消せない）

  ```sh
  git worktree remove ../deguboard.worktrees/<ブランチ名>
  gh pr merge <PR 番号> --squash --delete-branch
  git pull --ff-only && mise run dg -- sync
  ```

  worktree に未コミットの変更が残っていて `git worktree remove` が止まったら、要るものを退避してから `--force` を付ける

- `dg` 自体の不具合でチケットを動かせないときは、`.git/deguboard/` のファイルを直接直してコミットし、その不具合を起票する

## ビルドとテスト

- TypeScript は ESM（`"type": "module"`）で、相対 import は `.js` の拡張子で書く。`mise run typecheck` は `noEmit` で検査する
- `mise run build` が `tsconfig.build.json`（プロジェクト参照）で `core`・`server`・`cli` を、Vite で `web` と `vscode` を `dist/` に出す。`dg` をリポジトリの外のディレクトリに対して動かすときは `-C <dir>` を付ける
- `@deguboard/core` と `@deguboard/server` の `exports` は条件つきで、テストと型検査・vscode のビルド（`development` 条件）は `src/` を、ビルド済みの `dg` は `dist/` を見る。公開する tarball では `publishConfig.exports` が `development` 条件を外し、`dist/` だけを指す（`mise run pack` で確かめる）。テストの前にビルドは要らない
- テストはソースの隣の `*.test.ts`（画面は `*.test.tsx`）に置き、ルートの `vitest.config.ts` が `packages/*/src/**/*.test.{ts,tsx}` と `test/**/*.test.ts` をまとめて走らせる。パッケージごとの設定ファイルは作らない
- パッケージをまたぐテストは `test/` に置く。`e2e/routes.test.ts` は CLI・HTTP・Webview の 3 経路の結果とコミットの一致（NF-2）を、`layout/` は画面の配置と吹き出しの一覧を確かめる（`mise run test:layout`。ブラウザが要るので check に入れない）
- Git を使うテストは `packages/core/test/helpers/git-fixture.ts` で、一時ディレクトリに bare リモートと 2 つの clone を作って行う。fixture が開発者のグローバル設定と裏の git maintenance からテストを切り離す（方法は fixture のコメント）
- 依存を足すときは `mise exec -- pnpm add <名前>@<版> --filter <パッケージ>` で足し（版は `1.2.3` の完全な形で書く。`pnpm-workspace.yaml` の `savePrefix` で固定の版で書かれるが、`7`・`^7` のような範囲を渡すと範囲のまま書かれる。版を上げるのも `add <名前>@<新しい版>`、削除は `remove`、開発用は `-D` を付ける、ルートに足すときは `--filter` を外す。overrides を変えたときは `mise exec -- pnpm install`）、更新した lockfile もコミットする（`mise run install` は `--frozen-lockfile`）

## パッケージ

構成と依存の向きは [ADR-007](adr/ADR-007-architecture.md)。`core`・`server`・`cli`・`web`・`vscode` の 5 つ。

### `packages/core`（`@deguboard/core`）

ドメインモデル・ストレージ・Git 操作・ワークフロー・Run・コマンド定義。`src/` のモジュール（ADR-007 の「Core の中の境界」はこの表を参照する）：

| モジュール  | 役割                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`    | Zod のスキーマ（config・Project・Ticket・Epic・Iteration・Plan・Workflow・Run）、ID の解析と採番、Status と前進の順、Run の集計の純粋関数（`metrics.ts`）                                       |
| `storage/`  | frontmatter と YAML の読み書き（コメントとキー順を保つ）、原子的書き込み、`Store`（起動時に走査してメモリ上に索引を作る）、参照の整合                                                           |
| `workflow/` | 遷移の制約の合成と検査、条件の評価、`reconcile` の評価、定義の検証、同梱テンプレート                                                                                                            |
| `git/`      | deguboard worktree の用意、取り込みと push、書き込みの 1 単位 `withWrite`、仮番号の振り直し、事実の収集、frontmatter のマージドライバ（`merge.ts`。SY-4）、経過の読み取り（`history.ts`。CL-7） |
| `run/`      | Run の start・finish と、チケットの操作の書き込みの中で閉じる closeRun。実行中の記録は `deguboard-local/runs/`、二重の start は `locks/runs` のロックで拒む                                     |
| `agents/`   | Agent Adapter（`adapters/` に製品ごと）。会話記録からの使用量の取り込みと、Skill の置き場所（`skillDirs`）。汎用部分は `index.ts` だけを import する                                            |
| `actions/`  | 登録済みの Action（ライブラリ。コマンドにはしない）。core の公開は `ACTION_NAMES` だけ                                                                                                          |
| `commands/` | 3 つの入口の正本。`defineCommand` で「名前・Zod の入力・実装」を組にし、`openContext` と `runCommand` で呼ぶ                                                                                    |

入口がコマンドを呼ぶ流れ：`openContext({ cwd, actor, actions: ACTION_NAMES })` → `runCommand(findCommand("ticket.create"), ctx, input)`。入力の形の誤りは `UsageError`（終了コード 2）、実行時の失敗は `OperationError`（終了コード 1、`code` に種類）。

### `packages/cli`（npm の `deguboard`、コマンドは `dg`）

core の `commands` を commander（`program.ts`）と MCP のツール（`mcp.ts`）に写す。ロジックは持たない。各ファイルの役割は冒頭のコメントが正本で、引数の型ごとの対応は `options.ts`、`--json` の形は `output.ts`、終了コードは `errors.ts`。

グローバルオプションは `dg --help` が正本。`dg serve` / `dg open`（`serve.ts`）は `@deguboard/server` を起動する・ブラウザで開くだけ。`guide-*.md` と `skill.md` はビルドで `dist/` に、web の `dist` は `packages/cli/web` に写す（ルートの `build`）。トピックを足すときは `guide.ts` の `GUIDE_TOPICS` と `guide-overview.md` の表も直す。

### `packages/server`（`@deguboard/server`）

core の `commands` を HTTP に写す。Node 標準の `node:http` で、フレームワークは入れない（[ADR-008](adr/ADR-008-tech-stack.md)）。`dg serve` が起動し、既定で `127.0.0.1:7474` に閉じる。

エンドポイントとエラーの HTTP の状態への写し方は `app.ts` が正本。文脈の管理（主体・直列化・再走査）は core の `createLocalClient`（`commands/local.ts` の冒頭）が持ち、`server` と `vscode` はこれを HTTP と postMessage に写すだけ。

### `packages/web`（`@deguboard/web`）

画面の React アプリ。構成の判断は [ADR-008](adr/ADR-008-tech-stack.md)。core からは型と `CommandClient`（`core/commands/client.ts`）だけを取り込む。テストの例外を含む取り込みの範囲は [ADR-007 の「依存の向き」](adr/ADR-007-architecture.md#依存の向き)。`CommandClient` の実装は `client/` に HTTP と postMessage の 2 つ、画面は `pages/`、状態は `store.tsx`、画面の切り替えはハッシュ（`router.ts`）。各ファイルの役割は冒頭のコメントが正本。

型検査は `tsconfig.json` を別に持つ（DOM と JSX が要るため）。ビルドは Vite で `dist/` に出し、`dg serve` は cli に写した `web/` を配信する（`cli/program.ts` の `webDist`）。テストは `// @vitest-environment jsdom` を付け、`test-helpers.ts` の `mockClient` で `CommandClient` を差し替える。

画面の文言は `l10n.ts` の `tr`（鍵は日本語の文。要素を挟む文は `l10n-node.tsx` の `trNode`）で書き、英語の訳は `l10n-en.ts` に置く。言語は Webview の `<html data-language>` で決まり、ない（`dg serve`）と日本語。揃っているかは `l10n.test.ts`、日本語の文言が変わっていないかは `l10n-screens.test.tsx` のスナップショットが確かめる。

見た目は Playwright MCP（`.mcp.json`。Chromium は `mise run playwright:install`）で一時リポジトリの `dg serve` を見る。`?surface=sidebar`・`panel` で配置が変わる。Webview に固有の色や CSP は人が見る。

### `packages/vscode`（`deguboard-vscode`）

VS Code 拡張。拡張ホストから core の `createLocalClient` を呼び、Webview に web のビルド結果を載せる。サーバーは起動せず、`dg` は同梱しない（[ADR-006](adr/ADR-006-ui-and-writes.md)）。VS Code の API に触れるのは入口の `extension.ts` だけで、Webview に載せる純粋な処理は `webview.ts`、PATH の `dg` を引くのは `dg.ts`。文言は言語ごとのファイルに置く：manifest は `package.nls.json`（英語・既定）と `package.nls.ja.json`、拡張ホストは `l10n.ts` の `t`（鍵は英語の文）と `l10n/bundle.l10n.ja.json`、Walkthrough は `media/walkthrough/*.md` と `*.ja.md`。揃っているかは `l10n.test.ts` が確かめる。Webview の画面の文言は web に置き（「`packages/web`」の節）、拡張ホストは表示言語を `<html data-language>` で渡すだけ。

ビルドは Vite で `dist/extension.cjs` に束ね、web の `dist` を `dist/web` に写す（[ADR-008](adr/ADR-008-tech-stack.md)）。同梱する core の版は `vite.config.ts` の `define` で埋める。手元で動かすには `mise run build` のあと VS Code で `packages/vscode` を開いて F5（拡張開発ホスト）、Activity Bar の deguboard のアイコン。

VSIX は `mise run vsix`（`@vscode/vsce`。判断は [ADR-008](adr/ADR-008-tech-stack.md)）で `packages/vscode/deguboard-vscode.vsix` にでき、`mise run vsix:install`（`mise run install` の最後にも走る）で VS Code に入る（入れられないときは手で入れるコマンドを出す。条件は `scripts/install-vsix.mjs` の冒頭。リモート開発なら統合ターミナルから）。入れたらウィンドウを再読み込みする。入るものは `.vscodeignore` が決め、入ってよいファイルの一覧は `packages/vscode/src/vsix-files.test.ts` が `vsce ls` と照らす（一覧にないものが入ると `mise run check` が落ちる。入れるファイルを増やす PR は一覧も直す）。拡張の README（Marketplace の紹介）はルートの README.md の「Other ways to use it」より前を `scripts/vscode-readme.mjs` が写して作り、git には入れない。紹介はルートの README で直し（README.ja.md は拡張の README と npm に入らない）、その部分のリンクは絶対 URL にする（相対リンクがあると作れない）。

README の使い方の GIF（`packages/vscode/images/`）は、画面を変えたら `mise run gifs` で録り直す（台本は `scripts/record-gifs.mjs`）。

## リリース

npm に出すのは `@deguboard/core`・`@deguboard/server`・`deguboard`（cli）の 3 つで、版は全パッケージで揃える（[ADR-006](adr/ADR-006-ui-and-writes.md)）。`web` は cli に同梱し、`vscode` は VSIX で配る。手順は mise のタスクで、`main` の clean な状態で行う：

```sh
mise run release:version -- <版>    # 5 パッケージの version を揃える（例: 0.10.0）→ PR で main に入れる
mise run check && mise run pack      # build のあと release/ に 3 つの tarball。別ディレクトリで入れて dg --version と dg init を試す
mise run audit                       # 本番の依存の既知の脆弱性を検査する（ネットワークが要る。あれば失敗するので、直すか人が判断してから進める）
mise run test:layout                 # build のあと画面の配置と吹き出しの一覧（check に入らない。ブラウザがなければ先に mise run playwright:install）
mise run release:publish             # pnpm publish -r --access public（npm login 済みで）
git tag v<版> && git push origin v<版>
mise run vsix                        # GitHub の Release に deguboard-vscode.vsix を添付する
sha256sum packages/vscode/deguboard-vscode.vsix   # 出た値を Release の本文に書く（下の雛形）
```

Release の本文には、添付する vsix の SHA256 を次の雛形で書く。値は上の `sha256sum` の出力のもの（添付と同じ vsix で求める）。

```text
deguboard-vscode.vsix の SHA256：<sha256sum の 64 桁の値>

確かめ方：vsix と同じフォルダで `sha256sum deguboard-vscode.vsix` を実行し、出た値が上の値と一致すれば改ざんされていない。
```

3 つの tarball には、`prepack`（各パッケージの package.json）がルートの LICENSE を写して入れる（VSIX の `package` と同じ。写した `packages/*/LICENSE` は `.gitignore` で Git に入れない）。tarball を試すときは `for f in release/*.tgz; do tar tzf "$f" | grep -q '^package/LICENSE$' && echo "ok $f"; done` を 1 つずつ回し、3 行の ok が出ることを確かめる（`tar tzf` は複数の tgz を一度に渡せない）。

`release/` は `mise run pack` が置く生成物で、`.gitignore` により Git には入れない。`pack` は毎回 `release/` を消してから作るので、手元に残った古い版の tarball は消してよい。

公開は必ず `pnpm publish`（`release:publish`）で行う。`workspace:*` の版への書き換えと `publishConfig.exports` の差し替えは pnpm だけが行い、`npm publish` では `src/` を指す `development` 条件が残る。

tarball を試すときは、一時ディレクトリの package.json の `deguboard` と、そこに置いた pnpm-workspace.yaml の `overrides` の `@deguboard/core`・`@deguboard/server` を `file:` の tarball に向ける（pnpm 12 は package.json の `overrides`・`pnpm.overrides` を読まない）。
