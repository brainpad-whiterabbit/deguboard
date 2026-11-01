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

- `dg` は `mise run install` か `mise run build` のあと `mise run dg -- <引数>` で動く。`core`・`server`・`cli` を変えた PR を取り込んだら、もう一度 `mise run build` する
- Claude が呼ぶときは `DEGUBOARD_ACTOR=agent`（CLAUDE.md）。人の操作は既定の human のまま
- worktree は `../deguboard.worktrees/<ブランチ名>` に置く（`dg` の `worktree.root` の既定と同じで、リポジトリの外なので `.gitignore` は要らない）。ブランチ名は `<種類>/<内容>`（例：`docs/branch-strategy`、`feat/ticket-create`、`fix/sync-warning`）。`mise trust` と `node_modules` は worktree ごとに要る

  ```sh
  git fetch origin
  git worktree add --no-track -b <ブランチ名> ../deguboard.worktrees/<ブランチ名> origin/main
  cd ../deguboard.worktrees/<ブランチ名> && mise trust && mise run install
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
- `@deguboard/core` と `@deguboard/server` の `exports` は条件つきで、テストと型検査・vscode のビルド（`development` 条件）は `src/` を、ビルド済みの `dg` は `dist/` を見る。公開する tarball では `publishConfig.exports` が `development` 条件を外し、`dist/` だけを指す（`pnpm pack` で確かめる）。テストの前にビルドは要らない
- テストはソースの隣の `*.test.ts`（画面は `*.test.tsx`）に置き、ルートの `vitest.config.ts` が `packages/*/src/**/*.test.{ts,tsx}` と `test/**/*.test.ts` をまとめて走らせる。パッケージごとの設定ファイルは作らない
- パッケージをまたぐテストは `test/` に置く。`e2e/routes.test.ts` は CLI・HTTP・Webview の 3 経路の結果とコミットの一致（NF-2）を、`layout/` は画面の配置とドラッグを確かめる（`mise run test:layout`。ブラウザが要るので check に入れない）
- Git を使うテストは `packages/core/test/helpers/git-fixture.ts` で、一時ディレクトリに bare リモートと 2 つの clone を作って行う。開発者のグローバル設定に影響されないよう、fixture が `GIT_CONFIG_GLOBAL=/dev/null` と `GIT_CONFIG_NOSYSTEM=1` を与える。後片付けの rm が裏の git maintenance と競合しないよう、環境変数（`GIT_CONFIG_COUNT`）で `maintenance.auto` と `gc.auto` を止め、bare リモートには `receive.autogc false` も設定し、rm は再試行させる
- 依存を足すときは `pnpm install` で lockfile を更新してからコミットする（`mise run install` は `--frozen-lockfile`）

## パッケージ

構成と依存の向きは [ADR-007](adr/ADR-007-architecture.md)。`core`・`server`・`cli`・`web`・`vscode` の 5 つ。

### `packages/core`（`@deguboard/core`）

ドメインモデル・ストレージ・Git 操作・ワークフロー・Run・コマンド定義。`src/` のモジュール：

| モジュール  | 役割                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`    | Zod のスキーマ（config・Project・Ticket・Epic・Iteration・Plan・Workflow・Run）、ID の解析と採番、Status と前進の順、Run の集計の純粋関数（`metrics.ts`）                                       |
| `storage/`  | frontmatter と YAML の読み書き（コメントとキー順を保つ）、原子的書き込み、`Store`（起動時に走査してメモリ上に索引を作る）、参照の整合                                                           |
| `workflow/` | 遷移の制約の合成と検査、条件の評価、`reconcile` の評価、定義の検証、同梱テンプレート                                                                                                            |
| `git/`      | deguboard worktree の用意、取り込みと push、書き込みの 1 単位 `withWrite`、仮番号の振り直し、事実の収集、frontmatter のマージドライバ（`merge.ts`。SY-4）、経過の読み取り（`history.ts`。CL-7） |
| `run/`      | Run の start・finish。実行中の記録は `deguboard-local/runs/`、二重の start は `locks/runs` のロックで拒む                                                                                       |
| `agents/`   | Agent Adapter（`adapters/claude-code.ts`）。`run finish` が会話記録から使用量を取り込む。汎用部分は `index.ts` だけを import する                                                               |
| `actions/`  | 登録済みの Action（ライブラリ。コマンドにはしない）。core の公開は `ACTION_NAMES` だけ                                                                                                          |
| `commands/` | 3 つの入口の正本。`defineCommand` で「名前・Zod の入力・実装」を組にし、`openContext` と `runCommand` で呼ぶ                                                                                    |

