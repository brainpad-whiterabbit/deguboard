---
name: dgassign
description: deguboard のチケットを Iteration（スプリント）と Epic に割り当てる。Iteration を指定すると未割り当ての todo を入れるかどうか判断し、指定がなければ内容に合う Iteration・Epic（新設を含む）を提案する。早めに対応した方がよいものは進行中の Iteration に入れる。「スプリントに入れて」「Epic にまとめて」「割り振って」と頼まれたときに使う。
argument-hint: "[Iteration|Epic|チケットの ID...]"
---

<!-- dg skill sha256:2b5ac0b701018b270e6bd8c9706dd291fd51cb64e45e8e489a965df5ebceb908 -->

# 割り当て（assign）

最初に `dg guide assign` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
