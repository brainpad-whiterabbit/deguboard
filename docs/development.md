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
- worktree は `../deguboard.worktrees/<ブランチ名>` に置く（`dg` の `worktree.root` の既定と同じで、リポジトリの外なので `.gitignore` は要らない）。ブランチ名は `<種類>/<内容>`（例：`docs/branch-strategy`、`feat/ticket-create`、`fix/sync-warning`）。`mise trust` と `node_modules` は worktree ごとに要る。worktree では `mise run setup`（依存とビルドだけ）を使い、`mise run install` は使わない（作業中のブランチの拡張で VS Code の拡張を差し替えてしまう）。`dg ticket claim` は worktree を作るので、手で作るのは claim しない作業のときだけ

  ```sh
  git fetch origin
  git worktree add --no-track -b <ブランチ名> ../deguboard.worktrees/<ブランチ名> origin/main
  cd ../deguboard.worktrees/<ブランチ名> && mise trust && mise run setup
  ```

- PR は `gh pr create --base main` で出し、本文にチケットの ID（`t12`）を書く。このリポジトリの Workflow は software-development なので、PR が開けば `dg sync` が review に、squash マージされれば done に進める（`gh` が要る）
- 画面の見た目を変える PR は、変えた画面のスクリーンショットを本文に載せる。左パネルとパネルの変更は `mise run test:vscode` が VS Code の実機でライトとダークを `test/vscode/screenshots/` に出す（「`packages/vscode`」の節。ほかの画面を撮るときは `test/vscode/sidebar.vscode.ts` に操作を足す）。VS Code を起動せずに撮るときは Playwright MCP で一時リポジトリの `dg serve` を `?surface=` の配置で開き（「`packages/web`」の節）、ライトとダーク（`browser_emulate_media` の `colorScheme`）で撮る。画像は orphan ブランチ `pr-screenshots` の `<チケット ID>/` に置く（作業ブランチに入れると squash で `main` に入る）

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

- マージは `main` の worktree から行う。エージェントは `dg pr merge` で行い（品質ゲートを満たすときだけ gh を呼び、`--delete-branch` なら gh を呼ぶ前に作業ブランチの worktree を消す。worktree は先に消さない）、満たさないままマージするなら人が worktree を消してから `gh pr merge <PR 番号> --squash --delete-branch` を打つ（ブランチを checkout したままだと `gh` がローカルのブランチを消せない）

  ```sh
  mise run dg -- pr merge <チケット ID> --delete-branch
  git pull --ff-only && mise run dg -- sync
  ```

  worktree に未コミットの変更が残っていて `git worktree remove` が止まったら、要るものを退避してから `--force` を付ける

- `dg` 自体の不具合でチケットを動かせないときは、人が `.git/deguboard/` のファイルを直接直し、`mise run dg -- adopt` で取り込んでから（取り込まないと dg の外の変更として書き込みが止まる）、その不具合を起票する

## ビルドとテスト

