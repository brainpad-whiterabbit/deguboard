# ADR-008 技術構成と開発環境

- ステータス：承認
- 更新日：2026-11-01

## 背景

[ADR-007](ADR-007-architecture.md) の構成を何で作るか、開発環境をどう揃えるかを決める。AI エージェントが主に実装するので、ツールの入口が 1 つで、速く、設定が少ないことを重視する。

## 決定

### 言語とランタイム

- TypeScript、Node.js 24、pnpm workspace
- スキーマと検証は Zod。CLI は commander。UI は React（Vite でビルド）。テストは Vitest
- HTTP サーバーは Node 標準の `node:http` で書き、フレームワークを入れない。要るのは「`POST /api/commands/<名前>` に JSON を渡して結果を返す」「静的ファイルの配信」だけなので、小さなルータで足りる
- git と gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- DB は使わない（ADR-007）

### ツールと作業コマンドは mise に統一する

- `mise.toml` で node と pnpm の版を固定する。開発者は `mise install` でツールを揃える
- 作業のコマンドは `mise run <task>` を唯一の入口にする。タスクの一覧は mise.toml が正本（`mise tasks`）
- タスクは pnpm scripts を呼ぶだけにし、同じ内容を 2 か所に書かない。pnpm scripts は mise から呼ばれる前提で、人は `mise run` だけ覚える
- `check` はコミット前の確認で、format:check → lint → typecheck → test → check:docs を順に実行する
- CI は使わない。検査は作業者がローカルで `mise run check` を通すことにとどめ、マージの条件にする

### lint は oxlint、整形は oxfmt

- lint は oxlint（`.oxlintrc.json`）。既定の `correctness` から始め、規則は必要になったときに足す
- 整形は oxfmt（`.oxfmtrc.json`）。既定の設定から始める
- ESLint・Prettier・Biome は入れない
- 版は package.json に固定する

### 画面（web）は依存を少なく

- React 19 を Vite でビルドし、`base: "./"` で相対パスにして `dg serve` でも VS Code の Webview でも読めるようにする
- CSS は自前で、VS Code の `--vscode-*` 変数を基準にする。ブラウザ向けの既定値は `styles.css` の `:root` に置く
- ドラッグ＆ドロップは `@dnd-kit/core`。画面の切り替えは URL のハッシュで自前。状態管理のライブラリは入れず、React の context だけで持つ
- 更新は書き込み後の読み直しと `GET /api/status` のポーリング。VS Code では拡張ホストがデータのファイルを見張って読み直しを通知する。WebSocket と SSE は入れない
- テストは Vitest + Testing Library + jsdom で、`CommandClient` を差し替えて画面を結合して確かめる

### VS Code 拡張は Vite で 1 つの CommonJS に束ねる

- 拡張ホストは CommonJS を読むので、`packages/vscode` は Vite の SSR ビルドで `dist/extension.cjs` の 1 ファイルに束ねる。core は `development` 条件で `src` から取り込み、`vscode` だけ外部にする
- web のビルド結果は `dist/web` に写して Webview から読む。拡張のためのバンドラは増やさない（esbuild や webpack は入れない）
- VSIX は `@vscode/vsce` で作る（`mise run vsix`）。依存は束ねてあるので `--no-dependencies` で、pnpm の node_modules の形に影響されない。`vsce-sign` の postinstall は要らないので pnpm-workspace.yaml の `allowBuilds` で拒否する（pnpm 12。`ignoredBuiltDependencies` は読まれない）

### 文書の検査

- `scripts/check-docs.mjs` が文書の予算と ADR 一覧の整合を検査する（[ADR-001](ADR-001-doc-strategy.md)）。`mise run check` に含める

## 理由

- 入口が `mise run` の 1 つなら、エージェントも人も CLAUDE.md の 1 行で使い方がわかる。ツールの版が固定されるので、マシンごとの差で壊れない
- oxlint と oxfmt は同じツールチェーン（oxc）で、ESLint と Prettier より桁違いに速く、設定がほとんど要らない。エージェントが毎回の変更で `check` を回すので、速さがそのまま開発速度になる
- Zod は型とスキーマを 1 か所に書け、`core/commands` の入力スキーマから CLI のヘルプと HTTP の検証を生成できる
- `execFile` で引数配列として呼べば、ブランチ名やタイトルにシェルの特殊文字が入っても安全
- HTTP にフレームワークを入れないのは、エンドポイントが core のコマンド定義から機械的に決まり、ルーティングの表現力が要らないため。依存が減り、`127.0.0.1` に閉じるローカルの用途に合う
- Vitest は TypeScript と ESM をそのまま扱え、workspace のパッケージをまとめて走らせられる
- CI を置かないのは、実装するのが主にエージェントで、変更のたびにローカルで `check` を回すから。同じ検査を CI でもう一度回しても得るものが少なく、ワークフローの保守が増える

## 採らなかった案

- **ESLint + Prettier**：設定と plugin が多く、遅い。型つきの規則も oxlint で足りる範囲から始める
- **Biome**：lint と format を 1 つにできるが、oxc の方が速く、Prettier との互換が高い
- **npm scripts を直接使う**：ツールの版が揃わず、入口が `npm run` と `mise` の 2 つになる
- **Hono や Fastify**：ミドルウェアと型つきのルートが使えるが、エンドポイントが 3 つの用途では依存が増えるだけ。MCP や SSE を足すときに要るなら、そのときに入れる
- **Turborepo や Nx**：パッケージが 5 つで、pnpm workspace の `-r` で足りる
- **Tailwind**：Webview のテーマは CSS 変数で渡るので、変数を直接使う自前の CSS の方が短い。ビルドの層も増えない
- **react-router**：Webview では遷移できず、画面が 5 種なのでハッシュの解析で足りる
- **Redux や Zustand**：状態は「選んだ Project の一覧と同期の状態」だけで、書き込みのたびに読み直す方が CLI との整合が取りやすい
- **Node 22（LTS）**：VS Code の拡張ホストと揃える意味で 24 にする。VS Code 1.144（2026-10）の拡張ホスト（リモートの server）は Node 24.22 で、ずれはない
- **拡張を esbuild や webpack で束ねる**：web のビルドに使っている Vite（rolldown）で足りる。ツールが増えるだけ
