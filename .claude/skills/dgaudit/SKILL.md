---
name: dgaudit
description: deguboard の Iteration（か Epic）のチケットがすべて done になった後、リリースの前にリポジトリ全体（文書と実装・テスト・アーキテクチャ・README・依存・設定）を観点ごとにサブエージェントで見直し、指摘を表で示して、承認を得てチケットにする。見直しではファイルを直さない。「リリースの前に見直して」「リポジトリ全体を見直して」と頼まれたときに使う。
argument-hint: "[Iteration|Epic]"
---

<!-- dg skill sha256:9cf942ff3c80d12914fc6c97840587549f41809fa218fb76d2ac71d04e9a47a6 -->

# 見直し（audit）

最初に `dg guide audit` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内（`CLAUDE.md` など）が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
