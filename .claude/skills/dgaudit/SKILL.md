---
name: dgaudit
description: Once every ticket of a deguboard Iteration (or Epic) is done, and before release, reviews the whole repository by viewpoint with subagents (documents and implementation, tests, architecture, README, dependencies, config files). Shows the findings in a table and, after approval, files them as tickets. The review does not change files. Use when asked「リリースの前に見直して」「リポジトリ全体を見直して」.
argument-hint: "[Iteration|Epic]"
---

<!-- dg skill sha256:8fc740b73da99d0f99aa9e2355833c874f5f11bf443c16b3a91cdb7239fa8b95 -->

# Audit (audit)

Iteration か Epic の完了後、リポジトリ全体を観点ごとに見直し、承認を得た指摘をチケットにします。

最初に `dg guide audit` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
