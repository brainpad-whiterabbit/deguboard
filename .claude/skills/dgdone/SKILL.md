---
name: dgdone
description: deguboard のマージ済みのチケットを照合して done を確かめ、残った受け入れ条件を確かめ、作業ブランチと worktree を片付けて、終わった Plan を閉じる。「t12 を完了にして」「マージしたので片付けて」「Plan を閉じて」と頼まれたときに使う。
argument-hint: "[チケットの ID...|Plan の ID|Iteration]"
---

<!-- dg skill sha256:8a09343d6609425c340a317f23809dac0c46228228e5cf9e9100d1a4e68c7eb3 -->

# 完了（done）

最初に `dg guide done` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内（`CLAUDE.md` など）が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
