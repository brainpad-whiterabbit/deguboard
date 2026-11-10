---
name: dgplan
description: Decides the order in which to advance deguboard tickets, records it in a Plan, and gets human approval. Use when asked「t12 を進めて」「s3 を全部進めて」「次の 3 件を進めて」「計画だけ立てて」, or to approve a Plan that is awaiting approval. Also use when asked only for the order, such as「次にやるチケットは？」 (shows the order and stops). Advance an approved Plan with dgwork.
argument-hint: <ticket ID...|Iteration|Epic|next [N]> | <Plan ID>
---

<!-- dg skill sha256:8154090e41ffa90a7de1998a34435af6984002bbcc40857c1aad21163cb5263e -->

# Plan (plan)

チケットを進める順を決めて Plan に記録し、人の承認を得ます。

最初に `dg guide plan` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
