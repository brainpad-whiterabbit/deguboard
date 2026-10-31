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

## ブランチと worktree

`dg` でこのリポジトリのチケットを管理できるようになるまでの、1 つの変更を `main` に入れる手順。規約（squash マージ、ブランチを消す）は [CLAUDE.md](../CLAUDE.md#ブランチprマージ) にある。`dg` でこのリポジトリのチケットを管理できるようになったら、この節を `dg` を使う手順に書き替え、ここの手順は消す（古い手順を残さない）。

worktree は `../deguboard.worktrees/<ブランチ名>` に置く。`dg` の `worktree.root` の既定（[requirements.md](requirements.md)）と同じ場所で、リポジトリの外なので `.gitignore` は要らない。ブランチ名は `<種類>/<内容>`（例：`docs/branch-strategy`、`feat/ticket-create`、`fix/sync-warning`）。

1. `main` の worktree で、`origin/main` から作業ブランチと worktree を作る

   ```sh
   git fetch origin
   git worktree add --no-track -b <ブランチ名> ../deguboard.worktrees/<ブランチ名> origin/main
   ```

2. worktree に移って環境を用意する。`mise trust` と `node_modules` は worktree ごとに要る

   ```sh
   cd ../deguboard.worktrees/<ブランチ名>
   mise trust && mise run install
   ```

3. 実装し、`mise run format` と `mise run check` を通してコミットし、push して PR を出す

   ```sh
   git push -u origin <ブランチ名>
   gh pr create --base main
   ```

4. レビューの指摘は同じ worktree で直して push する。`mise run check` を通してから push し、承認されたらマージする。worktree は先に消す（ブランチを checkout したままだと `gh` がローカルのブランチを消せない）

   ```sh
   cd <main の worktree>            # リポジトリ本体
   git worktree remove ../deguboard.worktrees/<ブランチ名>
   gh pr merge <PR 番号> --squash --delete-branch
   git pull --ff-only
   ```

   `--delete-branch` がリモートとローカルのブランチを消す。worktree に未コミットの変更が残っていて `git worktree remove` が止まったら、要るものを退避してから `--force` を付ける。

## ビルドとテスト

- TypeScript は ESM（`"type": "module"`）で、相対 import は `.js` の拡張子で書く。設定はルートの `tsconfig.base.json` と `tsconfig.json` にあり、`mise run typecheck` は `packages/*/src` と `packages/*/test` をまとめて `noEmit` で検査する。配布用のビルド（dist）はまだなく、CLI パッケージを作るときに足す
- テストはソースの隣の `*.test.ts` に置き、ルートの `vitest.config.ts` が `packages/*/src/**/*.test.ts` をまとめて走らせる。パッケージごとの設定ファイルは作らない
- Git を使うテストは `packages/core/test/helpers/git-fixture.ts` で、一時ディレクトリに bare リモートと 2 つの clone を作って行う（CLAUDE.md の規約）。開発者のグローバル設定に影響されないよう、fixture が `GIT_CONFIG_GLOBAL=/dev/null` と `GIT_CONFIG_NOSYSTEM=1` を与える
- 依存を足すときは `pnpm install` で lockfile を更新してからコミットする（`mise run install` は `--frozen-lockfile`）

## パッケージ

構成と依存の向きは [ADR-007](adr/ADR-007-architecture.md)。今あるのは `core` だけで、`cli`・`server`・`web`・`vscode` はこれから作る。

### `packages/core`（`@deguboard/core`）

ドメインモデル・ストレージ・Git 操作・ワークフロー・コマンド定義。VS Code API・HTTP・React に依存しない。`src/` のモジュール：

| モジュール  | 役割                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `model/`    | Zod のスキーマ（config・Project・Ticket・Epic・Iteration・Plan・Workflow）、ID の解析と採番、Status と前進の順                            |
| `storage/`  | frontmatter と YAML の読み書き（コメントとキー順を保つ）、原子的書き込み、`Store`（起動時に走査してメモリ上に索引を作る）、参照の整合     |
| `workflow/` | 遷移表の正本、条件の評価、`reconcile` の評価、定義の検証、同梱テンプレート                                                                |
| `git/`      | `execFile` で git・gh を呼ぶ、deguboard worktree の用意、取り込みと push、書き込みの 1 単位 `withWrite`（CAS と provisional）、事実の収集 |
| `commands/` | 3 つの入口の正本。`defineCommand` で「名前・Zod の入力・実装」を組にし、`openContext` と `runCommand` で呼ぶ                              |

入口がコマンドを呼ぶ流れ：`openContext({ cwd, actor })` → `runCommand(findCommand("ticket.create"), ctx, input)`。入力の形の誤りは `UsageError`（終了コード 2）、実行時の失敗は `OperationError`（終了コード 1、`code` に種類）。

## 文書を直すとき

- 仕様の約束を変えるときは [requirements.md](requirements.md) の該当の節を書き換える。細部（CLI オプション、画面の文言）は書かず、正本（ヘルプ・コード・テスト）を直す
- 判断を変えるときは該当の [ADR](adr/README.md) を直接書き換え、更新日と一覧を直す。新しい ADR は方針を反転する大きな変更だけ
- `mise run check:docs` が予算（CLAUDE.md 6KB、README 12KB、requirements 40KB、development 15KB、ADR 1 本 8KB）を検査する。超えたら細部を正本へ移す

## リリース

Phase 1 の最初の版を出すときに書く。
