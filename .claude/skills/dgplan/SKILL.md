---
name: dgplan
description: deguboard のチケットを進める順を決めて Plan に記録し、人の承認を得る。「t12 を進めて」「s3 を全部進めて」「次の 3 件を進めて」「計画だけ立てて」と頼まれたときや、承認待ちの Plan を承認するときに使う。「次にやるチケットは？」と順だけを聞かれたときも使う（順を示して止める）。承認した Plan は dgwork で進める。
argument-hint: <チケットの ID...|Iteration|Epic|next [N]> | <Plan の ID>
---

<!-- dg skill sha256:37c9928f706601c3162405663ce2944636a27440ab58eca252dd01298cb47168 -->

# 計画（plan）

最初に `dg guide plan` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
