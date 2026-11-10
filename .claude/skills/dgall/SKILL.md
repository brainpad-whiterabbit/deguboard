---
name: dgall
description: Advances a deguboard Iteration or tickets through assignment, check, plan, work, audit, and release (or clean-up), in one flow. Approval stays where each stage's steps put it, and the flow does not stop between stages. A flow that stopped midway can be resumed with the same arguments. --no-assign skips the assignment stage. --auto chooses reversible decisions that come with a suggested option. Use when asked「s3 を最後まで進めて」「割り当てからリリースまでやって」.
argument-hint: <Iteration|ticket ID...> [--no-assign] [--auto]
---

<!-- dg skill sha256:96711f2e28b9cba3eabf5ad8665cd00a8d5c9fa7b863419ef8cdbc1530ba5795 -->

# End to end (all)

Iteration かチケットを、割り当てからリリース（か片付け）まで段階ごとに続けて進めます。

最初に `dg guide all` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
