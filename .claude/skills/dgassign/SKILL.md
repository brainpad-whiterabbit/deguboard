---
name: dgassign
description: Assigns deguboard tickets to Iterations (sprints) and Epics. When an Iteration is given, decides whether to put each unassigned todo into it. When none is given, proposes an Iteration or Epic that fits (creating one if needed). Puts items that should be handled soon into the active Iteration. Use when asked「スプリントに入れて」「Epic にまとめて」「割り振って」.
argument-hint: "[Iteration|Epic|ticket ID...]"
---

<!-- dg skill sha256:bd842be94a52753f7f03fda74afc3f2d410cd4710bdcafe64518109b719dfac3 -->

# Assignment (assign)

チケットを Iteration（スプリント）と Epic に割り当てます。

最初に `dg guide assign` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
