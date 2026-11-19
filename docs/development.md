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
mise run dg -- skill install   # .claude/skills/ に Claude Code の Skill（dg*）を書く（clone ごとに一度。追跡しないので、git pull で guide が変わったらやり直す）
mise run dg -- hooks install   # .claude/settings.local.json に、mise の node と dg.js の絶対パスでフックを書く（clone ごとに一度）
mise run dg -- hooks check     # 新しいセッションで、フックが入っていて dg が受け取っていることを確かめる
```

Skill とフックは各自のマシンで入れ、追跡しない（`.claude/.gitignore`）。フックは `.claude/settings.local.json` に書く。命令は node と `dg.js` の絶対パスなので、Claude Code の環境の PATH に node や `dg` がなくても動く。mise.toml の node の版を上げたら、`mise run dg -- hooks install` をやり直す（古い node のパスは `dg hooks check` が gone と警告する）。clone を移したときもやり直す。

端末からほかのリポジトリでも `dg` を呼びたいときは、`mise run dg:link` で `~/.local/bin/dg` にリンクする（~/.local/bin が PATH になければ足す）。リンク先はこのリポジトリの `packages/cli/bin/dg.js` の絶対パスで、一度張れば `git pull` のあとの `mise run install` で更新される。clone を移したら張り直す。既存の `~/.local/bin/dg` が通常のファイルなら消さずに止まる。リンクした dg は PATH の node で動くので、node 24 以上が要る（古いと英語で止まる。このリポジトリの node を使うなら `mise run dg -- <引数>`）。

3. タスクの一覧は `mise tasks` で見られる。タスクは pnpm scripts を呼ぶだけで、定義は [mise.toml](../mise.toml) と [package.json](../package.json)

## チケットと作業の流れ

このリポジトリのチケットは deguboard 自身で管理する（ドッグフーディング）。データは orphan ブランチ `deguboard`（worktree は `.git/deguboard/`）にあり、`dg` でだけ読み書きする。ロードマップは Epic にある（`dg epic list`）。

共通の流れ（起票 → claim → 作業 → PR → 照合 → 完了）は `dg` が出す手順が正本で、ここには書かない。

```sh
mise run dg -- guide work      # 1 枚のチケットを進める流れ
mise run dg -- guide done      # マージ後の後始末
```

このリポジトリに固有の決まり：

- `dg` は `mise run install`・`setup`・`build` のいずれかのあと `mise run dg -- <引数>` で動く。`core`・`server`・`cli` を変えた PR を取り込んだら、もう一度 `mise run build` する（`bin/dg.js` は、dist をビルドしたコミットがその worktree の今の HEAD と違えば、stderr に英語で警告する。比べるのはコミットだけなので、作業用の worktree では文書だけのコミットのあとも、ビルドし直すまで毎回出る。ビルドが読まないファイル（`docs/` など）だけの差分なら無視してよい）
- worktree は `../deguboard.worktrees/<ブランチ名>` に置く（`dg` の `worktree.root` の既定と同じで、リポジトリの外なので `.gitignore` は要らない）。`mise trust` と `node_modules` は worktree ごとに要る。worktree では `mise run setup`（依存とビルドだけ）を使い、`mise run install` は使わない（作業中のブランチの拡張で VS Code の拡張を差し替えてしまう）。`dg ticket claim` は worktree を作り、config の `worktree.setup`（このリポジトリは `mise run setup`）をそこで回すので、手で作るのは claim しない作業のときだけ（その場合も `mise run setup` を手で回す）

  ```sh
  git fetch origin
  git worktree add --no-track -b <ブランチ名> ../deguboard.worktrees/<ブランチ名> origin/main
  cd ../deguboard.worktrees/<ブランチ名> && mise trust && mise run setup
  ```

- PR は `gh pr create --base main` で出し、本文にチケットの ID（`t12`）を書く。Core に固定した照合のきっかけ（[ADR-003](adr/ADR-003-status-and-workflow.md)）で、下書きでない PR が開けば `dg sync` が review に、squash マージされれば done に進める（`gh` が要る）
- 画面の見た目を変える PR は、変えた画面のスクリーンショットを本文に載せる。左パネルとパネルの画面は `mise run test:vscode` が VS Code の実機でライトとダークを `test/vscode/screenshots/` に出したものを既定とする（「`packages/vscode`」の節。ほかの画面を撮るときは `test/vscode/sidebar.vscode.ts` に操作を足す。導入のチェックリストは dg init していないフォルダが要るので `test/vscode/onboarding.vscode.ts`）。`dg serve` で撮るのは VS Code を起動できないときだけとし、Playwright MCP で一時リポジトリの `dg serve` を `?surface=` の配置で開き（「`packages/web`」の節）、ライトとダーク（`browser_emulate_media` の `colorScheme`）で撮る。幅の目安は sidebar が 360×800、panel が 960×800。画像は orphan ブランチ `pr-screenshots` の `<チケット ID>/` に置く（作業ブランチに入れると squash で `main` に入る）

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

- マージは `main` の worktree から行う。エージェントは、人がマージを承認してから `dg pr merge` で行い（承認者を `--approved-by human` で渡す。品質ゲートを満たすときだけ gh を呼び、`--delete-branch` なら gh を呼ぶ前に作業ブランチの worktree を消し、マージに失敗したらそれを戻して worktree.setup を回し直す（PR がマージ済みなら戻さず、失敗は warnings に出す）。worktree は先に消さない）。品質ゲートを満たさない PR も、満たさない条件を示して人に聞き、承認されたら同じコマンドでマージする（承認で越えられないのは PR の状態・衝突・判定した先端。人に `gh` を打ってもらわない）

  ```sh
  mise run dg -- pr merge <チケット ID> --approved-by human --delete-branch
  git pull --ff-only && mise run build && mise run dg -- sync
  ```

  マージで消えなかった worktree とブランチ（人が GitHub の画面でマージしたときなど）は、チケットを done にする `dg sync` が消す。未コミットの変更やマージしていないコミットが残るものは消さず、理由と消し方を warnings に出すので、要るものを退避してから手で消す

- `dg` 自体の不具合でチケットを動かせないときは、人が `.git/deguboard/` のファイルを直接直し、`mise run dg -- adopt` で取り込んでから（取り込まないと dg の外の変更として書き込みが止まる）、その不具合を起票する

## ビルドとテスト

- TypeScript は ESM（`"type": "module"`）で、相対 import は `.js` の拡張子で書く。`mise run typecheck` は `noEmit` で検査する
- `mise run build` が `tsconfig.build.json`（プロジェクト参照）で `core`・`server`・`cli` を、Vite で `web` と `vscode` を `dist/` に出す。tsc は消えたソースの出力を消さないので、増分の `tsc -b` のあとで `scripts/prune-dist.mjs` が `core`・`server`・`cli` の `dist/` から今のソースに対応しない出力を消す（`dist/` を先に消さないのは、ビルド中もフックが呼ぶ `dg` を動かし続けるため）。最後に `scripts/write-build-info.mjs` が、ビルドしたコミットを `packages/cli/dist/build-info.json` に書く（比べるのは `packages/cli/bin/build-info.mjs`）。`dg` をリポジトリの外のディレクトリに対して動かすときは `-C <dir>` を付ける
- `@deguboard/core` と `@deguboard/server` の `exports` は条件つきで、テストと型検査・vscode のビルド（`development` 条件）は `src/` を、ビルド済みの `dg` は `dist/` を見る。テストの前にビルドは要らない
- テストはソースの隣の `*.test.ts`（画面は `*.test.tsx`）に置き、ルートの `vitest.config.ts` が `packages/*/src/**/*.test.{ts,tsx}` と `test/**/*.test.ts` をまとめて走らせる。パッケージごとの設定ファイルは作らない
- snapshot（`toMatchSnapshot`・`toMatchFileSnapshot`・`toMatchInlineSnapshot` の期待値）を書き直すのは `mise run test -- <ファイル> -u` で行う（`-u` は vitest の `--update` で値を取れるので、ファイルを先に書く。後ろに書くと `-u` の値になり、全テストが更新モードで走る）。書き直すのは本文や画面の文言を意図して変えたときだけで、できた差分を読んでからコミットする
- vitest のワーカー数の既定・変え方（環境変数 `DEGUBOARD_TEST_MAX_WORKERS`）・理由は `vitest.workers.ts` の冒頭のコメントにある
- コマンドのテストは、集める・決める・行うの分け方（[ADR-033 の「Core の中の境界」](adr/ADR-033-architecture.md#core-の中の境界)）に合わせて 3 つの層で書く。例は品質ゲート
  - 判定のテスト：決める関数（`commands/gate-judge.ts`）を、事実の型の値を渡して git なしで確かめる。組み合わせはここで網羅し、既定の事実から 1 つだけ変える形か、表で掛け合わせる形で書く（`gate-judge.test.ts`）
  - 事実の読み取りのテスト：git・gh の状態から事実の型を作る処理（`git/facts.ts`）を、事実ごとに本物の git で確かめる。読めないとき（gh がない・PR がない・前の作業の PR）を値で返すこともここで確かめる（例は `git/facts.test.ts` の branch_merged の事実の読み取り。読んだ事実からの判定は `git/facts-judge.test.ts` で確かめる）
  - 経路のテスト：コマンドの結合テスト（`commands/gate.test.ts`・`pr.test.ts`）は経路ごとに代表を 1〜2 件にする（集めて決めて行うが通ること、push・lock・競合・gh の引数・記録の形）。判定の組み合わせを結合テストに足さない。準備は下の雛形から写し、1 件の中で init しない
- パッケージをまたぐテストは `test/` に置く。`e2e/routes.test.ts` は CLI・HTTP・Webview の 3 経路の結果とコミットの一致（CL-6）を、`layout/` は画面の配置と吹き出しの一覧を（`mise run test:layout`）、`vscode/` は VS Code の実機の左パネルを（`mise run test:vscode`）確かめる（ブラウザと VS Code が要るので check に入れない）
- Git を使うテストは `packages/core/test/helpers/git-fixture.ts` で、一時ディレクトリに bare リモートと 2 つの clone を作って行う。fixture が開発者のグローバル設定と裏の git maintenance からテストを切り離す（方法は fixture のコメント）。テストごとに同じ準備（init・チケット・commit など）をするなら `createFixtureFrom(key, setup)` で、テストファイルごとに 1 度だけ準備した雛形から写す（写した先の絶対パスは付け替える。方法は fixture のコメント）。init の後の状態だけが要るなら、`packages/core/test/helpers/commands-context.ts` の `initializedFixture()` から写し、テストの中で init するのは init 自身か init のオプション（リモートのない init など）を確かめるときだけにする。同期・取り込み・push・リモート・即時の操作の取得を確かめないテストは、リモートを外した `initializedLocalFixture()`（自前の雛形なら setup の終わりに `removeRemotes`）から写す（即時の操作のたびの fetch・rebase・push を省く。どのファイルをどちらで回すかは `initializedLocalFixture` のコメント）。データをコードとは別のリポジトリに置くテストは、`addDataRemote` でデータ用の bare リモートを足す
- 依存を足すときは `mise exec -- pnpm add <名前>@<版> --filter <パッケージ>` で足し（版は `1.2.3` の完全な形で書く。`pnpm-workspace.yaml` の `savePrefix` で固定の版で書かれるが、`7`・`^7` のような範囲を渡すと範囲のまま書かれる。版を上げるのも `add <名前>@<新しい版>`、削除は `remove`、開発用は `-D` を付ける、ルートに足すときは `--filter` を外す。overrides を変えたときは `mise exec -- pnpm install`）、更新した lockfile もコミットする（`mise run install` は `--frozen-lockfile`）
- package.json にはコメントを置けないので、ほかの依存と揃えずに留めている版の理由はここに書く
  - `packages/vscode` の `engines.vscode` は、拡張ホストが Node 24 になった最初の版（1.123。Electron 42.3、Node 24.15）にする。束ねる core の `engines.node`（>=24）と Vite の `target: "node24"` に揃う。1.122 までは Node 22（1.104 は Electron 37.3、Node 22.18）
  - `@types/vscode` は API が変わった版しか公開されない（DefinitelyTyped の運用。1.120.0 の次は 1.125.0）ので、`engines.vscode` を超えない最新の公開版に固定する。engines と番号が揃わなくても上げない（vsce が engines を超えていないか検査する）
  - ルートの `playwright-core` は安定版にせず、`@playwright/mcp` が依存に完全一致で固定する版（alpha）に揃える。別の版にすると playwright-core が二重に入り、`mise run playwright:install` が入れるブラウザと MCP が使う版がずれる。@playwright/mcp が安定版を要求するようになったら一緒に移す
- oxlint は最新の版に上げ、版を留めない（package.json に固定する）。新しい版で増えた規則が既存のコードで失敗したら、その指摘は上げる PR の中で直す。上げるのを指摘の直しの後に回さない
- oxlint（`.oxlintrc.json`）の `plugins` は既定の組を置き換えるので、使う言語とライブラリの plugin（web の React には `react`）を明示する

## パッケージ

構成と依存の向きは [ADR-033](adr/ADR-033-architecture.md)。`core`・`server`・`cli`・`web`・`vscode` の 5 つ。

### `packages/core`（`@deguboard/core`）

ドメインモデル・ストレージ・Git 操作・ワークフロー・Run・コマンド定義。`src/` のモジュール（ADR-033 の「Core の中の境界」はこの表を参照する）：

| モジュール  | 役割                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`    | Zod のスキーマ（config・Ticket・Epic・Iteration・Plan・Workflow・Run）、ID の解析と採番、Status と前進の順、Run の集計の純粋関数（`metrics.ts`）                                                                                                                                                                                                                                                                                                                                                                                                           |
| `storage/`  | frontmatter と YAML の読み書き（コメントとキー順を保つ）、原子的書き込み、`Store`（開くときに走査してメモリ上に索引を作る。読みの結果は `deguboard-local/store-cache/` に残し、変わったファイルだけを読む）、参照の整合                                                                                                                                                                                                                                                                                                                                    |
| `workflow/` | `workflow.yaml` の省いた項目を補う Core の既定、操作に当てる方針の引き方、条件の評価と権限の値の判定、`reconcile` の評価、定義の検証                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `git/`      | deguboard worktree の用意、取り込みと push、書き込みの 1 単位 `withWrite`、仮番号の振り直し、事実の収集（`facts.ts`）と読んだ値から決める判定（`facts-judge.ts`。git・gh を読まない）、frontmatter と YAML のマージドライバ（`merge.ts`。SY-4）、経過の読み取り（`history.ts`。CL-7）                                                                                                                                                                                                                                                                      |
| `run/`      | Run の start・finish と、チケットの操作の書き込みの中で閉じる closeRun。実行中の記録は `deguboard-local/runs/`、二重の start は `locks/runs` のロックで拒む                                                                                                                                                                                                                                                                                                                                                                                                |
| `agents/`   | Agent Adapter（`adapters/` に製品ごと）。会話記録からの使用量の取り込みと、Skill の置き場所（`skillDirs`）。汎用部分は `index.ts` だけを import する（PreToolUse と Stop の速い経路は `fast-hooks.ts`。ADR-033）                                                                                                                                                                                                                                                                                                                                           |
| `commands/` | 3 つの入口の正本。`defineCommand` で「名前・Zod の入力・実装」を組にし、`openContext` と `runCommand` で呼ぶ。コマンドの中で事実から結果を決める関数は、git・gh・ファイルを読まない `*-judge.ts`（例：`gate-judge.ts`・`reconcile-judge.ts`）に置き、事実の集めと実行はコマンドの側に残す。一覧に入れない CLI だけの操作（AG-4。ADR-033）の判定と書き込みも置く：`dg skill install` は `skill-files.ts`、`dg hooks` は `hook-settings.ts`、`dg setup check` は `setup-check.ts`（`dg serve` の `/api/setup` と拡張の導入のチェックリストも同じ結果を写す） |
| `guide/`    | guide の本文（`guide-*.md`）の読み込み・節の切り出し（`sections.ts`）・config の埋め込み。`dg guide`・`dg next`・`dg brief`・`dg flow next` が写す（ADR-030）                                                                                                                                                                                                                                                                                                                                                                                              |