入口がコマンドを呼ぶ流れ：`openContext({ cwd, actor, actions: ACTION_NAMES })` → `runCommand(findCommand("ticket.create"), ctx, input)`。入力の形の誤りは `UsageError`（終了コード 2）、実行時の失敗は `OperationError`（終了コード 1、`code` に種類）。

### `packages/cli`（npm の `deguboard`、コマンドは `dg`）

core の `commands` を commander に写す。ロジックは持たない。`src/` のファイル：

| ファイル     | 役割                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `program.ts` | `commands` から `dg <群> <操作>` の木を組み立てる。`setup` 群（init・sync・commit・validate・lint）はトップレベル。`sprint` は alias                                                             |
| `options.ts` | Zod の入力スキーマから位置引数とオプションを作り、解析した引数を入力オブジェクトに戻す。型ごとの対応は冒頭のコメントが正本                                                                       |
| `output.ts`  | 人向けの出力（list は表、show は `key: value` と本文）と `--json`（`{ ok, data, warnings, write }` / `{ ok: false, error }`）                                                                    |
| `errors.ts`  | `DeguboardError` と commander のエラーを stderr と終了コード（0 / 1 / 2）に写す                                                                                                                  |
| `mcp.ts`     | `dg mcp`。`createLocalClient` を主体 agent で開き、コマンドを MCP のツールに写す。入力スキーマは `server` の `describeCommands`                                                                  |
| `skill.ts`   | `dg skill install`。guide の frontmatter と隣の `skill.md`（`dg guide` を読む薄い Skill の型）から `dg<トピック>` の Skill を作り、`.claude/skills/`（`--personal` で `~/.claude/skills`）に書く |
| `guide.ts`   | `dg guide <topic>`。隣の `guide-*.md`（手順の正本。CL-5）を読み、`{{choices}}` を共通の節に、`{{git.base_branch}}` のような項目を config の値に置き換えて出す                                    |

グローバルオプションは `dg --help` が正本。`dg serve` / `dg open`（`serve.ts`）は `@deguboard/server` を起動する・ブラウザで開くだけ。`guide-*.md` と `skill.md` はビルドで `dist/` に、web の `dist` は `packages/cli/web` に写す（ルートの `build`）。トピックを足すときは `guide.ts` の `GUIDE_TOPICS` と、`guide-overview.md`・`skill.md` の表も直す。

### `packages/server`（`@deguboard/server`）

core の `commands` を HTTP に写す。Node 標準の `node:http` で、フレームワークは入れない（[ADR-008](adr/ADR-008-tech-stack.md)）。`dg serve` が起動し、既定で `127.0.0.1:7474` に閉じる。

エンドポイントは `app.ts` の冒頭のコメントが正本。

- エラーは HTTP の状態に写す：入力の誤り 400、`NOT_FOUND` 404、初期化前 503、それ以外の拒否 409、想定外 500。本文は `{ ok: false, error: { code, message, detail? } }`
- 文脈の管理は core の `createLocalClient`（`commands/local.ts`）が持つ：画面からの操作は常に人（[ADR-006](adr/ADR-006-ui-and-writes.md)）、`init` は出さない、呼び出しは 1 つずつ順に処理し、毎回 `Store.rescan()` で他のプロセスの変更を取り込む。`server` と `vscode` はこれを HTTP と postMessage に写すだけ

### `packages/web`（`@deguboard/web`）

画面の React アプリ。構成の判断は [ADR-008](adr/ADR-008-tech-stack.md)。core からは型と `CommandClient`（`core/commands/client.ts`）だけを取り込み、実行時のコードは取り込まない（`import type` だけ。Vite が node のモジュールを束ねないため）。`src/` のファイル：

