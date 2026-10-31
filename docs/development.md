# 開発ガイド

このリポジトリで deguboard を開発する人向けの説明。毎回守る規約（コードの規約、コミット・PR・マージ）は [CLAUDE.md](../CLAUDE.md) にあり、ここには書き写さない。

## 開発の始め方

ツールと作業コマンドは [mise](https://mise.jdx.dev/) に統一している（[ADR-008](adr/ADR-008-tech-stack.md)）。

1. mise を入れる（[公式の手順](https://mise.jdx.dev/getting-started.html)）
2. リポジトリを clone して、その中で次を実行する

```sh
mise trust          # このリポジトリの mise.toml を信頼する
mise install        # node・pnpm を mise.toml の版で入れる
mise run install    # 依存を lockfile どおりに入れる
```

3. 変更したら `mise run format` で整え、`mise run check` を通してからコミットする

### よく使うタスク

| タスク                  | すること                                      |
| ----------------------- | --------------------------------------------- |
| `mise run format`       | oxfmt で書式を整える                          |
| `mise run format:check` | 書式が整っているかを確かめる（書き換えない）  |
| `mise run lint`         | oxlint を実行する                             |
| `mise run typecheck`    | tsc で型を検査する（テストも含む）            |
| `mise run test`         | vitest でテストする                           |
| `mise run check:docs`   | 文書の大きさの予算と ADR 一覧の整合を検査する |
| `mise run check`        | コミット前の確認。上をすべて順に実行する      |

タスクの一覧は `mise tasks` で見られる。タスクは pnpm scripts を呼ぶだけで、定義は [mise.toml](../mise.toml) と [package.json](../package.json)。

## チケットと作業の流れ

このリポジトリのチケットは deguboard 自身で管理する（ドッグフーディング）。データは orphan ブランチ `deguboard`（worktree は `.git/deguboard/`）にあり、`dg` でだけ読み書きする。`dg` は `mise run build` のあと `mise run dg -- <引数>` で動く。`core` や `cli` を変えた PR を取り込んだら、もう一度 `mise run build` する。

規約（squash マージ、ブランチを消す）は [CLAUDE.md](../CLAUDE.md#ブランチprマージ) にある。worktree は `../deguboard.worktrees/<ブランチ名>` に置く。`dg` の `worktree.root` の既定（[requirements.md](requirements.md)）と同じ場所で、リポジトリの外なので `.gitignore` は要らない。ブランチ名は `<種類>/<内容>`（例：`docs/branch-strategy`、`feat/ticket-create`、`fix/sync-warning`）。

1. 起票する。複数まとめて起こすときは YAML の下書きを `ticket import` に渡す（`mise run dg -- ticket import --help`）。Phase 1 の残りは Epic `e1` に入れる

   ```sh
   mise run dg -- ticket create "<題>" --summary "<概要>" --epic e1
   mise run dg -- ticket list          # 番号を確かめる。--ready で着手できるものだけ
   ```

2. 着手する。`claim` がブランチ名を記録して in_progress にし、push の成功で排他を得る。依存先が done でなければ拒否される

   ```sh
   mise run dg -- ticket claim <番号> --branch <ブランチ名>
   ```

3. `main` の worktree で、`origin/main` から作業ブランチと worktree を作り、環境を用意する。`mise trust` と `node_modules` は worktree ごとに要る

   ```sh
   git fetch origin
   git worktree add --no-track -b <ブランチ名> ../deguboard.worktrees/<ブランチ名> origin/main
   cd ../deguboard.worktrees/<ブランチ名>
   mise trust && mise run install
   ```

4. 実装し、`mise run format` と `mise run check` を通してコミットし、push して PR を出す。PR の本文にチケットの ID（`t12`）を書く。PR が開けば `dg sync` が照合でチケットを review に進める（`gh` が要る。なければ `ticket move <番号> review`）

   ```sh
   git push -u origin <ブランチ名>
   gh pr create --base main
   mise run dg -- sync
   ```

5. レビューの指摘は同じ worktree で直して push する。承認されたらマージする。worktree は先に消す（ブランチを checkout したままだと `gh` がローカルのブランチを消せない）。マージ後の `dg sync` が PR のマージを照合してチケットを done にする

   ```sh
   cd <main の worktree>            # リポジトリ本体
   git worktree remove ../deguboard.worktrees/<ブランチ名>
   gh pr merge <PR 番号> --squash --delete-branch
   git pull --ff-only
   mise run dg -- sync
   ```

   `--delete-branch` がリモートとローカルのブランチを消す。worktree に未コミットの変更が残っていて `git worktree remove` が止まったら、要るものを退避してから `--force` を付ける。

やめるチケットは `mise run dg -- ticket move <番号> abandoned`（人だけが行える）。着手をやめて todo に戻すのは `ticket unclaim <番号>`。`dg` 自体の不具合でチケットを動かせないときは、`.git/deguboard/` のファイルを直接直してコミットし、その不具合を起票する。

## ビルドとテスト

- TypeScript は ESM（`"type": "module"`）で、相対 import は `.js` の拡張子で書く。設定はルートの `tsconfig.base.json` と `tsconfig.json` にあり、`mise run typecheck` は `packages/*/src` と `packages/*/test` をまとめて `noEmit` で検査する
- `mise run build` が `tsconfig.build.json`（プロジェクト参照）で `core` と `cli` を `dist/` に出す。`dg` を動かすにはこのビルドが要る。`mise run dg -- <引数>` でビルド済みの `dg` を動かせる（例：`mise run dg -- ticket list`）。リポジトリの外のディレクトリに対して動かすときは `-C <dir>` を付ける
- `@deguboard/core` の `exports` は条件つきで、テストと型検査（`development` 条件）は `src/` を、ビルド済みの `dg` は `dist/` を見る。テストの前にビルドは要らない
- テストはソースの隣の `*.test.ts` に置き、ルートの `vitest.config.ts` が `packages/*/src/**/*.test.ts` をまとめて走らせる。パッケージごとの設定ファイルは作らない
- Git を使うテストは `packages/core/test/helpers/git-fixture.ts` で、一時ディレクトリに bare リモートと 2 つの clone を作って行う（CLAUDE.md の規約）。開発者のグローバル設定に影響されないよう、fixture が `GIT_CONFIG_GLOBAL=/dev/null` と `GIT_CONFIG_NOSYSTEM=1` を与える
- 依存を足すときは `pnpm install` で lockfile を更新してからコミットする（`mise run install` は `--frozen-lockfile`）

## パッケージ

構成と依存の向きは [ADR-007](adr/ADR-007-architecture.md)。今あるのは `core`・`server`・`cli` で、`web`・`vscode` はこれから作る。

### `packages/core`（`@deguboard/core`）

ドメインモデル・ストレージ・Git 操作・ワークフロー・コマンド定義。VS Code API・HTTP・React に依存しない。`src/` のモジュール：

| モジュール  | 役割                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`    | Zod のスキーマ（config・Project・Ticket・Epic・Iteration・Plan・Workflow）、ID の解析と採番、Status と前進の順                            |
| `storage/`  | frontmatter と YAML の読み書き（コメントとキー順を保つ）、原子的書き込み、`Store`（起動時に走査してメモリ上に索引を作る）、参照の整合     |
| `workflow/` | 遷移表の正本、条件の評価、`reconcile` の評価、定義の検証、同梱テンプレート                                                                |
| `git/`      | `execFile` で git・gh を呼ぶ、deguboard worktree の用意、取り込みと push、書き込みの 1 単位 `withWrite`（CAS と provisional）、事実の収集 |
| `commands/` | 3 つの入口の正本。`defineCommand` で「名前・Zod の入力・実装」を組にし、`openContext` と `runCommand` で呼ぶ                              |

入口がコマンドを呼ぶ流れ：`openContext({ cwd, actor })` → `runCommand(findCommand("ticket.create"), ctx, input)`。入力の形の誤りは `UsageError`（終了コード 2）、実行時の失敗は `OperationError`（終了コード 1、`code` に種類）。各コマンドの `positionals` が、CLI で位置引数にする入力のキーを指す。

### `packages/cli`（npm の `deguboard`、コマンドは `dg`）

core の `commands` を commander に写す。ロジックは持たない。`src/` のファイル：

| ファイル     | 役割                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `program.ts` | `commands` から `dg <群> <操作>` の木を組み立てる。`setup` 群（init・sync・commit・validate・lint）はトップレベル。`sprint` は alias |
| `options.ts` | Zod の入力スキーマから位置引数とオプションを作り、解析した引数を入力オブジェクトに戻す（下の表）                                     |
| `output.ts`  | 人向けの出力（list は表、show は `key: value` と本文）と `--json`（`{ ok, data, warnings, write }` / `{ ok: false, error }`）        |
| `errors.ts`  | `DeguboardError` と commander のエラーを stderr と終了コード（0 / 1 / 2）に写す                                                      |
| `guide.ts`   | `dg guide <topic>`。隣の `guide-*.md`（手順の正本。CL-5）を読み、`{{git.base_branch}}` のような項目を config の値で埋めて出す        |

Zod の型から CLI への対応：

| Zod の型                    | CLI                                                                         |
| --------------------------- | --------------------------------------------------------------------------- |
| string / number / unknown   | `--key <value>`（`snake_case` は `--kebab-case`）                           |
| boolean                     | `--key`（フラグ）                                                           |
| enum                        | `--key <value>` に choices                                                  |
| array（string / enum）      | 単数形で繰り返す（`--label a --label b`）。カンマ区切りも受ける             |
| nullable                    | `none` で外す（`--epic none`）                                              |
| record（`fields`）          | `--field key=value` の繰り返し。true / false / 数値は変換する               |
| array of object（`drafts`） | 位置引数 `<file>`（YAML / JSON。`-` で標準入力）から読む（`ticket import`） |

グローバルオプションは `--json`、`-C <dir>`、`--actor <human|agent>`（環境変数 `DEGUBOARD_ACTOR`）、`--actor-id <id>`（`DEGUBOARD_ACTOR_ID`）。`dg serve` / `dg open`（`serve.ts`）は `@deguboard/server` を起動する・ブラウザで開くだけ。

### `packages/server`（`@deguboard/server`）

core の `commands` を HTTP に写す。Node 標準の `node:http` で、フレームワークは入れない（[ADR-008](adr/ADR-008-tech-stack.md)）。`dg serve` が起動し、既定で `127.0.0.1:7474` に閉じる。

| エンドポイント              | 内容                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/commands`         | `needs: "store"` のコマンドの一覧。名前・要約・`positionals`・入力の JSON Schema（`z.toJSONSchema`） |
| `POST /api/commands/<name>` | `{ "input": {...} }` を渡して実行。応答は CLI の `--json` と同じ `{ ok, data, warnings, write }`     |
| `GET /api/status`           | 未 push・未取り込みのコミット数、未コミットの有無、読めないファイルの数（UI-6）                      |
| それ以外                    | `staticDir`（web のビルド結果）があれば静的ファイル。SPA なので見つからないパスは `index.html`       |

- エラーは HTTP の状態に写す：入力の誤り 400、`NOT_FOUND` 404、初期化前 503、それ以外の拒否 409、想定外 500。本文は `{ ok: false, error: { code, message, detail? } }`
- 画面からの操作は常に人（`actor.kind: "human"`。[ADR-006](adr/ADR-006-ui-and-writes.md)）。`init` は HTTP に出さない
- リクエストは 1 つずつ順に処理し、毎回 `Store.rescan()` で CLI など他のプロセスの変更を取り込む。ファイル監視は持たない`guide-*.md` はビルドで `dist/` にコピーする（`package.json` の `build`）。トピックを足すときは `guide.ts` の `GUIDE_TOPICS` と `guide-overview.md` の表も直す。

## 文書を直すとき

- 仕様の約束を変えるときは [requirements.md](requirements.md) の該当の節を書き換える。細部（CLI オプション、画面の文言）は書かず、正本（ヘルプ・コード・テスト）を直す
- 判断を変えるときは該当の [ADR](adr/README.md) を直接書き換え、更新日と一覧を直す。新しい ADR は方針を反転する大きな変更だけ
- `mise run check:docs` が予算（CLAUDE.md 6KB、README 12KB、requirements 40KB、development 15KB、ADR 1 本 8KB）を検査する。超えたら細部を正本へ移す

## リリース

Phase 1 の最初の版を出すときに書く。