入口がコマンドを呼ぶ流れ：`openContext({ cwd, actor })` → `runCommand(findCommand("ticket.create"), ctx, input)`。入力の形の誤りは `UsageError`（終了コード 2）、実行時の失敗は `OperationError`（終了コード 1、`code` に種類）。

### `packages/cli`（`@deguboard/cli`、コマンドは `dg`）

core の `commands` を commander（`program.ts`）と MCP のツール（`mcp.ts`）に写す。ロジックは持たない。`bin/dg.js` と束ねた `dist/cli/dg.mjs` の入口（`bundle.ts`）は PreToolUse と Stop のフックの呼び出しを、本体を読む前に `fast-hook.ts` で処理する（ADR-033）。各ファイルの役割は冒頭のコメントが正本で、引数の型ごとの対応は `options.ts`、`--json` の形は `output.ts`、終了コードは `errors.ts`。

グローバルオプションは `dg --help` が正本。`dg serve` / `dg open`（`serve.ts`）は開発用（配置の確認とスクリーンショット。[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）で、`@deguboard/server` を起動する・ブラウザで開くだけ。`guide-*.md` は `packages/core/src/guide/` にあり、ビルドで core の `dist/guide/` に、拡張の `dist/` に写す（ルートと `packages/vscode` の `build`）。web の `dist` は `packages/cli/web` に写す（ルートの `build`）。トピックを足すときは、次を同じ PR で直す。

- `guide-<トピック>.md` を `packages/core/src/guide/` に置く。frontmatter に `description` があるトピックは Skill になる
- `packages/core/src/guide/topics.ts` の `GUIDE_TOPICS`（guide の読み込みと config の `guide.notes` が読む）と、その直前のコメント（流れの中か外か）
- `guide-overview.md` の表（トピックの名前・Skill の名前・いつ読むか）
- `packages/core/src/model/schema.test.ts` の `guide.notes.<トピック>` の一覧
- Skill を持つトピックは `packages/core/src/commands/ask.ts` の `SKILL_SUMMARY` に ja・en の文を足し、`ask.test.ts` の個数（`toHaveLength`）を合わせる。Skill を持たないトピックは `packages/cli/src/guide.test.ts` の「Skill を持つトピックは対象の決め方・選択肢で聞く節・次の手順を持ち、本文に frontmatter を残さない」のテストで、Skill を持たないトピックの並び（`topic === "overview" || …`）に足す
- `packages/cli/src/guide.test.ts` の `ENGLISH_TOPICS`（本文が英語のトピックの集合）に足す。guide の出力の snapshot（`packages/cli/src/__snapshots__/guide.test.ts.snap`）は、書き直す手順を「[ビルドとテスト](#ビルドとテスト)」の節から引く
- Skill を持つトピックは `packages/cli/src/skill.test.ts` の Skill の名前の一覧に足す
- `.claude/.gitignore` に `skills/dg<トピック>/` の行が `dg skill install` で足されるので、その行をコミットに含める
- 設定の画面の表示（web）: `packages/web/src/pages/config.tsx` の `NAMES`（`guide.notes.<トピック>` の「差し込む文書（…）」）と `NOTE_LABELS`（表の行の名前）、英語の訳は `packages/web/src/l10n-en.ts`、画面の文言の snapshot（`packages/web/src/__snapshots__/l10n-screens.ja.txt`・`.en.txt`）は、書き直す手順を「[ビルドとテスト](#ビルドとテスト)」の節から引き、`l10n-screens.test.tsx` が出す差分を読んでから書き直す

### `packages/server`（`@deguboard/server`）

core の `commands` を HTTP に写す。Node 標準の `node:http` で、フレームワークは入れない（[ADR-008](adr/ADR-008-tech-stack.md)）。`dg serve` が起動し、既定で `127.0.0.1:7474` に閉じる。

エンドポイントとエラーの HTTP の状態への写し方は `app.ts` が正本。文脈の管理（主体・直列化・再走査）は core の `createLocalClient`（`commands/local.ts` の冒頭）が持ち、`server` と `vscode` はこれを HTTP と postMessage に写すだけ。

### `packages/web`（`@deguboard/web`）

画面の React アプリ。構成の判断は [ADR-008](adr/ADR-008-tech-stack.md)。core からは型と `CommandClient`（`core/commands/client.ts`）だけを取り込む。テストの例外を含む取り込みの範囲は [ADR-033 の「依存の向き」](adr/ADR-033-architecture.md#依存の向き)。`CommandClient` の実装は `client/` に HTTP と postMessage の 2 つ、画面は `pages/`、状態は `store.tsx`、画面の切り替えはハッシュ（`router.ts`）。各ファイルの役割は冒頭のコメントが正本。

型検査は `tsconfig.json` を別に持つ（DOM と JSX が要るため）。ビルドは Vite で `dist/` に出し、`dg serve` は cli に写した `web/` を配信する（`cli/program.ts` の `webDist`）。テストは `// @vitest-environment jsdom` を付け、`test-helpers.ts` の `mockClient` で `CommandClient` を差し替える。

画面の文言は `l10n.ts` の `tr`（鍵は日本語の文。要素を挟む文は `l10n-node.tsx` の `trNode`）で書き、英語の訳は `l10n-en.ts` に置く。core が返す文をどの言語でも `l10n-core.ts` の表から引き、訳がなければ core の文のまま出す。表は 4 つで、鍵はどれも core の英語の文（可変の部分は `{0}`・`{1}`）、値は ja の訳を持つ：頼むの候補の名前と Plan の承認の状態（`CORE_LABELS`）、エラーと警告（`CORE_MESSAGES`）、設定の項目の文（`CONFIG_DESCRIPTIONS`：説明・要約・空のときの動き・選択肢ごとの説明）、dg の既定の値（`DEFAULT_VALUES`：優先度の判断基準・振り返りの既定の観点・Run の step と Status の既定の表示名）。既定の値は、値が既定のままのときだけ表示言語の訳で出し、書き換えた値は訳さない。口は `l10n.ts` の関数で、`trCore`・`trCoreMessage`・`configDescription` が前の 3 つを引き、`shownDefault` が `DEFAULT_VALUES` を引く（画面の設定・振り返りの観点・Workflow の表示が使う。書き換えた値の横に既定そのものを添えるときは、比べない `shownDefaultText`）。`storedDefault` は、その訳の文を入力欄に打って離れたときに既定の値へ戻す。表にない文は core の文のまま出す。言語は Webview の `<html data-language>` で決まり、ない（`dg serve`）と日本語。揃っているかは `l10n.test.ts`、日本語の文言が変わっていないかは `l10n-screens.test.tsx` のスナップショットが確かめる。

見た目は Playwright MCP（`.mcp.json`。Chromium は `mise run playwright:install`）で一時リポジトリの `dg serve` を見る。配置は `?surface=sidebar`（既定）か `panel` で選ぶ（ブラウザだけの配置はない）。Webview に固有の色・CSP・拡張ホストとのやり取りは `mise run test:vscode` で見る（「`packages/vscode`」の節）。

### `packages/vscode`（`deguboard-vscode`。拡張の ID は `deguboard.deguboard-vscode`）

VS Code 拡張。拡張ホストから core の `createLocalClient` を呼び、Webview に web のビルド結果を載せる。サーバーは起動しない。同梱した `dist/cli/dg.mjs` は、起動のたびに `~/.local/share/deguboard/` に書く起動ファイル `dg` から外に出す（`launcher.ts`。[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）。VS Code の API に触れるのは入口の `extension.ts` だけで、Webview に載せる純粋な処理は `webview.ts`、PATH の `dg` を引くのは `dg.ts`、導入のチェックリストの項目の組み立てとボタンが流すコマンドは `setup.ts`（core の `checkSetup` に、フォルダ・OS・PATH の `dg` を足す）、拡張を消したときの片付けは `uninstall.ts` が呼ぶ。文言は言語ごとのファイルに置く：manifest は `package.nls.json`（英語・既定）と `package.nls.ja.json`、拡張ホストは `l10n.ts` の `t`（鍵は英語の文）と `l10n/bundle.l10n.ja.json`、Walkthrough は `media/walkthrough/*.md` と `*.ja.md`。揃っているかは `l10n.test.ts` が確かめる。Webview の画面の文言は web に置き（「`packages/web`」の節）、拡張ホストは表示言語を `<html data-language>` で渡すだけ。

ビルドは Vite で `dist/extension.cjs` に束ね、web の `dist` を `dist/web` に写す（[ADR-008](adr/ADR-008-tech-stack.md)）。同梱する core の版は `vite.config.ts` の `define` で埋める。続けて `vite.cli.config.ts` が CLI（入口は `packages/cli/src/bundle.ts`）を、小さな入口 `dist/cli/dg.mjs` と依存ごと束ねた本体の chunk（`dist/cli/dg-main-*.mjs`、本体は `bundle-main.ts`）に分けて束ね、速い経路（`fast-hook.ts`）が読むファイルだけは本体と分けた小さな chunk（`dist/cli/dg-fast-*.mjs`）に入れて、入口はそれだけを本体より先に読む（t769）。Web の画面と guide は拡張の `dist/web`・`dist/guide-*.md` を共有する（束ねた配置で引く場所は `bundle-main.ts` の冒頭）。`vite.uninstall.config.ts` は vscode:uninstall が走らせる `src/uninstall.ts` を `dist/uninstall.mjs` に束ねる。手元で動かすには `mise run build` のあと VS Code で `packages/vscode` を開いて F5（拡張開発ホスト）、Activity Bar の deguboard のアイコン。実機の確認は `mise run test:vscode`：`.vscode-test/` に落とした VS Code（版は `test/vscode/host.ts` で固定）を Xvfb 上に拡張開発ホストとして起動し、一時リポジトリの左パネルで行の表示・詳細のパネル・CSP 違反と例外（あれば落ちる）・ライトとダークのスクリーンショット（`test/vscode/screenshots/`）を確かめる。Claude Code の中からでも動く。細部は `test/vscode/host.ts` の冒頭。

VSIX は `mise run vsix`（`@vscode/vsce`。判断は [ADR-008](adr/ADR-008-tech-stack.md)）で `packages/vscode/deguboard-vscode.vsix` にでき（依存は束ねてあるので `vsce` は `--no-dependencies` で、pnpm の node_modules の形に影響されない）、`mise run vsix:install`（`mise run install` の最後にも走る）で VS Code に入る（入れられないときは手で入れるコマンドを出す。条件は `scripts/install-vsix.mjs` の冒頭。リモート開発なら統合ターミナルから）。入れたらウィンドウを再読み込みする。拡張の ID が `deguboard.deguboard` だったころの拡張が入っていると、新しい拡張と並んで画面とコマンドが二重に出るので、一度 `code --uninstall-extension deguboard.deguboard` で外す。入るものは `.vscodeignore` が決め、入ってよいファイルの一覧は `packages/vscode/src/vsix-files.test.ts` が `vsce ls` と照らす（一覧にないものが入ると `mise run check` が落ちる。入れるファイルを増やす PR は一覧も直す）。拡張の README（Marketplace の紹介）はルートの README.md の全文を `scripts/vscode-readme.mjs` が写して作り、git には入れない。紹介はルートの README で直し（README.ja.md は拡張の README に入らない）、README.md のリンクはすべて絶対 URL にする（相対リンクがあると作れない）。

README の GIF（`packages/vscode/images/`）は、画面を変えたら `mise run gifs` で録り直す（台本は `scripts/record-gifs.mjs`）。英語の表示の `*.gif` を README.md が、日本語の表示の `*.ja.gif` を README.ja.md が引き、1 回で両方を録る。1.5 倍の解像度（1140px 幅。3 段の依存グラフを見せる plan・work は左パネルを広げて 1245px 幅）で撮る。

## guide.notes の文書（docs/guide-notes/）

このリポジトリの作業の規則は、`dg guide` に差し込む文書として `docs/guide-notes/<トピック>.md` に置く。差し込むのは config の項目 `guide.notes.<トピック>` で、このリポジトリでは `guide.notes.plan` が `docs/guide-notes/plan.md` を、`guide.notes.work` が `docs/guide-notes/work.md` を、`guide.notes.import` が `docs/guide-notes/import.md`、`guide.notes.review` が `docs/guide-notes/review.md`、`guide.notes.retro` が `docs/guide-notes/retro.md` を指す。文書は英語で書く（[ADR-001](adr/ADR-001-doc-strategy.md)）。項目は `packages/core/src/model/config.ts` の `noteField`、読み込みは `packages/core/src/guide/guide.ts` の `readGuideNotes` が正本。

1 つの規則は、規則の文（1〜2 文）と、根拠の 1 行（Iteration・指標の値・代表のチケット ID 1 つまで）で書き、根拠の行の末尾に外す条件を 1 文で続ける（`Drop this rule when ...`）。経緯の段落は書かない。dg の出力（警告など）がすでに言うことは書かない。見出しのある文書は差し込まれないので、外す条件も見出しにしない。外す条件は振り返り（`dg guide retro` に差し込む `retro.md`）で指標で確かめ、当たった規則を消すチケットを Try として出す。振り返りの中では規則を消したり変えたりせず、Try のチケットの PR で消す。

## リリース

利用者に届けるのは VSIX だけで（`dg` は拡張に同梱する）、npm には出さない。VSIX は GitHub の Release に添付し、同じものを VS Code Marketplace に出す。版は全パッケージで揃える（`release:version`。VSIX の版もここで決まる。[ADR-027](adr/ADR-027-screen-vscode-writes-and-asks.md)）。`main` の clean な状態で行う：

```sh
mise run release:version -- <版>    # 版を揃え、PR で main に入れる
mise run check                       # コミット前と同じ検査
mise run audit                       # 本番の依存の脆弱性（あれば直すか人が判断する）
mise run test:layout && mise run test:vscode   # 画面の配置と VS Code の実機（check に入らない）
git tag v<版> && git push origin v<版>
mise run vsix                        # 出た SHA256 の文を Release の本文に貼る
gh release create v<版> --draft --notes-file <本文> packages/vscode/deguboard-vscode.vsix   # 下書きの Release に VSIX を添付する
gh release edit v<版> --draft=false  # 公開すると、ワークフローが Marketplace に出す
```

リリースのチケットを 2 つに分けて起票し進める手順（起票の時期は Iteration の確認である `dg guide release` の手順 1「Check that all are done」のあと、分け方と進め方は手順 3）は `dg guide release` に従う。ここには、このリポジトリで受け入れ条件に入れるものだけを書く。

- **版を上げる PR のチケット**（`release:version` の PR）：全パッケージの版が揃い VSIX の版が `packages/vscode/package.json` と一致する、`mise run check`・`mise run audit`・`mise run test:layout`・`mise run test:vscode` が PR の先端で通る。
- **タグと公開のチケット**（PR を持たない）：マージ後の main の SHA にタグ `v<版>` を push した、VSIX を添付した Release を公開した、Marketplace に版が出た（ワークフローが成功した）。PR のマージのあとでしか確かめられないので、PR のチケットに入れない。

VSIX を添付してから公開する。公開したときだけ `.github/workflows/publish-extension.yml` が走り、その Release に添付した `deguboard-vscode.vsix` を落として、版がタグと合えば Marketplace に出す（`vsce publish --oidc`）。build と検査はしないので、上の検査を通した VSIX を添付する（判断は [ADR-008](adr/ADR-008-tech-stack.md)）。pre-release の Release は出さず、あとで正式な Release に変えても出ない（出すなら、その Release を消して下書きから作り直して公開する）。

初めて出す前に、一度だけ準備する。初回の VSIX は人が手で上げ、その後の版から Release の公開で出す。手で上げるのは、Marketplace の trusted publishing の policy が既存の拡張のページに登録するもので、拡張が一度出ていないと設定できず、ワークフローは Release の公開でしか走らないため。

Marketplace の publisher `deguboard` を作り、`mise run vsix` の VSIX を publisher の管理画面（`https://marketplace.visualstudio.com/manage/publishers/deguboard`）の New extension から手で上げて拡張のページを作る。New extension の上げが「Your extension has suspicious content」で拒否されたら、README と説明文（`description`）を最小にした VSIX を New extension から上げ、その検査（Verifying）が終わってから、本物の VSIX をその拡張の Update から上げる（最小の VSIX のための変更はコミットしない）。次に、その拡張の trusted publishing の policy にこのリポジトリとワークフローのファイル `publish-extension.yml` を登録する（PAT は作らない）。試しの版や要らない版を外すときは Unpublish にし、Remove しない（Remove した拡張の名前は同じ publisher でも二度と使えず、表示名（`displayName`）も押さえられたままになって「This extension display name is taken」で拒否される。表示名が `deguboard for VS Code` なのはこのため）。

手で上げる VSIX は、`mise run vsix` で作った今の版（`packages/vscode/package.json` の version）のもので、上のコードブロックの検査（`mise run check`・`mise run audit`・`mise run test:layout`・`mise run test:vscode`）を通したものにする。初回の版は GitHub の Release もタグも作らない。Release を公開するとワークフローが同じ版を出そうとして失敗するため。Release で出す版は、それより後の版にして、上のコードブロックの手順で作る（同じ版は Marketplace に二度出せず、ワークフローが失敗するため）。
