---
name: dgdone
description: deguboard のマージ済みのチケットを照合して done を確かめ、残った受け入れ条件を確かめ、作業ブランチと worktree を片付けて、終わった Plan を閉じる。「t12 を完了にして」「マージしたので片付けて」「Plan を閉じて」と頼まれたときに使う。
argument-hint: "[チケットの ID...|Plan の ID|Iteration]"
---

<!-- dg skill sha256:56576392cb939a72b5c4da518674d0046edf7539bc92bee18236469dc8ff0539 -->

# 完了（done）

マージ済みのチケットを照合して done を確かめ、受け入れ条件を確かめて後片付けをします。

最初に `dg guide done` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