- TypeScript は ESM（`"type": "module"`）で、相対 import は `.js` の拡張子で書く。`mise run typecheck` は `noEmit` で検査する
- `mise run build` が `tsconfig.build.json`（プロジェクト参照）で `core`・`server`・`cli` を、Vite で `web` と `vscode` を `dist/` に出す。`dg` をリポジトリの外のディレクトリに対して動かすときは `-C <dir>` を付ける
- `@deguboard/core` と `@deguboard/server` の `exports` は条件つきで、テストと型検査・vscode のビルド（`development` 条件）は `src/` を、ビルド済みの `dg` は `dist/` を見る。公開する tarball では `publishConfig.exports` が `development` 条件を外し、`dist/` だけを指す（`mise run pack` で確かめる）。テストの前にビルドは要らない
- テストはソースの隣の `*.test.ts`（画面は `*.test.tsx`）に置き、ルートの `vitest.config.ts` が `packages/*/src/**/*.test.{ts,tsx}` と `test/**/*.test.ts` をまとめて走らせる。パッケージごとの設定ファイルは作らない
- パッケージをまたぐテストは `test/` に置く。`e2e/routes.test.ts` は CLI・HTTP・Webview の 3 経路の結果とコミットの一致（CL-6）を、`layout/` は画面の配置と吹き出しの一覧を（`mise run test:layout`）、`vscode/` は VS Code の実機の左パネルを（`mise run test:vscode`）確かめる（ブラウザと VS Code が要るので check に入れない）
- Git を使うテストは `packages/core/test/helpers/git-fixture.ts` で、一時ディレクトリに bare リモートと 2 つの clone を作って行う。fixture が開発者のグローバル設定と裏の git maintenance からテストを切り離す（方法は fixture のコメント）
- 依存を足すときは `mise exec -- pnpm add <名前>@<版> --filter <パッケージ>` で足し（版は `1.2.3` の完全な形で書く。`pnpm-workspace.yaml` の `savePrefix` で固定の版で書かれるが、`7`・`^7` のような範囲を渡すと範囲のまま書かれる。版を上げるのも `add <名前>@<新しい版>`、削除は `remove`、開発用は `-D` を付ける、ルートに足すときは `--filter` を外す。overrides を変えたときは `mise exec -- pnpm install`）、更新した lockfile もコミットする（`mise run install` は `--frozen-lockfile`）
- package.json にはコメントを置けないので、ほかの依存と揃えずに留めている版の理由はここに書く
  - `packages/vscode` の `engines.vscode` は、拡張ホストが Node 24 になった最初の版（1.123。Electron 42.3、Node 24.15）にする。束ねる core の `engines.node`（>=24）と Vite の `target: "node24"` に揃う。1.122 までは Node 22（1.104 は Electron 37.3、Node 22.18）
  - `@types/vscode` は API が変わった版しか公開されない（DefinitelyTyped の運用。1.120.0 の次は 1.125.0）ので、`engines.vscode` を超えない最新の公開版に固定する。engines と番号が揃わなくても上げない（vsce が engines を超えていないか検査する）
  - ルートの `playwright-core` は安定版にせず、`@playwright/mcp` が依存に完全一致で固定する版（alpha）に揃える。別の版にすると playwright-core が二重に入り、`mise run playwright:install` が入れるブラウザと MCP が使う版がずれる。@playwright/mcp が安定版を要求するようになったら一緒に移す
- oxlint（`.oxlintrc.json`）の `plugins` は既定の組を置き換えるので、使う言語とライブラリの plugin（web の React には `react`）を明示する

## パッケージ

構成と依存の向きは [ADR-007](adr/ADR-007-architecture.md)。`core`・`server`・`cli`・`web`・`vscode` の 5 つ。

### `packages/core`（`@deguboard/core`）

ドメインモデル・ストレージ・Git 操作・ワークフロー・Run・コマンド定義。`src/` のモジュール（ADR-007 の「Core の中の境界」はこの表を参照する）：

