# ADR-008 技術構成と開発環境

- ステータス：承認
- 更新日：2026-11-06

## 背景

[ADR-007](ADR-007-architecture.md) の構成を何で作るか、開発環境をどう揃えるかを決める。AI エージェントが主に実装するので、ツールの入口が 1 つで、速く、設定が少ないことを重視する。

## 決定

### 言語とランタイム

- TypeScript、Node.js 24、pnpm workspace
- 型検査と core・server・cli のビルドは TypeScript 7（Go で書かれたネイティブ版の tsc）で行う。tsc の JS API には依存しない（lint は oxlint、変換は Vite と Vitest の oxc なので、typescript を import するツールは無い）
- スキーマと検証は Zod。CLI は commander。UI は React（Vite でビルド）。テストは Vitest
- HTTP サーバーは Node 標準の `node:http` で書き、フレームワークを入れない。要るのはコマンドの呼び出しと静的ファイルの配信だけなので、小さなルータで足りる（エンドポイントは `packages/server/src/app.ts`）
- git と gh は `child_process.execFile` で引数配列として呼ぶ。シェルを経由しない
- MCP は公式の `@modelcontextprotocol/sdk` の低水準の `Server` と stdio の transport を使い、検証は core の `runCommand` に任せる（高水準の `McpServer` は Zod のスキーマを自分で変換・検証するので、二重になる）。ツールの一覧の作り方は `packages/cli/src/mcp.ts` の冒頭
- DB は使わない（ADR-007）

### ツールと作業コマンドは mise に統一する

