# ADR-008 技術構成と開発環境

- ステータス：承認
- 更新日：2026-10-31

## 背景

[ADR-007](ADR-007-architecture.md) の構成を何で作るか、開発環境をどう揃えるかを決める。AI エージェントが主に実装するので、ツールの入口が 1 つで、速く、設定が少ないことを重視する。

## 決定

### 言語とランタイム

- TypeScript、Node.js 24、pnpm workspace
- スキーマと検証は Zod。CLI は commander。UI は React（Vite でビルド）。テストは Vitest
- HTTP サーバーのフレームワークは Phase 1 の server チケットで決める（依存の少ない軽量なもの）
- git と gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- DB は使わない（ADR-007）

### ツールと作業コマンドは mise に統一する

- `mise.toml` で node と pnpm の版を固定する。開発者は `mise install` でツールを揃える
- 作業のコマンドは `mise run <task>` を唯一の入口にする。タスクは `install`・`format`・`format:check`・`lint`・`typecheck`・`test`・`check:docs`・`check`
- タスクは pnpm scripts を呼ぶだけにし、同じ内容を 2 か所に書かない。pnpm scripts は mise から呼ばれる前提で、人は `mise run` だけ覚える
- `check` はコミット前の確認で、format:check → lint → typecheck → test → check:docs を順に実行する
- CI は使わない。検査は作業者がローカルで `mise run check` を通すことにとどめ、マージの条件にする

### lint は oxlint、整形は oxfmt

- lint は oxlint（`.oxlintrc.json`）。既定の `correctness` から始め、規則は必要になったときに足す
- 整形は oxfmt（`.oxfmtrc.json`）。既定の設定から始める
- ESLint・Prettier・Biome は入れない
- 版は package.json に固定する

### 文書の検査

- `scripts/check-docs.mjs` が文書の予算と ADR 一覧の整合を検査する（[ADR-001](ADR-001-doc-strategy.md)）。`mise run check` に含める

## 理由

- 入口が `mise run` の 1 つなら、エージェントも人も CLAUDE.md の 1 行で使い方がわかる。ツールの版が固定されるので、マシンごとの差で壊れない
- oxlint と oxfmt は同じツールチェーン（oxc）で、ESLint と Prettier より桁違いに速く、設定がほとんど要らない。エージェントが毎回の変更で `check` を回すので、速さがそのまま開発速度になる
- Zod は型とスキーマを 1 か所に書け、`core/commands` の入力スキーマから CLI のヘルプと HTTP の検証を生成できる
- `execFile` で引数配列として呼べば、ブランチ名やタイトルにシェルの特殊文字が入っても安全
- Vitest は TypeScript と ESM をそのまま扱え、workspace のパッケージをまとめて走らせられる
- CI を置かないのは、実装するのが主にエージェントで、変更のたびにローカルで `check` を回すから。同じ検査を CI でもう一度回しても得るものが少なく、ワークフローの保守が増える

## 採らなかった案

- **ESLint + Prettier**：設定と plugin が多く、遅い。型つきの規則も oxlint で足りる範囲から始める
- **Biome**：lint と format を 1 つにできるが、oxc の方が速く、Prettier との互換が高い
- **npm scripts を直接使う**：ツールの版が揃わず、入口が `npm run` と `mise` の 2 つになる
- **Turborepo や Nx**：パッケージが 5 つで、pnpm workspace の `-r` で足りる
- **Node 22（LTS）**：VS Code の拡張ホストと揃える意味で 24 にする。Phase 1 の vscode チケットで拡張ホストの版を確かめ、ずれていればこの節を直す