| モジュール  | 役割                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`    | Zod のスキーマ（config・Project・Ticket・Epic・Iteration・Plan・Workflow・Run）、ID の解析と採番、Status と前進の順、Run の集計の純粋関数（`metrics.ts`）                                               |
| `storage/`  | frontmatter と YAML の読み書き（コメントとキー順を保つ）、原子的書き込み、`Store`（起動時に走査してメモリ上に索引を作る）、参照の整合                                                                   |
| `workflow/` | 遷移の制約の合成と検査、条件の評価、`reconcile` の評価、定義の検証、同梱テンプレート                                                                                                                    |
| `git/`      | deguboard worktree の用意、取り込みと push、書き込みの 1 単位 `withWrite`、仮番号の振り直し、事実の収集、frontmatter と YAML のマージドライバ（`merge.ts`。SY-4）、経過の読み取り（`history.ts`。CL-7） |
| `run/`      | Run の start・finish と、チケットの操作の書き込みの中で閉じる closeRun。実行中の記録は `deguboard-local/runs/`、二重の start は `locks/runs` のロックで拒む                                             |
| `agents/`   | Agent Adapter（`adapters/` に製品ごと）。会話記録からの使用量の取り込みと、Skill の置き場所（`skillDirs`）。汎用部分は `index.ts` だけを import する                                                    |
| `actions/`  | 登録済みの Action（ライブラリ。コマンドにはしない）。core の公開は `ACTION_NAMES` だけ                                                                                                                  |
| `commands/` | 3 つの入口の正本。`defineCommand` で「名前・Zod の入力・実装」を組にし、`openContext` と `runCommand` で呼ぶ                                                                                            |
| `guide/`    | guide の本文（`guide-*.md`）の読み込み・節の切り出し（`sections.ts`）・config の埋め込み。`dg guide`・`dg next`・`dg brief`・`dg flow next` が写す（ADR-030）                                           |

入口がコマンドを呼ぶ流れ：`openContext({ cwd, actor, actions: ACTION_NAMES })` → `runCommand(findCommand("ticket.create"), ctx, input)`。入力の形の誤りは `UsageError`（終了コード 2）、実行時の失敗は `OperationError`（終了コード 1、`code` に種類）。

### `packages/cli`（npm の `deguboard`、コマンドは `dg`）

core の `commands` を commander（`program.ts`）と MCP のツール（`mcp.ts`）に写す。ロジックは持たない。各ファイルの役割は冒頭のコメントが正本で、引数の型ごとの対応は `options.ts`、`--json` の形は `output.ts`、終了コードは `errors.ts`。

グローバルオプションは `dg --help` が正本。`dg serve` / `dg open`（`serve.ts`）は開発用（配置の確認とスクリーンショット。[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）で、`@deguboard/server` を起動する・ブラウザで開くだけ。`guide-*.md` は `packages/core/src/guide/` にあり、ビルドで core の `dist/guide/` に、拡張の `dist/` に写す（ルートと `packages/vscode` の `build`）。`skill.md` は `dist/` に、web の `dist` は `packages/cli/web` に写す（ルートの `build`）。トピックを足すときは `guide-<トピック>.md` を置き、`packages/core/src/guide/topics.ts` の `GUIDE_TOPICS`（guide の読み込みと config の `guide.notes` が読む）・`guide-overview.md` の表・`packages/core/src/model/schema.test.ts` の `guide.notes.<トピック>` の一覧を直す。Skill を持つトピック（frontmatter に `description`）は `packages/core/src/commands/ask.ts` の `SKILL_SUMMARY` に文を足し、持たないトピックは `packages/cli/src/guide.test.ts` の Skill を持たないトピックの並びに足す。

### `packages/server`（`@deguboard/server`）

core の `commands` を HTTP に写す。Node 標準の `node:http` で、フレームワークは入れない（[ADR-008](adr/ADR-008-tech-stack.md)）。`dg serve` が起動し、既定で `127.0.0.1:7474` に閉じる。

エンドポイントとエラーの HTTP の状態への写し方は `app.ts` が正本。文脈の管理（主体・直列化・再走査）は core の `createLocalClient`（`commands/local.ts` の冒頭）が持ち、`server` と `vscode` はこれを HTTP と postMessage に写すだけ。

### `packages/web`（`@deguboard/web`）

画面の React アプリ。構成の判断は [ADR-008](adr/ADR-008-tech-stack.md)。core からは型と `CommandClient`（`core/commands/client.ts`）だけを取り込む。テストの例外を含む取り込みの範囲は [ADR-007 の「依存の向き」](adr/ADR-007-architecture.md#依存の向き)。`CommandClient` の実装は `client/` に HTTP と postMessage の 2 つ、画面は `pages/`、状態は `store.tsx`、画面の切り替えはハッシュ（`router.ts`）。各ファイルの役割は冒頭のコメントが正本。

型検査は `tsconfig.json` を別に持つ（DOM と JSX が要るため）。ビルドは Vite で `dist/` に出し、`dg serve` は cli に写した `web/` を配信する（`cli/program.ts` の `webDist`）。テストは `// @vitest-environment jsdom` を付け、`test-helpers.ts` の `mockClient` で `CommandClient` を差し替える。

画面の文言は `l10n.ts` の `tr`（鍵は日本語の文。要素を挟む文は `l10n-node.tsx` の `trNode`）で書き、英語の訳は `l10n-en.ts` に置く。言語は Webview の `<html data-language>` で決まり、ない（`dg serve`）と日本語。揃っているかは `l10n.test.ts`、日本語の文言が変わっていないかは `l10n-screens.test.tsx` のスナップショットが確かめる。

見た目は Playwright MCP（`.mcp.json`。Chromium は `mise run playwright:install`）で一時リポジトリの `dg serve` を見る。配置は `?surface=sidebar`（既定）か `panel` で選ぶ（ブラウザだけの配置はない）。Webview に固有の色・CSP・拡張ホストとのやり取りは `mise run test:vscode` で見る（「`packages/vscode`」の節）。

### `packages/vscode`（`deguboard-vscode`）

