---
name: dgcheck
description: Checks deguboard tickets, Epics, Iterations, and Plans. Shows the findings from dg sync, validate, and lint with fix proposals in a table, and fixes them only after approval. Use when asked「チケットを点検して」「整合性を確認して」「Iteration を見直して」, or before making a plan.
argument-hint: "[Iteration|Epic|ticket ID...]"
---

<!-- dg skill sha256:644fc94e94c20d610c4a19d7be5da15fcf2ee2778a0b6f5d291423469379286c -->

# Check (check)

チケット・Epic・Iteration・Plan を点検し、直す案を示して承認を得てから直します。

最初に `dg guide check` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