| ファイル            | 役割                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `client/http.ts`    | `CommandClient` の HTTP 実装。`/api/commands/<name>` と `/api/status` を呼び、失敗は `ClientError`（code と message）          |
| `client/webview.ts` | postMessage 実装。形は core の `WebviewRequest` / `WebviewResponse` / `WebviewEvent`                                           |
| `app.tsx`           | 骨組み。上のバー（Project と画面の切り替え・同期の印）と、ハッシュで選んだページ                                               |
| `host.tsx`          | `surface` と、チケットをエディタで開く働きかけ。拡張ホストからの通知（同期・遷移）を store に結ぶ                              |
| `store.tsx`         | 選んだ Project のチケット・Epic・Iteration・Plan・Workflow と同期の状態を読み、書き込み（`run`）のあとに読み直す               |
| `router.ts`         | ハッシュの解析（`#/board?epic=e1`、`#/tickets/t12` など）                                                                      |
| `pages/`            | カンバン（UI-2）・バックログ（UI-3）・チケット詳細（UI-4）・Epic（UI-10）・Iteration（UI-5）・履歴（UI-5）・Run と集計（UI-9） |
| `components/`       | 小さな表示部品（チケットへのリンク、優先度・Status の印、ラベル、進捗）と、チケット詳細の節（経過・Run）                       |
| `ui-state.ts`       | 見た目の状態（節の開閉・最後に選んだ Iteration）。Webview では `getState` / `setState`、ブラウザでは `localStorage` に置く     |
| `markdown.tsx`      | 本文の最小の Markdown（見出し・段落・箇条書き・チェックリスト・インラインコード）                                              |
| `styles.css`        | `--vscode-*` 変数を基準にしたテーマ。`:root` の値はブラウザで開いたときの既定で、Webview では VS Code の値が勝つ               |

型検査は `tsconfig.json` を別に持つ（DOM と JSX が要るため）。ビルドは Vite で `dist/` に出し、`dg serve` は cli に写した `web/` を配信する（`cli/program.ts` の `webDist`）。テストは `// @vitest-environment jsdom` を付け、`test-helpers.ts` の `mockClient` で `CommandClient` を差し替える。

見た目は Playwright MCP（`.mcp.json`。Chromium は `mise run playwright:install`）で一時リポジトリの `dg serve` を見る。`?surface=sidebar`・`panel` で配置が変わる。Webview に固有の色や CSP は人が見る。

### `packages/vscode`（`deguboard-vscode`）

VS Code 拡張。拡張ホストから core の `createLocalClient` を呼び、Webview に web のビルド結果を載せる。サーバーは起動せず、`dg` は同梱しない（[ADR-006](adr/ADR-006-ui-and-writes.md)）。`src/` のファイル：

| ファイル       | 役割                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `extension.ts` | 入口。サイドバーのビューとエディタのパネルに web を載せ、要求を `webview.ts` に通す。VS Code の API に触れるのはここだけ |
| `webview.ts`   | `index.html` を Webview 向けに直す（URI・CSP・nonce・`surface` の data 属性）、要求を `CommandClient` に通す、バッジ     |
| `dg.ts`        | PATH の `dg` を引く 1 か所。ないときはインストールの案内、同梱の core とメジャーが違えば知らせる（UI-11）                |

ビルドは Vite で `dist/extension.cjs` に束ね、web の `dist` を `dist/web` に写す（[ADR-008](adr/ADR-008-tech-stack.md)）。同梱する core の版は `vite.config.ts` の `define` で埋める。手元で動かすには `mise run build` のあと VS Code で `packages/vscode` を開いて F5（拡張開発ホスト）、Activity Bar の deguboard のアイコン。

VSIX は `mise run vsix`（`@vscode/vsce`。判断は [ADR-008](adr/ADR-008-tech-stack.md)）で `packages/vscode/deguboard-vscode.vsix` にでき、`mise run vsix:install`（`mise run install` の最後にも走る）で VS Code に入る（`code` CLI がなければ飛ばす。リモート開発なら統合ターミナルから）。入れたらウィンドウを再読み込みする。入るものは `.vscodeignore` が決める。

## リリース

npm に出すのは `@deguboard/core`・`@deguboard/server`・`deguboard`（cli）の 3 つで、版は全パッケージで揃える（[ADR-006](adr/ADR-006-ui-and-writes.md)）。`web` は cli に同梱し、`vscode` は VSIX で配る。手順は mise のタスクで、`main` の clean な状態で行う：

```sh
mise run release:version -- 0.1.0   # 5 パッケージの version を揃える → PR で main に入れる
mise run check && mise run pack      # build のあと release/ に 3 つの tarball。別ディレクトリで入れて dg --version と dg init を試す
mise run release:publish             # pnpm publish -r --access public（npm login 済みで）
git tag v0.1.0 && git push origin v0.1.0
mise run vsix                        # GitHub の Release に deguboard-vscode.vsix を添付する
```

公開は必ず `pnpm publish`（`release:publish`）で行う。`workspace:*` の版への書き換えと `publishConfig.exports` の差し替えは pnpm だけが行い、`npm publish` では `src/` を指す `development` 条件が残る。

tarball を試すときは、一時ディレクトリの package.json で `deguboard` と、`overrides` の `@deguboard/core`・`@deguboard/server` を `file:` の tarball に向ける。