VS Code 拡張。拡張ホストから core の `createLocalClient` を呼び、Webview に web のビルド結果を載せる。サーバーは起動せず、`dg` は同梱しない（[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）。VS Code の API に触れるのは入口の `extension.ts` だけで、Webview に載せる純粋な処理は `webview.ts`、PATH の `dg` を引くのは `dg.ts`。文言は言語ごとのファイルに置く：manifest は `package.nls.json`（英語・既定）と `package.nls.ja.json`、拡張ホストは `l10n.ts` の `t`（鍵は英語の文）と `l10n/bundle.l10n.ja.json`、Walkthrough は `media/walkthrough/*.md` と `*.ja.md`。揃っているかは `l10n.test.ts` が確かめる。Webview の画面の文言は web に置き（「`packages/web`」の節）、拡張ホストは表示言語を `<html data-language>` で渡すだけ。

ビルドは Vite で `dist/extension.cjs` に束ね、web の `dist` を `dist/web` に写す（[ADR-008](adr/ADR-008-tech-stack.md)）。同梱する core の版は `vite.config.ts` の `define` で埋める。手元で動かすには `mise run build` のあと VS Code で `packages/vscode` を開いて F5（拡張開発ホスト）、Activity Bar の deguboard のアイコン。実機の確認は `mise run test:vscode`：`.vscode-test/` に落とした VS Code（版は `test/vscode/host.ts` で固定）を Xvfb 上に拡張開発ホストとして起動し、一時リポジトリの左パネルで行の表示・詳細のパネル・CSP 違反と例外（あれば落ちる）・ライトとダークのスクリーンショット（`test/vscode/screenshots/`）を確かめる。Claude Code の中からでも動く。細部は `test/vscode/host.ts` の冒頭。

VSIX は `mise run vsix`（`@vscode/vsce`。判断は [ADR-008](adr/ADR-008-tech-stack.md)）で `packages/vscode/deguboard-vscode.vsix` にでき（依存は束ねてあるので `vsce` は `--no-dependencies` で、pnpm の node_modules の形に影響されない）、`mise run vsix:install`（`mise run install` の最後にも走る）で VS Code に入る（入れられないときは手で入れるコマンドを出す。条件は `scripts/install-vsix.mjs` の冒頭。リモート開発なら統合ターミナルから）。入れたらウィンドウを再読み込みする。入るものは `.vscodeignore` が決め、入ってよいファイルの一覧は `packages/vscode/src/vsix-files.test.ts` が `vsce ls` と照らす（一覧にないものが入ると `mise run check` が落ちる。入れるファイルを増やす PR は一覧も直す）。拡張の README（Marketplace の紹介）はルートの README.md の「Other ways to use it」より前を `scripts/vscode-readme.mjs` が写して作り、git には入れない。紹介はルートの README で直し（README.ja.md は拡張の README と npm に入らない）、その部分のリンクは絶対 URL にする（相対リンクがあると作れない）。

README の使い方の GIF（`packages/vscode/images/`）は、画面を変えたら `mise run gifs` で録り直す（台本は `scripts/record-gifs.mjs`）。画面は英語の表示で、1.5 倍の解像度（1140px 幅）で撮る。

## リリース

npm に出すのは `@deguboard/core`・`@deguboard/server`・`deguboard`（cli）の 3 つで、版は全パッケージで揃える（[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）。`vscode` は VSIX で配る。`main` の clean な状態で行う：

```sh
mise run release:version -- <版>    # 版を揃え、PR で main に入れる
mise run check && mise run pack      # release/ に 3 つの tarball（LICENSE が欠ければ、cli に guide-*.md があるか core に dist/guide/ の guide がなければ失敗）
mise run audit                       # 本番の依存の脆弱性（あれば直すか人が判断する）
mise run test:layout && mise run test:vscode   # 画面の配置と VS Code の実機（check に入らない）
mise run release:publish             # npm login 済みで
git tag v<版> && git push origin v<版>
mise run vsix                        # vsix を Release に添付し、出た SHA256 の文を本文に貼る
```

公開は必ず `pnpm publish`（`release:publish`）で行う。`npm publish` では `workspace:*` と `publishConfig.exports` が書き換わらない。

tarball は一時ディレクトリで、cli は package.json の依存、core・server は pnpm-workspace.yaml の `overrides` で `file:` に向けて入れ、`dg --version` と `dg init` を試す（pnpm 12 は package.json の `overrides` を読まない）。
