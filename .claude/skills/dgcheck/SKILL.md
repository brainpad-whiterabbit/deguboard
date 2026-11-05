---
name: dgcheck
description: deguboard のチケット・Epic・Iteration・Plan を点検し、dg sync・validate・lint の指摘と直す案を表で示して、承認を得てから直す。「チケットを点検して」「整合性を確認して」「Iteration を見直して」と頼まれたときや、計画を立てる前に使う。
argument-hint: "[Iteration|Epic|チケットの ID...]"
---

<!-- dg skill sha256:874f7257ea1cd5c9e0b71658d0a0582a61db703688785da56159f6d3e9f3baef -->

# 点検（check）

最初に `dg guide check` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
