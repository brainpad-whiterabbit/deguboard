---
name: dgall
description: deguboard の Iteration かチケットを、割り当て → 点検 → 計画 → 作業 → 見直し → リリース（か片付け）の段階で続けて進める。作りたいものを文で渡されたときは、先に起票してから進める。承認の場所は各段階の手順のとおりに残し、段階の間は止まらずに進む。途中で止まった流れは、同じ引数で再開できる。--no-assign で割り当ての段階を飛ばす。--auto で、勧める選択肢がある戻せる判断を自動で選ぶ。「s3 を最後まで進めて」「割り当てからリリースまでやって」「CSV 出力を作って最後まで進めて」と頼まれたときに使う。
argument-hint: <Iteration|チケットの ID...|作りたいものの文> [--no-assign] [--auto]
---

<!-- dg skill sha256:4f3f57dbccdbe4672460af8cd688f2b0756ec73d6f77edd08ea694f8a1b42dd9 -->

# 一気通し（all）

Iteration かチケットを、割り当てからリリース（か片付け）まで段階ごとに続けて進めます。

最初に `dg guide all` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
