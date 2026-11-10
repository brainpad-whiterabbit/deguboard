---
name: dgrelease
description: deguboard の Iteration のチケットがすべて done かを確かめ、リポジトリのリリースの手順で進めて、承認を得て Iteration を閉じる。リリースの PR のマージと公開の前に承認を求める。「s3 をリリースして」「リリースを進めて」と頼まれたときに使う。
argument-hint: "[Iteration]"
---

<!-- dg skill sha256:e6ad7285221518409bad9965199ca58c484b8262c6bf9e905d58e46e6252aec4 -->

# リリース（release）

Iteration のチケットがすべて done かを確かめ、リリースの手順で進めて Iteration を閉じます。

最初に `dg guide release` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
