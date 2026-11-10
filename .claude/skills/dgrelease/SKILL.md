---
name: dgrelease
description: Checks that every ticket of a deguboard Iteration is done, proceeds by the repository's release steps, and closes the Iteration with approval. Asks for approval before merging the release PR and publishing. Use when asked「s3 をリリースして」「リリースを進めて」.
argument-hint: "[Iteration]"
---

<!-- dg skill sha256:58957734909a514faede8d31bef42c67cdc0fb6723475fc5fe09a731759eab45 -->

# Release (release)

Iteration のチケットがすべて done かを確かめ、リリースの手順で進めて Iteration を閉じます。

最初に `dg guide release` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