- `mise.toml` で node と pnpm の版を固定する。開発者は `mise install` でツールを揃える
- 作業のコマンドは `mise run <task>` を唯一の入口にする。タスクの一覧は mise.toml が正本（`mise tasks`）
- タスクは pnpm scripts を呼ぶだけにし、同じ内容を 2 か所に書かない。pnpm scripts は mise から呼ばれる前提で、人は `mise run` だけ覚える
- 依存の追加・更新・削除は、pnpm の選択肢をそのまま使えるようタスクにせず、mise の固定した pnpm で行い、lockfile をコミットする。版は固定する（コマンドと `savePrefix` は [development.md の「ビルドとテスト」](../development.md#ビルドとテスト)）
- `check` はコミット前の確認で、書式・lint・型・テスト・文書を検査する（順は mise.toml）
- CI は使わない。検査は作業者がローカルで `mise run check` を通すことにとどめ、マージの条件にする

### lint は oxlint、整形は oxfmt

- lint は oxlint（`.oxlintrc.json`）。既定の `correctness` から始め、規則は必要になったときに足す（plugin の選び方と規則の外し方は [development.md の「ビルドとテスト」](../development.md#ビルドとテスト)）
- 整形は oxfmt（`.oxfmtrc.json`）。既定の設定から始める
- ESLint・Prettier・Biome は入れない
- 版は package.json に固定する
- ※ ADR-024 で置き換え（この項は失効）。oxlint は、新しい版で増えた React Compiler 系の規則（`react(immutability)`）が web の既存コードで失敗するので上げずに留める。直す作業を起こしてから上げる

### 画面（web）は依存を少なく

- React 19 を Vite でビルドし、相対パスで出して `dg serve` でも VS Code の Webview でも読めるようにする（`packages/web/vite.config.ts`）
- CSS は自前で、VS Code の `--vscode-*` 変数を基準にする（Webview の外での既定値は `styles.css` の冒頭）
- ドラッグ＆ドロップは置かない（[ADR-027](ADR-027-screen-vscode-writes-and-asks.md)）。画面の切り替えは URL のハッシュで自前。状態管理のライブラリは入れず、React の context だけで持つ
- 更新は書き込み後の読み直しとポーリング（VS Code では拡張ホストのファイルの見張り。`packages/vscode/src/watch.ts`）。WebSocket と SSE は入れない
- テストは Vitest + Testing Library + jsdom で、`CommandClient` を差し替えて画面を結合して確かめる

### VS Code 拡張は Vite で 1 つの CommonJS に束ねる

- 拡張ホストは CommonJS を読むので、`packages/vscode` は Vite の SSR ビルドで 1 ファイルに束ねる（`packages/vscode/vite.config.ts`）。拡張のためのバンドラは増やさない（esbuild や webpack は入れない）
- 拡張の `engines.vscode` は拡張ホストが Node 24 になった版からにし、束ねる core の Node 24 に揃える（版の理由は [development.md の「ビルドとテスト」](../development.md#ビルドとテスト)）
- VSIX は `@vscode/vsce` で作る（`mise run vsix`）
- 実機の確認（`mise run test:vscode`）は `@vscode/test-electron` で VS Code 本体を落とすだけに使い、起動と操作は Playwright の `_electron` で行う。VS Code の版は固定する。`check` には入れない（ダウンロードと画面が要る。細部は `test/vscode/host.ts` の冒頭）

### 文書の検査

- `scripts/check-docs.mjs` が文書を検査する。検査する範囲は [ADR-001](ADR-001-doc-strategy.md#重複と参照の検査) のとおり。`mise run check` に含める

## 理由

- 入口が `mise run` の 1 つなら、エージェントも人も CLAUDE.md の 1 行で使い方がわかる。ツールの版が固定されるので、マシンごとの差で壊れない
- oxlint と oxfmt は同じツールチェーン（oxc）で、ESLint と Prettier より桁違いに速く、設定がほとんど要らない。エージェントが毎回の変更で `check` を回すので、速さがそのまま開発速度になる
- TypeScript 7 は 5.9 に比べて型検査が約 4 倍速い（このリポジトリで 11.8 秒から 2.7 秒）。emit の JS は同じで、.d.ts は union の並びが安定するだけで 5.x でも読める。7.0 には JS API と言語サーバのプラグインが無いが、どちらも使っていない
- Zod は型とスキーマを 1 か所に書け、`core/commands` の入力スキーマから CLI のヘルプと HTTP の検証を生成できる
- `execFile` で引数配列として呼べば、ブランチ名やタイトルにシェルの特殊文字が入っても安全
- HTTP にフレームワークを入れないのは、エンドポイントが core のコマンド定義から機械的に決まり、ルーティングの表現力が要らないため。依存が減り、`127.0.0.1` に閉じるローカルの用途に合う
- Vitest は TypeScript と ESM をそのまま扱え、workspace のパッケージをまとめて走らせられる
- CI を置かないのは、実装するのが主にエージェントで、変更のたびにローカルで `check` を回すから。同じ検査を CI でもう一度回しても得るものが少なく、ワークフローの保守が増える

## 採らなかった案

- **TypeScript 5.9 や 6.0 に留める**：型検査が遅く、残る JS API はこのリポジトリで使わない
- **ESLint + Prettier**：設定と plugin が多く、遅い
- **Biome**：oxc の方が速く、Prettier との互換が高い
- **npm scripts を直接使う**：ツールの版が揃わず、入口が `npm run` と `mise` の 2 つになる
- **Hono や Fastify**：エンドポイントが 3 つの用途では依存が増えるだけ
- **Turborepo や Nx**：パッケージが 5 つで、pnpm workspace の `-r` で足りる
- **Tailwind**：Webview のテーマは CSS 変数で渡るので、変数を直接使う自前の CSS の方が短い
- **react-router**：Webview では遷移できず、画面が少ないのでハッシュの解析で足りる
- **Redux や Zustand**：状態が少なく、書き込みのたびに読み直す方が CLI との整合が取りやすい
- **Node 22（LTS）**：VS Code の拡張ホストの Node 24 と揃える
- **拡張を esbuild や webpack で束ねる**：web のビルドに使っている Vite で足りる
